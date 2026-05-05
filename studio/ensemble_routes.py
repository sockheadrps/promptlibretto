from __future__ import annotations

import asyncio
import json
import uuid
from pathlib import Path
from typing import Any, AsyncGenerator, Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from .config import MULTI_TENANT, USER_ID_COOKIE

from promptlibretto import Engine, OllamaProvider, Registry, RegistryState, load_registry
from ensemble.engine import EnsembleEngine, Participant

router = APIRouter(prefix="/api/ensemble")

_SAFE_CHARS = frozenset(
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_"
)


def _safe_name(s: str) -> str:
    return "".join(c if c in _SAFE_CHARS else "_" for c in s) or "default"


def _stores_dir(user_id: str = "") -> Path:
    base = Path.home() / ".promptlibretto" / "memory_stores"
    d = (base / _safe_name(user_id)) if (MULTI_TENANT and user_id) else base
    d.mkdir(parents=True, exist_ok=True)
    return d


def _get_user_id(request: Request) -> str:
    return request.cookies.get(USER_ID_COOKIE, "")


async def _build_memory(
    *,
    engine: Engine,
    participant_name: str,
    base_url: str,
    chat_path: str,
    payload_shape: str,
    main_model: str,
    overrides: Optional[dict] = None,
    user_id: str = "",
):
    """Construct a per-participant MemoryEngine + return its closeables.

    Returns (memory_engine, cleanup_coros). Returns (None, []) when the
    participant's registry has no memory_rules and no personality_file
    configured — i.e. memory pipeline opts in.

    `overrides` lets the request override registry memory_config keys
    (history_window, top_k, working_notes_*) without rebuilding the registry.
    """
    try:
        from promptlibretto.memory import (
            Classifier,
            MemoryEngine,
            MemoryStore,
            OllamaEmbedder,
            PersonalityLayer,
            Router,
            SystemSummaryLayer,
            WorkingNotesLayer,
        )
    except ImportError:
        return None, []

    reg = engine.registry
    cfg = dict(reg.memory_config or {})
    if overrides:
        for k, v in overrides.items():
            if v is not None and v != "":
                cfg[k] = v

    has_rules  = bool(reg.memory_rules)
    pf_setting = cfg.get("personality_file") or ""
    notes_on   = bool(cfg.get("working_notes_enabled"))
    sysum_on   = bool(cfg.get("system_summary_enabled"))

    classifier_url   = cfg.get("classifier_url")  or base_url
    embed_url        = cfg.get("embed_url")       or classifier_url
    embed_model      = cfg.get("embed_model",     "nomic-embed-text")
    classifier_model = cfg.get("classifier_model", "llama3.2:1b")
    top_k            = int(cfg.get("top_k",    5))
    history_window   = int(cfg.get("history_window", 6))
    notes_every_n    = int(cfg.get("working_notes_every_n_turns", 3))
    notes_max_tokens = int(cfg.get("working_notes_max_tokens", 200))
    notes_about_me   = cfg.get("notes_about_me_prompt") or None
    notes_about_oth  = cfg.get("notes_about_other_prompt") or None
    sysum_every_n    = int(cfg.get("system_summary_every_n_turns", 3))
    sysum_max_tokens = int(cfg.get("system_summary_max_tokens", 300))
    sysum_skip_keys  = list(cfg.get("system_summary_skip_section_keys") or [
        "output_prompt_directions",
        "base_context",
        "personas",
        "sentiment",
        "static_injections",
    ])

    # Per-participant store path: <title>_<participant>.db so two
    # participants using the same registry still get separate stores.
    title = _safe_name(reg.title or "ensemble")
    sd = _stores_dir(user_id)
    store_path = str(sd / f"{title}_{_safe_name(participant_name)}.db")

    # Per-participant personality file: respect config if set (single-tenant only), else default.
    if pf_setting and not MULTI_TENANT:
        pf_path = (
            pf_setting
            if Path(pf_setting).is_absolute()
            else str(sd / pf_setting)
        )
    else:
        pf_path = str(sd / f"{title}_{_safe_name(participant_name)}_personality.json")

    # Working notes file lives next to the personality + store for the same
    # participant — auto path unless overridden.
    notes_setting = cfg.get("working_notes_file") or ""
    if notes_setting and not MULTI_TENANT:
        notes_path = (
            notes_setting
            if Path(notes_setting).is_absolute()
            else str(sd / notes_setting)
        )
    else:
        notes_path = str(sd / f"{title}_{_safe_name(participant_name)}_notes.json")

    embedder = OllamaEmbedder(
        base_url=embed_url, model=embed_model,
        embed_path=cfg.get("embed_path") or "/api/embed",
        payload_shape=cfg.get("embed_payload_shape") or "auto",
    )
    store    = MemoryStore(db_path=store_path, embedder=embedder)
    classifier = Classifier(
        OllamaProvider(
            base_url=classifier_url,
            chat_path=cfg.get("classifier_chat_path") or "/api/chat",
            payload_shape=cfg.get("classifier_payload_shape") or "auto",
        ),
        model=classifier_model,
    )
    mem_router = Router.from_registry_rules(reg.memory_rules)
    personality = PersonalityLayer(pf_path)
    personality.load()

    # Working notes layer — only constructed when the side-call provider
    # is available. The notes use the participant's main model.
    working_notes = None
    system_summary = None
    notes_provider = None
    if notes_on or sysum_on:
        notes_provider = OllamaProvider(
            base_url=base_url,
            chat_path=chat_path,
            payload_shape=payload_shape,
        )
    if notes_on:
        working_notes = WorkingNotesLayer(notes_path)
        working_notes.load()
    if sysum_on:
        sysum_path = str(sd / f"{title}_{_safe_name(participant_name)}_sysum.json")
        system_summary = SystemSummaryLayer(sysum_path)
        system_summary.load()

    # When either side-call layer is on, MemoryEngine needs a notes_provider
    # + notes_model so it can run side-calls.
    side_model = main_model if (notes_on or sysum_on) else None

    mem_engine = MemoryEngine(
        engine=engine,
        store=store,
        classifier=classifier,
        router=mem_router,
        personality=personality,
        top_k=top_k,
        history_window=history_window,
        working_notes=working_notes,
        notes_provider=notes_provider,
        notes_model=side_model,
        notes_every_n_turns=notes_every_n,
        notes_max_tokens=notes_max_tokens,
        notes_about_me_prompt=notes_about_me,
        notes_about_other_prompt=notes_about_oth,
        participant_name=participant_name,
        system_summary=system_summary,
        system_summary_every_n_turns=sysum_every_n,
        system_summary_max_tokens=sysum_max_tokens,
        system_summary_skip_section_keys=sysum_skip_keys,
    )

    async def cleanup() -> None:
        store.close()
        await embedder.aclose()
        if notes_provider is not None:
            await notes_provider.aclose()

    return mem_engine, [cleanup]

# session_id -> Future[str] currently waiting for the human's reply.
# Lives in-process; restart clears it. Fine for single-user studio.
_HUMAN_FUTURES: dict[str, asyncio.Future[str]] = {}
_STEP_FUTURES:  dict[str, asyncio.Future[None]] = {}


class HumanSubmit(BaseModel):
    text: str


class ResetStoreRequest(BaseModel):
    registry: dict[str, Any]
    participant_name: str


def _participant_paths(reg, participant_name: str, user_id: str = "") -> dict[str, str]:
    """Resolve all per-participant memory file paths used at run-time, so
    reset/view operate on the same files the engine reads/writes."""
    cfg = reg.memory_config or {}
    title = _safe_name(reg.title or "ensemble")
    name  = _safe_name(participant_name)
    base  = _stores_dir(user_id)
    pf_setting = cfg.get("personality_file") or ""
    if pf_setting:
        pf = pf_setting if Path(pf_setting).is_absolute() else str(base / pf_setting)
    else:
        pf = str(base / f"{title}_{name}_personality.json")
    notes_setting = cfg.get("working_notes_file") or ""
    if notes_setting:
        notes = notes_setting if Path(notes_setting).is_absolute() else str(base / notes_setting)
    else:
        notes = str(base / f"{title}_{name}_notes.json")
    return {
        "store":       str(base / f"{title}_{name}.db"),
        "personality": pf,
        "notes":       notes,
        "sysum":       str(base / f"{title}_{name}_sysum.json"),
    }


@router.post("/reset_store")
async def reset_store(req: ResetStoreRequest, request: Request) -> dict[str, Any]:
    """Wipe ALL per-participant memory artifacts: turns DB, personality file,
    working-notes file, and system-summary file. Without this the agent
    'remembers' across resets via personality/notes even though turns are gone.
    """
    try:
        from promptlibretto.memory import MemoryStore, OllamaEmbedder
    except ImportError as e:
        raise HTTPException(503, f"memory deps not installed: {e}")
    try:
        engine = load_registry(req.registry)
        cfg = engine.registry.memory_config or {}
        paths = _participant_paths(engine.registry, req.participant_name, _get_user_id(request))

        cleared_turns = 0
        if Path(paths["store"]).exists():
            embed_url   = cfg.get("embed_url") or cfg.get("classifier_url") or "http://localhost:11434"
            embed_model = cfg.get("embed_model", "nomic-embed-text")
            embedder = OllamaEmbedder(
                base_url=embed_url, model=embed_model,
                embed_path=cfg.get("embed_path") or "/api/embed",
                payload_shape=cfg.get("embed_payload_shape") or "auto",
            )
            store    = MemoryStore(db_path=paths["store"], embedder=embedder)
            cleared_turns = store.prune(keep_last=0)
            store.close()
            await embedder.aclose()

        wiped_files = []
        for key in ("personality", "notes", "sysum"):
            p = Path(paths[key])
            if p.exists():
                try:
                    p.unlink()
                    wiped_files.append(key)
                except Exception:
                    pass

        return {
            "ok":            True,
            "cleared_turns": cleared_turns,
            "wiped_files":   wiped_files,
            "paths":         paths,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"reset_store failed: {e}")


class ViewStoreRequest(BaseModel):
    registry: dict[str, Any]
    participant_name: str
    limit: int = 50


@router.post("/view_store")
async def view_store(req: ViewStoreRequest, request: Request) -> dict[str, Any]:
    """Return everything we know about this participant's persistent memory:
    a tail of recorded turns, personality profile, working notes, system
    summary. Used by the 'View memory' button in the ensemble UI."""
    try:
        from promptlibretto.memory import (
            MemoryStore,
            OllamaEmbedder,
            PersonalityLayer,
            SystemSummaryLayer,
            WorkingNotesLayer,
        )
    except ImportError as e:
        raise HTTPException(503, f"memory deps not installed: {e}")
    try:
        engine = load_registry(req.registry)
        cfg = engine.registry.memory_config or {}
        paths = _participant_paths(engine.registry, req.participant_name, _get_user_id(request))

        turns: list[dict[str, Any]] = []
        turn_count = 0
        if Path(paths["store"]).exists():
            embed_url   = cfg.get("embed_url") or cfg.get("classifier_url") or "http://localhost:11434"
            embed_model = cfg.get("embed_model", "nomic-embed-text")
            embedder = OllamaEmbedder(
                base_url=embed_url, model=embed_model,
                embed_path=cfg.get("embed_path") or "/api/embed",
                payload_shape=cfg.get("embed_payload_shape") or "auto",
            )
            store    = MemoryStore(db_path=paths["store"], embedder=embedder)
            turn_count = store.count()
            # Pull the most-recent N across all sessions (oldest-first).
            rows = store._db.execute(
                "SELECT * FROM memory_turns ORDER BY timestamp DESC LIMIT ?",
                (max(1, int(req.limit)),),
            ).fetchall()
            from promptlibretto.memory.store import _row_to_turn
            for row in reversed(rows):
                t = _row_to_turn(row)
                turns.append({
                    "role":       t.role,
                    "text":       t.text,
                    "tags":       t.tags,
                    "timestamp":  t.timestamp,
                    "session_id": t.session_id,
                })
            store.close()
            await embedder.aclose()

        personality = None
        if Path(paths["personality"]).exists():
            layer = PersonalityLayer(paths["personality"])
            profile = layer.load()
            personality = profile.to_dict()

        notes = None
        if Path(paths["notes"]).exists():
            n = WorkingNotesLayer(paths["notes"])
            notes = n.load().to_dict()

        sysum = None
        if Path(paths["sysum"]).exists():
            s = SystemSummaryLayer(paths["sysum"])
            sysum = s.load().to_dict()

        return {
            "ok":           True,
            "paths":        paths,
            "turn_count":   turn_count,
            "turns":        turns,
            "personality":  personality,
            "working_notes": notes,
            "system_summary": sysum,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"view_store failed: {e}")


@router.post("/step/{session_id}")
async def step_continue(session_id: str) -> dict[str, Any]:
    """Resolve a pending step gate so the run advances to the next turn."""
    fut = _STEP_FUTURES.get(session_id)
    if fut is None or fut.done():
        raise HTTPException(404, "no pending step for this session")
    fut.set_result(None)
    return {"ok": True}


@router.post("/submit/{session_id}")
async def submit_human(session_id: str, body: HumanSubmit) -> dict[str, Any]:
    fut = _HUMAN_FUTURES.get(session_id)
    if fut is None or fut.done():
        raise HTTPException(404, "no pending human turn for this session")
    fut.set_result(body.text)
    return {"ok": True}


class ConnectionConfig(BaseModel):
    base_url: str = "http://localhost:11434"
    chat_path: str = "/api/chat"
    payload_shape: str = "auto"


class ParticipantConfig(BaseModel):
    # Optional when human=True — humans don't need a system prompt / engine.
    registry: dict[str, Any] = Field(default_factory=dict)
    model: str = "llama3"
    name: str = "A"
    state: dict[str, Any] = Field(default_factory=dict)
    human: bool = False
    memory_enabled: bool = True
    # Per-participant memory tuning overrides — fall back to registry's
    # memory_config when a key is missing/None. Exposed in the UI for testing.
    memory_overrides: dict[str, Any] = Field(default_factory=dict)
    # Per-participant generation overrides applied server-side before the
    # Engine is constructed. Keys: temperature, top_p, top_k, max_tokens,
    # repeat_penalty, retries.
    generation_overrides: dict[str, Any] = Field(default_factory=dict)


class EnsembleRequest(BaseModel):
    a: ParticipantConfig
    b: ParticipantConfig
    seed: str = ""
    # Cap is intentionally large — humans run open-ended; UI surfaces a Stop
    # button. Models without humans typically use 4–20 turns.
    turns: int = Field(default=8, ge=1, le=10000)
    connection: ConnectionConfig = Field(default_factory=ConnectionConfig)
    # When False, the run pauses after each turn and waits for an explicit
    # /step/{session_id} POST before continuing. Default True = run free.
    auto_run: bool = True


@router.post("/run")
async def run_ensemble(req: EnsembleRequest, request: Request) -> StreamingResponse:
    session_id = str(uuid.uuid4())
    _user_id = _get_user_id(request)

    async def generate() -> AsyncGenerator[str, None]:
        queue: asyncio.Queue[dict] = asyncio.Queue()
        current_speaker: list[Optional[str]] = [None]
        turn_num: list[int] = [0]

        async def on_chunk(name: str, delta: str) -> None:
            if name != current_speaker[0]:
                current_speaker[0] = name
                await queue.put({"type": "turn_start", "speaker": name, "turn": turn_num[0]})
            await queue.put({"type": "chunk", "speaker": name, "text": delta})

        async def on_turn(name: str, text: str, idx: int) -> None:
            await queue.put({"type": "turn_end", "speaker": name, "turn": idx, "text": text})
            turn_num[0] = idx + 1
            current_speaker[0] = None

        async def on_prepare(name: str, idx: int, trace: dict) -> None:
            await queue.put({
                "type":    "prepare_trace",
                "speaker": name,
                "turn":    idx,
                "trace":   trace,
            })

        async def on_step(idx: int) -> None:
            if req.auto_run:
                return
            loop = asyncio.get_running_loop()
            fut: asyncio.Future[None] = loop.create_future()
            _STEP_FUTURES[session_id] = fut
            await queue.put({
                "type":       "awaiting_step",
                "turn":       idx,
                "session_id": session_id,
            })
            try:
                await fut
            finally:
                _STEP_FUTURES.pop(session_id, None)

        async def on_human(name: str, last_input: str, idx: int) -> str:
            loop = asyncio.get_running_loop()
            fut: asyncio.Future[str] = loop.create_future()
            _HUMAN_FUTURES[session_id] = fut
            await queue.put({
                "type":       "awaiting_human",
                "speaker":    name,
                "turn":       idx,
                "last_input": last_input,
                "session_id": session_id,
            })
            try:
                text = await fut
            finally:
                _HUMAN_FUTURES.pop(session_id, None)
            await queue.put({"type": "turn_start", "speaker": name, "turn": idx})
            await queue.put({"type": "chunk", "speaker": name, "text": text})
            return text

        async def _run() -> None:
            cleanups: list = []
            try:
                # Only build engines for non-human participants. Humans don't
                # need a registry — they type their own responses.
                def _apply_gen_overrides(reg_dict: dict, overrides: dict) -> dict:
                    if not overrides:
                        return reg_dict
                    inner = dict(reg_dict.get("registry") or reg_dict)
                    gen = dict(inner.get("generation") or {})
                    for k, v in overrides.items():
                        if v is None or v == "":
                            continue
                        gen[k] = v
                    inner["generation"] = gen
                    return {"registry": inner}

                reg_a = _apply_gen_overrides(req.a.registry, req.a.generation_overrides) if not req.a.human and req.a.registry else None
                reg_b = _apply_gen_overrides(req.b.registry, req.b.generation_overrides) if not req.b.human and req.b.registry else None
                engine_a = load_registry(reg_a) if reg_a else None
                engine_b = load_registry(reg_b) if reg_b else None
                if engine_a is None and not req.a.human:
                    raise ValueError("Participant A registry is required when not human-driven")
                if engine_b is None and not req.b.human:
                    raise ValueError("Participant B registry is required when not human-driven")
                conn = req.connection

                # Build per-participant memory pipelines (None if registry
                # has no memory_rules and no personality_file configured).
                # Memory pipeline only applies to model-driven participants.
                mem_a = None
                mem_b = None
                if req.a.memory_enabled and engine_a is not None:
                    mem_a, ca = await _build_memory(
                        engine=engine_a,
                        participant_name=req.a.name,
                        base_url=conn.base_url,
                        chat_path=conn.chat_path,
                        payload_shape=conn.payload_shape,
                        main_model=req.a.model,
                        overrides=req.a.memory_overrides or None,
                        user_id=_user_id,
                    )
                    cleanups.extend(ca)
                if req.b.memory_enabled and engine_b is not None:
                    mem_b, cb = await _build_memory(
                        engine=engine_b,
                        participant_name=req.b.name,
                        base_url=conn.base_url,
                        chat_path=conn.chat_path,
                        payload_shape=conn.payload_shape,
                        main_model=req.b.model,
                        overrides=req.b.memory_overrides or None,
                        user_id=_user_id,
                    )
                    cleanups.extend(cb)

                pa = Participant(
                    name=req.a.name,
                    engine=engine_a,
                    model=req.a.model,
                    ollama_url=conn.base_url,
                    chat_path=conn.chat_path,
                    payload_shape=conn.payload_shape,
                    state=RegistryState.from_dict(req.a.state) if req.a.state else None,
                    human=req.a.human,
                    memory=mem_a,
                )
                pb = Participant(
                    name=req.b.name,
                    engine=engine_b,
                    model=req.b.model,
                    ollama_url=conn.base_url,
                    chat_path=conn.chat_path,
                    payload_shape=conn.payload_shape,
                    state=RegistryState.from_dict(req.b.state) if req.b.state else None,
                    human=req.b.human,
                    memory=mem_b,
                )

                # Surface which participants have memory active so the UI
                # can label them; one event up-front is enough.
                await queue.put({
                    "type": "memory_status",
                    "a": mem_a is not None,
                    "b": mem_b is not None,
                })

                ensemble = EnsembleEngine(pa, pb, max_turns=req.turns)
                await ensemble.run(
                    seed=req.seed,
                    on_chunk=on_chunk,
                    on_turn=on_turn,
                    on_human=on_human,
                    on_prepare=on_prepare,
                    on_step=on_step,
                )
                await queue.put({"type": "done"})
            except Exception as exc:
                await queue.put({"type": "error", "message": str(exc)})
            finally:
                for c in cleanups:
                    try:
                        await c()
                    except Exception:
                        pass

        task = asyncio.create_task(_run())
        try:
            while True:
                event = await queue.get()
                yield f"data: {json.dumps(event)}\n\n"
                if event["type"] in ("done", "error"):
                    break
            await task
        finally:
            # Clean up any orphaned futures if the client disconnected.
            _HUMAN_FUTURES.pop(session_id, None)
            _STEP_FUTURES.pop(session_id, None)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )

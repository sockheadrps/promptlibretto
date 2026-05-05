"""Memory-aware generate endpoint.

Runs the full MemoryEngine pipeline server-side (embed → retrieve →
classify → router mutate → hydrate → generate → store) and returns the
generation result alongside a memory trace for the Studio inspector.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any, Optional

import asyncio

from fastapi import APIRouter, HTTPException, Request, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field

from .config import MULTI_TENANT, USER_ID_COOKIE

router = APIRouter(prefix="/api/memory")

# ws_session_id -> (embedder, provider) for browser-delegated model calls.
_memory_ws: dict[str, tuple] = {}


@router.websocket("/ws/{ws_session_id}")
async def memory_ws(websocket: WebSocket, ws_session_id: str) -> None:
    """Browser connects here before /generate to delegate all model calls client-side."""
    await websocket.accept()

    try:
        from promptlibretto.memory.ws_embedder import WsEmbedder
        from promptlibretto.memory.ws_provider import WsProvider
    except ImportError:
        await websocket.close(code=1011, reason="memory extra not installed")
        return

    async def send_fn(msg: dict) -> None:
        await websocket.send_json(msg)

    embedder = WsEmbedder(send_fn)
    provider = WsProvider(send_fn)
    _memory_ws[ws_session_id] = (embedder, provider)

    try:
        while True:
            data = await websocket.receive_json()
            t   = data.get("type")
            rid = data.get("id", "")
            if t == "embed_result":
                embedder.resolve(rid, data.get("vectors", []))
            elif t == "embed_error":
                embedder.reject(rid, data.get("error", "unknown"))
            elif t == "chat_chunk":
                provider.receive_chunk(rid, data.get("delta", ""))
            elif t == "chat_done":
                provider.receive_done(rid)
            elif t == "chat_error":
                provider.reject(rid, data.get("error", "unknown"))
    except (WebSocketDisconnect, Exception):
        pass
    finally:
        _memory_ws.pop(ws_session_id, None)

_SAFE_CHARS = frozenset("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_")


def _safe_name(title: str) -> str:
    return "".join(c if c in _SAFE_CHARS else "_" for c in title) or "default"


def _default_store_path(title: str) -> str:
    stores_dir = Path.home() / ".promptlibretto" / "memory_stores"
    stores_dir.mkdir(parents=True, exist_ok=True)
    return str(stores_dir / f"{_safe_name(title)}.db")


def _get_user_id(request: Request) -> str:
    return request.cookies.get(USER_ID_COOKIE, "anonymous")


def _tenant_stores_dir(user_id: str) -> Path:
    d = Path.home() / ".promptlibretto" / "memory_stores" / _safe_name(user_id)
    d.mkdir(parents=True, exist_ok=True)
    return d


def _resolve_store_path(request: Request, title: str, cfg: dict) -> str:
    if MULTI_TENANT:
        return str(_tenant_stores_dir(_get_user_id(request)) / f"{_safe_name(title)}.db")
    return cfg.get("store_path") or _default_store_path(title)


def _resolve_personality_path(request: Request, registry_dict: dict) -> str:
    from promptlibretto import Registry
    inner = dict(registry_dict.get("registry") or registry_dict)
    reg = Registry.from_dict({"registry": inner})
    if MULTI_TENANT:
        d = _tenant_stores_dir(_get_user_id(request))
        return str(d / f"{_safe_name(reg.title)}_personality.json")
    return _personality_path(registry_dict)


class ConnectionConfig(BaseModel):
    base_url: str = "http://localhost:11434"
    chat_path: str = "/api/chat"
    payload_shape: str = "auto"
    model: str = "default"


class MemoryGenerateRequest(BaseModel):
    registry: dict[str, Any]
    state: dict[str, Any] = Field(default_factory=dict)
    user_input: str
    connection: ConnectionConfig = Field(default_factory=ConnectionConfig)
    session_id: Optional[str] = None
    ws_session_id: Optional[str] = None  # links to browser WS for delegated inference
    route: Optional[str] = None
    seed: Optional[int] = None
    generation_overrides: dict[str, Any] = Field(default_factory=dict)
    skip_retrieval: bool = False


class MemoryResetRequest(BaseModel):
    registry: dict[str, Any]


class PersonalityRequest(BaseModel):
    registry: dict[str, Any]


class PersonalitySaveRequest(BaseModel):
    registry: dict[str, Any]
    profile: dict[str, Any]


def _personality_path(registry_dict: dict[str, Any]) -> str:
    from promptlibretto import Registry
    inner = dict(registry_dict.get("registry") or registry_dict)
    reg = Registry.from_dict({"registry": inner})
    cfg = reg.memory_config
    stores_dir = Path.home() / ".promptlibretto" / "memory_stores"
    stores_dir.mkdir(parents=True, exist_ok=True)
    path = cfg.get("personality_file") or ""
    if not path:
        path = str(stores_dir / f"{_safe_name(reg.title)}_personality.json")
    elif not Path(path).is_absolute():
        # bare filename or relative path — anchor to stores dir
        path = str(stores_dir / path)
    return path


@router.post("/personality")
async def personality_load(req: PersonalityRequest, request: Request) -> dict[str, Any]:
    """Return the personality profile for this registry (empty profile if file doesn't exist)."""
    try:
        from promptlibretto.memory import PersonalityLayer
    except ImportError as e:
        raise HTTPException(503, f"memory deps not installed: {e}")
    try:
        path = _resolve_personality_path(request, req.registry)
        layer = PersonalityLayer(path)
        profile = layer.load()
        return {"profile": profile.to_dict(), "path": path}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"personality load failed: {e}")


@router.post("/personality/save")
async def personality_save(req: PersonalitySaveRequest, request: Request) -> dict[str, Any]:
    """Overwrite the personality profile with the provided data."""
    try:
        from promptlibretto.memory import PersonalityLayer, PersonalityProfile
    except ImportError as e:
        raise HTTPException(503, f"memory deps not installed: {e}")
    try:
        path = _resolve_personality_path(request, req.registry)
        layer = PersonalityLayer(path)
        layer._profile = PersonalityProfile.from_dict(req.profile)
        layer.save()
        return {"ok": True, "path": path}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"personality save failed: {e}")


@router.post("/personality/clear")
async def personality_clear(req: PersonalityRequest, request: Request) -> dict[str, Any]:
    """Reset personality to an empty profile (keeps the file, wipes amendments and seed)."""
    try:
        from promptlibretto.memory import PersonalityLayer, PersonalityProfile
    except ImportError as e:
        raise HTTPException(503, f"memory deps not installed: {e}")
    try:
        path = _resolve_personality_path(request, req.registry)
        layer = PersonalityLayer(path)
        layer._profile = PersonalityProfile()
        layer.save()
        return {"ok": True, "path": path}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"personality clear failed: {e}")


@router.post("/reset")
async def memory_reset(req: MemoryResetRequest, request: Request) -> dict[str, Any]:
    """Delete all turns from the store for this registry and return a fresh session id."""
    try:
        from promptlibretto import Registry
        from promptlibretto.memory import MemoryStore, OllamaEmbedder
    except ImportError as e:
        raise HTTPException(503, f"memory deps not installed: {e}")

    try:
        inner = dict(req.registry.get("registry") or req.registry)
        reg = Registry.from_dict({"registry": inner})
        cfg = reg.memory_config
        embed_url   = cfg.get("embed_url") or cfg.get("classifier_url") or "http://localhost:11434"
        embed_model = cfg.get("embed_model", "nomic-embed-text")
        embed_path  = cfg.get("embed_path") or "/api/embed"
        embed_shape = cfg.get("embed_payload_shape") or "auto"
        store_path  = _resolve_store_path(request, reg.title, cfg)

        embedder = OllamaEmbedder(
            base_url=embed_url, model=embed_model,
            embed_path=embed_path, payload_shape=embed_shape,
        )
        store    = MemoryStore(db_path=store_path, embedder=embedder)
        store.prune(keep_last=0)
        store.close()
        await embedder.aclose()
        return {"ok": True}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"memory reset failed: {e}")


@router.post("/generate")
async def memory_generate(req: MemoryGenerateRequest, request: Request) -> dict[str, Any]:
    try:
        from promptlibretto import Engine, OllamaProvider, Registry, RegistryState
        from promptlibretto.memory import (
            Classifier,
            MemoryEngine,
            MemoryStore,
            OllamaEmbedder,
            PersonalityLayer,
            Router,
        )
    except ImportError as e:
        raise HTTPException(503, f"memory deps not installed: {e}")

    try:
        # Inject connection model into registry generation config so Engine uses it.
        reg_raw = dict(req.registry)
        inner = dict(reg_raw.get("registry") or reg_raw)
        gen = dict(inner.get("generation") or {})
        if req.connection.model and req.connection.model != "default":
            gen["model"] = req.connection.model
        for k, v in (req.generation_overrides or {}).items():
            if v is None:
                continue
            gen[k] = v
        inner["generation"] = gen
        reg_raw = {"registry": inner}

        reg = Registry.from_dict(reg_raw)
        cfg = reg.memory_config

        classifier_url  = cfg.get("classifier_url")  or "http://localhost:11434"
        embed_url       = cfg.get("embed_url")       or classifier_url
        embed_model     = cfg.get("embed_model",     "nomic-embed-text")
        classifier_model = cfg.get("classifier_model", "llama3.2:1b")
        # Allow OpenAI-compatible classifiers (llama.cpp, LM Studio) by
        # honoring an explicit chat_path; default to Ollama's /api/chat.
        classifier_chat_path    = cfg.get("classifier_chat_path") or "/api/chat"
        classifier_payload_shape = cfg.get("classifier_payload_shape") or "auto"
        top_k           = 0 if (req.skip_retrieval or not req.user_input.strip()) else int(cfg.get("top_k", 5))
        use_classifier  = bool(cfg.get("use_classifier", True))
        history_window  = int(cfg.get("history_window", 6))
        prune_keep      = int(cfg.get("prune_keep", 200))
        store_path      = _resolve_store_path(request, reg.title, cfg)

        _ws = _memory_ws.get(req.ws_session_id or "", (None, None))
        ws_embedder, ws_provider = _ws[0], _ws[1]

        main_provider = ws_provider if ws_provider is not None else OllamaProvider(
            base_url=req.connection.base_url,
            chat_path=req.connection.chat_path,
            payload_shape=req.connection.payload_shape,
        )
        classifier_provider = ws_provider if ws_provider is not None else OllamaProvider(
            base_url=classifier_url,
            chat_path=classifier_chat_path,
            payload_shape=classifier_payload_shape,
        )

        # Always resolve a personality path the same way the save/load endpoints
        # do, so a saved personality is automatically picked up even when
        # memory_config.personality_file is omitted from the registry.
        pf_path = _resolve_personality_path(request, reg_raw)
        personality = PersonalityLayer(pf_path)
        personality.load()

        embed_path  = cfg.get("embed_path") or "/api/embed"
        embed_shape = cfg.get("embed_payload_shape") or "auto"
        embedder = ws_embedder if ws_embedder is not None else OllamaEmbedder(
            base_url=embed_url, model=embed_model,
            embed_path=embed_path, payload_shape=embed_shape,
        )
        store      = MemoryStore(db_path=store_path, embedder=embedder)
        classifier = Classifier(classifier_provider, model=classifier_model)
        mem_router = Router.from_registry_rules(reg.memory_rules)
        engine     = Engine(reg, provider=main_provider)

        mem_engine = MemoryEngine(
            engine=engine,
            store=store,
            classifier=classifier,
            router=mem_router,
            personality=personality,
            session_id=req.session_id,
            top_k=top_k,
            history_window=history_window,
            use_classifier=use_classifier,
        )

        state  = RegistryState.from_dict(req.state)
        result = await mem_engine.run(
            req.user_input,
            base_state=state,
            route=req.route,
            seed=req.seed,
        )

        if store.count() > prune_keep:
            store.prune(keep_last=prune_keep)

        session_id = mem_engine.session_id
        store.close()
        if ws_embedder is None:
            await embedder.aclose()

        actual_model = gen.get("model") or "default"

        return {
            "text":             result.text,
            "accepted":         result.accepted,
            "prompt":           result.prompt,
            "model":            actual_model,
            "session_id":       session_id,
            "retrieved_chunks": [
                {
                    "text":      c.turn.text[:200],
                    "role":      c.turn.role,
                    "score":     round(c.score, 4),
                    "tags":      c.turn.tags,
                    "timestamp": c.turn.timestamp,
                }
                for c in result.retrieved_chunks
            ],
            "extracted_tags":    result.extracted_tags,
            "applied_rules":     result.applied_rules,
            "timing":            result.timing,
            "usage":             result.usage,
            "classifier_stats":  result.classifier_stats,
        }

    except HTTPException:
        raise
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(500, f"memory generate failed: {e}")

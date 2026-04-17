"""FastAPI server exposing the prompt engine for browser-based testing.

Routes are intentionally small wrappers over engine + state mutations so the
GUI is easy to wire and the engine remains the single source of truth.
"""
from __future__ import annotations

import os
from contextlib import asynccontextmanager
from dataclasses import asdict
from pathlib import Path
from typing import Any, Optional

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from prompt_engine import (
    ContextOverlay,
    ContextStore,
    GenerationConfig,
    MockProvider,
    OllamaProvider,
    OutputProcessor,
    PromptEngine,
    RecentOutputMemory,
    RunHistory,
    make_turn_overlay,
)
from prompt_engine.builders.builder import GenerationRequest as EngineRequest

from .base_library import BaseLibrary
from .middleware import LatencyLogger
from .presets import build_asset_registry, build_router
from .scenario_library import ScenarioLibrary


OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:8080")
OLLAMA_CHAT_PATH = os.environ.get("OLLAMA_CHAT_PATH", "/api/chat")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "Qwen3.5-9B-Q4_K_M")
USE_MOCK = os.environ.get("PROMPT_ENGINE_MOCK", "").lower() in ("1", "true", "yes")


def _build_engine() -> tuple[PromptEngine, LatencyLogger]:
    config = GenerationConfig(
        provider="mock" if USE_MOCK else "ollama",
        model=OLLAMA_MODEL,
        temperature=0.7,
        top_p=0.95,
        max_tokens=400,
        retries=1,
        timeout_ms=120_000,
    )
    context_store = ContextStore(
        base="The assistant is operating in a generic prompt-engine demo environment.",
    )
    assets = build_asset_registry()
    router = build_router(assets)
    provider = (
        MockProvider()
        if USE_MOCK
        else OllamaProvider(base_url=OLLAMA_URL, chat_path=OLLAMA_CHAT_PATH)
    )
    latency = LatencyLogger(capacity=50)
    engine = PromptEngine(
        config=config,
        context_store=context_store,
        asset_registry=assets,
        router=router,
        provider=provider,
        output_processor=OutputProcessor(),
        recent_memory=RecentOutputMemory(capacity=12),
        run_history=RunHistory(capacity=24),
        middlewares=[latency],
    )
    return engine, latency


_LIBRARY_PATH = Path(__file__).parent / "base_library.json"
_SCENARIO_PATH = Path(__file__).parent / "scenario_library.json"


@asynccontextmanager
async def lifespan(app: FastAPI):
    engine, latency = _build_engine()
    app.state.engine = engine
    app.state.latency = latency
    app.state.base_library = BaseLibrary(_LIBRARY_PATH)
    app.state.scenario_library = ScenarioLibrary(_SCENARIO_PATH)
    try:
        yield
    finally:
        provider = engine.provider
        if isinstance(provider, OllamaProvider):
            await provider.aclose()


app = FastAPI(title="Prompt Engine", lifespan=lifespan)


# ----------------------------------------------------------------------
# request / response models
# ----------------------------------------------------------------------

class GenerateRequest(BaseModel):
    mode: Optional[str] = None
    inputs: dict[str, Any] = Field(default_factory=dict)
    injections: list[str] = Field(default_factory=list)
    debug: bool = True
    config_overrides: dict[str, Any] = Field(default_factory=dict)


class OverlayBody(BaseModel):
    text: str
    priority: int = 0
    expires_at: Optional[float] = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class BaseContextBody(BaseModel):
    base: str
    fields: dict[str, Any] = Field(default_factory=dict)


class ConfigBody(BaseModel):
    provider: Optional[str] = None
    model: Optional[str] = None
    temperature: Optional[float] = None
    top_p: Optional[float] = None
    top_k: Optional[int] = None
    max_tokens: Optional[int] = None
    repeat_penalty: Optional[float] = None
    timeout_ms: Optional[int] = None
    retries: Optional[int] = None
    lock_params: Optional[bool] = None
    max_prompt_chars: Optional[int] = None


# ----------------------------------------------------------------------
# helpers
# ----------------------------------------------------------------------

def _engine() -> PromptEngine:
    engine = getattr(app.state, "engine", None)
    if engine is None:
        raise HTTPException(status_code=503, detail="engine not initialised")
    return engine


def _library() -> BaseLibrary:
    lib = getattr(app.state, "base_library", None)
    if lib is None:
        raise HTTPException(status_code=503, detail="library not initialised")
    return lib


def _scenarios() -> ScenarioLibrary:
    lib = getattr(app.state, "scenario_library", None)
    if lib is None:
        raise HTTPException(status_code=503, detail="scenario library not initialised")
    return lib


class SaveBaseBody(BaseModel):
    text: str


class SaveScenarioBody(BaseModel):
    state: dict[str, Any]


# ----------------------------------------------------------------------
# routes
# ----------------------------------------------------------------------

@app.get("/api/state")
def get_state():
    eng = _engine()
    snap = eng.context_store.get_state()
    return {
        "config": eng.config.to_dict(),
        "ollama": {"url": OLLAMA_URL, "model": OLLAMA_MODEL, "mock": USE_MOCK},
        "context": {
            "base": snap.base,
            "active": snap.active,
            "fields": snap.fields,
            "overlays": {
                n: {
                    "text": o.text,
                    "priority": o.priority,
                    "expires_at": o.expires_at,
                    "metadata": dict(o.metadata),
                }
                for n, o in snap.overlays.items()
            },
        },
        "routes": [
            {
                "name": r.name,
                "priority": r.priority,
                "description": r.description,
                "generation_overrides": dict(getattr(r.builder, "generation_overrides", {}) or {}),
                "output_policy": dict(getattr(r.builder, "output_policy", {}) or {}),
            }
            for r in eng.router.routes()
        ],
        "assets": eng.asset_registry.list(),
        "injection_details": [
            {
                "name": name,
                "instructions": tmpl.instructions,
                "generation_overrides": dict(tmpl.generation_overrides),
                "output_policy": dict(tmpl.output_policy),
            }
            for name, tmpl in eng.asset_registry.injectors.items()
        ],
        "recent_outputs": eng.recent_memory.items() if eng.recent_memory else [],
        "run_history": [r.to_dict() for r in eng.run_history.items()] if eng.run_history else [],
    }


@app.put("/api/context/base")
def set_base(body: BaseContextBody):
    eng = _engine()
    eng.context_store.set_base(body.base)
    for k, v in body.fields.items():
        eng.context_store.set_field(k, v)
    return {"ok": True}


@app.get("/api/base_library")
def list_bases():
    return {"bases": _library().list()}


@app.put("/api/base_library/{name}")
def save_base_to_library(name: str, body: SaveBaseBody):
    try:
        row = _library().save(name, body.text)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"ok": True, "entry": row}


@app.delete("/api/base_library/{name}")
def delete_base_from_library(name: str):
    ok = _library().delete(name)
    if not ok:
        raise HTTPException(status_code=404, detail=f"no base named {name!r}")
    return {"ok": True}


@app.get("/api/scenarios")
def list_scenarios():
    return {"scenarios": _scenarios().list()}


@app.get("/api/scenarios/{name}")
def get_scenario(name: str):
    row = _scenarios().get(name)
    if row is None:
        raise HTTPException(status_code=404, detail=f"no scenario named {name!r}")
    return row


@app.put("/api/scenarios/{name}")
def save_scenario(name: str, body: SaveScenarioBody):
    try:
        row = _scenarios().save(name, body.state)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"ok": True, "entry": {"name": row["name"], "saved_at": row["saved_at"]}}


@app.delete("/api/scenarios/{name}")
def delete_scenario(name: str):
    ok = _scenarios().delete(name)
    if not ok:
        raise HTTPException(status_code=404, detail=f"no scenario named {name!r}")
    return {"ok": True}


@app.put("/api/context/overlay/{name}")
def set_overlay(name: str, body: OverlayBody):
    eng = _engine()
    eng.context_store.set_overlay(
        name,
        ContextOverlay(
            text=body.text,
            priority=body.priority,
            expires_at=body.expires_at,
            metadata=body.metadata,
        ),
    )
    return {"ok": True}


@app.delete("/api/context/overlay/{name}")
def clear_overlay(name: str):
    _engine().context_store.clear_overlay(name)
    return {"ok": True}


@app.delete("/api/context/overlays")
def clear_overlays():
    _engine().context_store.clear_overlays()
    return {"ok": True}


@app.put("/api/config")
def update_config(body: ConfigBody):
    eng = _engine()
    overrides = {k: v for k, v in body.model_dump(exclude_none=True).items()}
    eng.update_config(eng.config.merged_with(overrides))
    return {"ok": True, "config": eng.config.to_dict()}


class SuggestOverlaysBody(BaseModel):
    count: int = 5
    user_input: str = ""


@app.post("/api/context/base/suggest_overlays")
async def suggest_overlays(body: SuggestOverlaysBody | None = None):
    """Run the suggest_overlays route with the current base context as input.

    Returns a list of overlay suggestions the user can optionally add. The
    engine's output processor validates the JSON shape; we parse it here and
    degrade gracefully if the model produces something unparseable.
    """
    import json as _json

    eng = _engine()
    base = eng.context_store.get_state().base or ""
    if not base.strip():
        raise HTTPException(status_code=400, detail="set a base context first")
    count = max(1, min(int(body.count if body else 5), 20))
    existing = [
        {"name": n, "priority": o.priority, "text": o.text}
        for n, o in eng.context_store.get_state().overlays.items()
    ]
    user_input = (body.user_input if body else "") or ""
    result = await eng.generate_once(
        EngineRequest(
            mode="suggest_overlays",
            inputs={
                "input": base,
                "count": count,
                "existing": existing,
                "user_input": user_input,
            },
            debug=False,
        )
    )
    suggestions: list[dict[str, Any]] = []
    try:
        parsed = _json.loads(result.text)
        if isinstance(parsed, dict) and isinstance(parsed.get("overlays"), list):
            for item in parsed["overlays"]:
                if not isinstance(item, dict):
                    continue
                name = str(item.get("name") or "").strip()
                scenario = str(item.get("scenario") or item.get("text") or "").strip()
                if not name or not scenario:
                    continue
                try:
                    priority = int(item.get("priority", 10))
                except (TypeError, ValueError):
                    priority = 10
                suggestions.append({
                    "name": name,
                    "priority": priority,
                    "scenario": scenario,
                    "placeholder": str(item.get("placeholder") or "").strip(),
                    "rationale": str(item.get("rationale") or "").strip(),
                })
    except _json.JSONDecodeError:
        pass
    return {"suggestions": suggestions, "raw": result.text, "accepted": result.accepted}


@app.get("/api/latency")
def get_latency():
    latency = getattr(app.state, "latency", None)
    if latency is None:
        return {"records": []}
    return {"records": latency.records()}


@app.delete("/api/recent")
def clear_recent():
    eng = _engine()
    if eng.recent_memory:
        eng.recent_memory.clear()
    if eng.run_history:
        eng.run_history.clear()
    return {"ok": True}


class RunHistoryReplaceBody(BaseModel):
    records: list[dict[str, Any]] = Field(default_factory=list)


@app.put("/api/run_history")
def replace_run_history(body: RunHistoryReplaceBody):
    eng = _engine()
    if not eng.run_history:
        raise HTTPException(status_code=503, detail="run history not enabled")
    import time as _time
    from prompt_engine import RunRecord
    eng.run_history.clear()
    for r in body.records:
        try:
            at = float(r.get("at") or 0) or _time.time()
            eng.run_history.add(
                RunRecord(
                    request=dict(r.get("request") or {}),
                    text=str(r.get("text") or ""),
                    accepted=bool(r.get("accepted", True)),
                    route=str(r.get("route") or ""),
                    at=at,
                    metadata=dict(r.get("metadata") or {}),
                )
            )
        except (TypeError, ValueError):
            continue
    return {"ok": True, "count": len(eng.run_history.items())}


@app.delete("/api/run_history/{index}")
def delete_run(index: int):
    eng = _engine()
    if not eng.run_history:
        raise HTTPException(status_code=404, detail="no history")
    if not eng.run_history.remove_at(index):
        raise HTTPException(status_code=404, detail=f"index {index} out of range")
    return {"ok": True}


class IterateBody(BaseModel):
    user_prompt: str = ""
    assistant_output: str = ""
    user_response: str
    mode: str = "verbatim"  # or "compact"
    name: Optional[str] = None
    priority: int = 25
    compact_config: dict[str, Any] = Field(default_factory=dict)


def _next_iteration_name(existing: dict[str, Any]) -> str:
    n = 1
    while f"iteration_{n}" in existing:
        n += 1
    return f"iteration_{n}"


@app.post("/api/iterate")
async def iterate(body: IterateBody):
    """Create an overlay from a user follow-up.

    `mode="verbatim"` stores the user's response as-is.
    `mode="compact"` runs the compact_turn route to densify it first; the
    verbatim original is preserved in `metadata.verbatim` so the overlay can
    be reverted or re-compacted later.
    """
    eng = _engine()
    user_response = body.user_response.strip()
    if not user_response:
        raise HTTPException(status_code=400, detail="user_response required")

    overlays = eng.context_store.get_state().overlays
    name = body.name or _next_iteration_name(overlays)
    verbatim = user_response
    compacted: Optional[str] = None
    raw: Optional[str] = None

    if body.mode == "compact":
        result = await eng.generate_once(
            EngineRequest(
                mode="compact_turn",
                inputs={
                    "user_prompt": body.user_prompt,
                    "assistant_output": body.assistant_output,
                    "user_response": user_response,
                },
                debug=False,
                config_overrides=body.compact_config,
            )
        )
        raw = result.text
        compacted = (result.text or "").strip()
        if not compacted:
            compacted = verbatim

    overlay = make_turn_overlay(verbatim=verbatim, compacted=compacted, priority=body.priority)
    eng.context_store.set_overlay(name, overlay)
    return {
        "ok": True,
        "name": name,
        "text": overlay.text,
        "verbatim": verbatim,
        "compacted": compacted,
        "raw": raw,
    }


class RecompactBody(BaseModel):
    user_prompt: str = ""
    assistant_output: str = ""
    compact_config: dict[str, Any] = Field(default_factory=dict)


@app.post("/api/context/overlay/{name}/recompact")
async def recompact_overlay(name: str, body: RecompactBody):
    eng = _engine()
    overlays = eng.context_store.get_state().overlays
    overlay = overlays.get(name)
    if overlay is None:
        raise HTTPException(status_code=404, detail=f"no overlay named {name!r}")
    verbatim = (overlay.metadata or {}).get("verbatim")
    if not verbatim:
        raise HTTPException(status_code=400, detail="overlay has no verbatim to recompact")

    result = await eng.generate_once(
        EngineRequest(
            mode="compact_turn",
            inputs={
                "user_prompt": body.user_prompt,
                "assistant_output": body.assistant_output,
                "user_response": verbatim,
            },
            debug=False,
            config_overrides=body.compact_config,
        )
    )

    compacted = (result.text or "").strip() or verbatim
    new_overlay = make_turn_overlay(
        verbatim=verbatim,
        compacted=compacted,
        priority=overlay.priority,
    )
    eng.context_store.set_overlay(name, new_overlay)
    return {"ok": True, "name": name, "text": compacted, "verbatim": verbatim}


class RevertBody(BaseModel):
    pass


@app.post("/api/context/overlay/{name}/revert")
def revert_overlay(name: str):
    eng = _engine()
    overlays = eng.context_store.get_state().overlays
    overlay = overlays.get(name)
    if overlay is None:
        raise HTTPException(status_code=404, detail=f"no overlay named {name!r}")
    verbatim = (overlay.metadata or {}).get("verbatim")
    if not verbatim:
        raise HTTPException(status_code=400, detail="overlay has no verbatim to revert to")
    new_overlay = make_turn_overlay(verbatim=verbatim, compacted=None, priority=overlay.priority)
    eng.context_store.set_overlay(name, new_overlay)
    return {"ok": True, "name": name, "text": verbatim}


@app.post("/api/generate")
async def generate(body: GenerateRequest):
    eng = _engine()

    try:
        result = await eng.generate_once(
            EngineRequest(
                mode=body.mode,
                inputs=body.inputs,
                injections=body.injections,
                debug=body.debug,
                config_overrides=body.config_overrides,
            )
        )
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=502,
            detail={
                "error": "provider_unreachable",
                "kind": type(exc).__name__,
                "message": str(exc) or "provider closed the connection",
                "url": f"{OLLAMA_URL}{OLLAMA_CHAT_PATH}",
                "hint": (
                    "Tunnel or backend may have dropped. If the remote is "
                    "llama.cpp/vLLM rather than Ollama, set "
                    "OLLAMA_CHAT_PATH=/v1/chat/completions."
                ),
            },
        )

    return {
        "text": result.text,
        "accepted": result.accepted,
        "route": result.route,
        "trace": result.trace.to_dict() if result.trace else None,
    }


# ----------------------------------------------------------------------
# static frontend
# ----------------------------------------------------------------------

_static_dir = Path(__file__).parent / "static"
if _static_dir.exists():
    app.mount("/static", StaticFiles(directory=_static_dir), name="static")

    @app.get("/")
    def index():
        return FileResponse(_static_dir / "index.html")

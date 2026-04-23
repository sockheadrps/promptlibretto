from __future__ import annotations

import json
import os
from contextlib import asynccontextmanager, contextmanager
from dataclasses import asdict
from pathlib import Path
from typing import Any, Optional

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from promptlibretto import (
    CUSTOM_ROUTE_KIND,
    ContextOverlay,
    ContextStore,
    GenerationConfig,
    GenerationRequest,
    MockProvider,
    OllamaProvider,
    PromptEngine,
    PromptRoute,
    RouteSpec,
    export_json,
    load_engine,
    make_turn_overlay,
)
from promptlibretto.output.processor import OutputPolicy, ProcessingContext

from .base_library import BaseLibrary
from .custom_route_library import CustomRouteLibrary
from .export_library import ExportLibrary
from .middleware import LatencyLogger
from .presets import build_asset_registry, build_router
from .snapshot_library import SnapshotLibrary


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
        middlewares=[latency],
    )
    return engine, latency


def _data_dir() -> Path:
    override = os.environ.get("PROMPTLIBRETTO_DATA_DIR")
    if override:
        path = Path(override)
    else:
        path = Path.home() / ".promptlibretto" / "studio"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _exports_dir() -> Path:
    """Exports live next to the user's project by default, so `.json`
    files land somewhere useful. Override with PROMPTLIBRETTO_EXPORT_DIR
    to point at e.g. ./src/myapp/prompts/."""
    override = os.environ.get("PROMPTLIBRETTO_EXPORT_DIR")
    if override:
        path = Path(override)
    else:
        path = Path.cwd() / "promptlibretto_exports"
    path.mkdir(parents=True, exist_ok=True)
    return path


_LIBRARY_PATH = _data_dir() / "base_library.json"
_SNAPSHOT_PATH = _data_dir() / "snapshot_library.json"
_LEGACY_SCENARIO_PATH = _data_dir() / "scenario_library.json"
_EXPORTS_PATH = _exports_dir()
_CUSTOM_ROUTES_PATH = _data_dir() / "custom_routes"


@asynccontextmanager
async def lifespan(app: FastAPI):
    engine, latency = _build_engine()
    app.state.engine = engine
    app.state.latency = latency
    app.state.base_library = BaseLibrary(_LIBRARY_PATH)
    app.state.snapshot_library = SnapshotLibrary(
        _SNAPSHOT_PATH, legacy_path=_LEGACY_SCENARIO_PATH
    )
    app.state.export_library = ExportLibrary(_EXPORTS_PATH)
    app.state.custom_routes = CustomRouteLibrary(_CUSTOM_ROUTES_PATH)
    app.state.custom_route_names = set()
    for row in app.state.custom_routes.list():
        try:
            engine.register_route(row["spec"], replace=True)
            app.state.custom_route_names.add(row["name"])
        except (ValueError, TypeError):
            continue
    try:
        yield
    finally:
        provider = engine.provider
        if isinstance(provider, OllamaProvider):
            await provider.aclose()


app = FastAPI(title="promptlibretto studio", lifespan=lifespan)


class GenerateRequest(BaseModel):
    mode: Optional[str] = None
    inputs: dict[str, Any] = Field(default_factory=dict)
    injections: list[str] = Field(default_factory=list)
    debug: bool = True
    config_overrides: dict[str, Any] = Field(default_factory=dict)
    section_overrides: dict[str, str] = Field(default_factory=dict)
    injection_text_overrides: dict[str, str] = Field(default_factory=dict)


class OverlayBody(BaseModel):
    text: str
    priority: int = 0
    expires_at: Optional[float] = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class BaseContextBody(BaseModel):
    base: str


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
    max_prompt_chars: Optional[int] = None


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


def _snapshots() -> SnapshotLibrary:
    lib = getattr(app.state, "snapshot_library", None)
    if lib is None:
        raise HTTPException(status_code=503, detail="snapshot library not initialised")
    return lib


class SaveBaseBody(BaseModel):
    text: str


class SaveSnapshotBody(BaseModel):
    state: dict[str, Any]


@app.get("/api/state")
def get_state():
    eng = _engine()
    eng.context_store.prune()
    snap = eng.context_store.get_state()
    return {
        "config": eng.config.to_dict(),
        "ollama": {"url": OLLAMA_URL, "model": OLLAMA_MODEL, "mock": USE_MOCK},
        "context": {
            "base": snap.base,
            "active": snap.active,
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
                "is_custom": r.name in getattr(app.state, "custom_route_names", set()),
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
    }


@app.put("/api/context/base")
def set_base(body: BaseContextBody):
    eng = _engine()
    eng.context_store.set_base(body.base)
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


@app.get("/api/snapshots")
def list_snapshots():
    return {"snapshots": _snapshots().list()}


@app.get("/api/snapshots/{name}")
def get_snapshot(name: str):
    row = _snapshots().get(name)
    if row is None:
        raise HTTPException(status_code=404, detail=f"no snapshot named {name!r}")
    return row


@app.put("/api/snapshots/{name}")
def save_snapshot(name: str, body: SaveSnapshotBody):
    try:
        row = _snapshots().save(name, body.state)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"ok": True, "entry": {"name": row["name"], "saved_at": row["saved_at"]}}


@app.delete("/api/snapshots/{name}")
def delete_snapshot(name: str):
    ok = _snapshots().delete(name)
    if not ok:
        raise HTTPException(status_code=404, detail=f"no snapshot named {name!r}")
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
        GenerationRequest(
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


class IterateBody(BaseModel):
    user_prompt: str = ""
    assistant_output: str = ""
    user_response: str
    mode: str = "verbatim"
    name: Optional[str] = None
    priority: int = 25


def _next_iteration_name(existing: dict[str, Any]) -> str:
    n = 1
    while f"iteration_{n}" in existing:
        n += 1
    return f"iteration_{n}"


@app.post("/api/iterate")
async def iterate(body: IterateBody):
    """Create an overlay from a user follow-up. Stores the user's response verbatim."""
    eng = _engine()
    user_response = body.user_response.strip()
    if not user_response:
        raise HTTPException(status_code=400, detail="user_response required")

    overlays = eng.context_store.get_state().overlays
    name = body.name or _next_iteration_name(overlays)
    overlay = make_turn_overlay(verbatim=user_response, compacted=None, priority=body.priority)
    eng.context_store.set_overlay(name, overlay)
    return {
        "ok": True,
        "name": name,
        "text": overlay.text,
        "verbatim": user_response,
    }


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


class ExportBody(BaseModel):
    route: Optional[str] = None
    injections: list[str] = Field(default_factory=list)
    include_overlays: bool = True
    section_overrides: dict[str, str] = Field(default_factory=dict)
    injection_text_overrides: dict[str, str] = Field(default_factory=dict)


class SaveExportBody(BaseModel):
    data: dict[str, Any]
    snapshot: Optional[dict[str, Any]] = None


def _exports() -> ExportLibrary:
    lib = getattr(app.state, "export_library", None)
    if lib is None:
        raise HTTPException(status_code=503, detail="export library not initialised")
    return lib


class ResolveBody(BaseModel):
    mode: Optional[str] = None
    inputs: dict[str, Any] = Field(default_factory=dict)
    injections: list[str] = Field(default_factory=list)
    injection_text_overrides: dict[str, str] = Field(default_factory=dict)


@contextmanager
def _patched_injections(eng: PromptEngine, overrides: dict[str, str]):
    """Temporarily replace injector instruction text, restoring after."""
    originals: dict[str, str] = {}
    for name, text in (overrides or {}).items():
        tmpl = eng.asset_registry.injectors.get(name)
        if tmpl is not None:
            originals[name] = tmpl.instructions
            tmpl.instructions = text
    try:
        yield
    finally:
        for name, original_text in originals.items():
            tmpl = eng.asset_registry.injectors.get(name)
            if tmpl is not None:
                tmpl.instructions = original_text


@app.post("/api/prompt/resolve")
def resolve_prompt(body: ResolveBody):
    """Build the package without calling the provider. Used by the studio's
    prompt-edit panel to prefill the resolved system/user text."""
    from promptlibretto.builders.builder import BuildContext

    eng = _engine()
    req = GenerationRequest(
        mode=body.mode, inputs=body.inputs, injections=list(body.injections), debug=False
    )
    snapshot = eng.context_store.get_state()
    with _patched_injections(eng, body.injection_text_overrides):
        try:
            route = eng.router.select(snapshot, req)
            materialized = eng._materialize_injections(req.injections)
        except (KeyError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        ctx = BuildContext(
            snapshot=snapshot,
            request=req,
            assets=eng.asset_registry,
            random=eng.random,
            injections=materialized,
        )
        pkg = route.builder.build(ctx)

        # Also expose the per-section resolved strings so the studio can
        # render them as individual draggable cards for pre-generate.
        builder = route.builder
        system_parts: list[str] = []
        user_parts: list[str] = []
        runtime_slots: list[dict[str, str]] = []
        try:
            system_parts = [s(ctx) for s in getattr(builder, "system_sections", ()) or ()]
            if getattr(builder, "include_active_context", False):
                ordered_overlays = sorted(
                    ctx.snapshot.overlays.items(),
                    key=lambda kv: kv[1].priority,
                    reverse=True,
                )
                for name, overlay in ordered_overlays:
                    mode = str((overlay.metadata or {}).get("runtime") or "").lower()
                    if mode in ("optional", "required"):
                        user_parts.append("{}")
                        tmpl = str((overlay.metadata or {}).get("template") or "")
                        runtime_slots.append({
                            "name": name,
                            "mode": mode,
                            "template": tmpl,
                        })
                    else:
                        text = (overlay.text or "").strip()
                        if text:
                            user_parts.append(text)
            if getattr(builder, "include_injections", False) and ctx.injections:
                for inj in ctx.injections:
                    if inj.instructions:
                        user_parts.append(inj.instructions.strip())
                    if inj.examples:
                        user_parts.append("Examples:\n" + "\n".join(f"- {e}" for e in inj.examples))
            user_parts.extend(s(ctx) for s in getattr(builder, "user_sections", ()) or ())
        except Exception:
            system_parts = []
            user_parts = []

    return {
        "route": route.name,
        "system": pkg.system or "",
        "user": pkg.user or "",
        "system_sections": [p for p in system_parts if p and p.strip()],
        "user_sections": [p for p in user_parts if p and p.strip()],
        "separator": getattr(builder, "separator", "\n\n") or "\n\n",
        "runtime_slots": runtime_slots,
    }


class ProcessBody(BaseModel):
    """Output payload posted back to the server after a browser-direct LLM call."""
    raw_text: str = ""
    output_policy: dict[str, Any] = Field(default_factory=dict)
    route: str = ""
    usage: Optional[dict[str, Any]] = None
    timing: Optional[dict[str, Any]] = None
    trace_scaffolding: Optional[dict[str, Any]] = None
    debug: bool = True
    attempt_history: list[dict[str, Any]] = Field(default_factory=list)


def _policy_to_dict(policy: OutputPolicy) -> dict[str, Any]:
    """asdict with sequences coerced to lists so JSON round-trips cleanly."""
    out = asdict(policy)
    for k, v in list(out.items()):
        if isinstance(v, tuple):
            out[k] = list(v)
    return out


@app.post("/api/resolve")
def resolve_full(body: GenerateRequest):
    """Build a fully-resolved ProviderRequest + output policy without calling
    the LLM. The browser posts the result to the user's local Ollama/llama.cpp
    and sends the raw text back to /api/process."""
    eng = _engine()
    req = GenerationRequest(
        mode=body.mode,
        inputs=body.inputs,
        injections=list(body.injections),
        debug=body.debug,
        config_overrides=body.config_overrides,
        section_overrides=body.section_overrides,
    )
    snapshot = eng.context_store.get_state()
    with _patched_injections(eng, body.injection_text_overrides):
        try:
            route = eng.router.select(snapshot, req)
            injections = eng._materialize_injections(req.injections)
            package, final_snapshot, merged_config, config_layers, trim_info = (
                eng._build_with_budget(route, req, snapshot, injections)
            )
        except (KeyError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        policy = eng.output_processor.policy_for(package.output_policy)

    messages: list[dict[str, str]] = []
    if package.system:
        messages.append({"role": "system", "content": package.system})
    messages.append({"role": "user", "content": package.user})

    scaffolding = None
    if body.debug:
        scaffolding = {
            "active_context": final_snapshot.active,
            "system_prompt": package.system or "",
            "user_prompt": package.user,
            "config": merged_config.to_dict(),
            "config_layers": config_layers,
            "overlays": {
                n: {"text": o.text, "priority": o.priority, "expires_at": o.expires_at}
                for n, o in final_snapshot.overlays.items()
            },
            "package_metadata": dict(package.metadata or {}),
            "budget": trim_info,
            "injections": [i.name for i in injections],
        }

    return {
        "provider_request": {
            "model": merged_config.model,
            "messages": messages,
            "temperature": merged_config.temperature,
            "max_tokens": merged_config.max_tokens,
            "top_p": merged_config.top_p,
            "top_k": merged_config.top_k,
            "repeat_penalty": merged_config.repeat_penalty,
            "timeout_ms": merged_config.timeout_ms,
        },
        "output_policy": _policy_to_dict(policy),
        "route": route.name,
        "injections": [i.name for i in injections],
        "retries": max(0, merged_config.retries),
        "trace_scaffolding": scaffolding,
    }


@app.post("/api/process")
def process_output(body: ProcessBody):
    """Clean + validate raw LLM output against a resolved output policy. The
    browser calls this after each attempt of a browser-direct LLM request; on
    rejection it may loop and call again up to `retries`."""
    eng = _engine()
    try:
        policy = OutputPolicy(**body.output_policy) if body.output_policy else OutputPolicy()
    except TypeError as exc:
        raise HTTPException(status_code=400, detail=f"invalid output_policy: {exc}")

    scaf = body.trace_scaffolding or {}
    ctx = ProcessingContext(
        route=body.route,
        user_prompt=scaf.get("user_prompt", ""),
        metadata=dict(scaf.get("package_metadata") or {}),
    )
    cleaned = eng.output_processor.clean(body.raw_text, ctx, policy)
    validation = eng.output_processor.validate(cleaned, ctx, policy)

    attempt = {
        "raw": body.raw_text,
        "cleaned": cleaned,
        "accepted": validation.ok,
        "reject_reason": validation.reason,
    }
    attempts = list(body.attempt_history) + [attempt]

    trace = None
    if body.debug and scaf:
        trace = {
            "route": body.route,
            "active_context": scaf.get("active_context", ""),
            "system_prompt": scaf.get("system_prompt", ""),
            "user_prompt": scaf.get("user_prompt", ""),
            "config": scaf.get("config", {}),
            "injections": scaf.get("injections", []),
            "output_raw": body.raw_text,
            "output_final": cleaned,
            "attempts": attempts,
            "usage": body.usage,
            "timing": body.timing,
            "metadata": {
                "overlays": scaf.get("overlays", {}),
                "package_metadata": scaf.get("package_metadata", {}),
                "config_layers": scaf.get("config_layers", {}),
                "budget": scaf.get("budget"),
                "reject_reason": None if validation.ok else validation.reason,
            },
        }

    return {
        "text": cleaned,
        "accepted": validation.ok,
        "reject_reason": validation.reason,
        "usage": body.usage,
        "timing": body.timing,
        "trace": trace,
        "attempts": attempts,
    }


@app.post("/api/export")
def export_route(body: ExportBody):
    eng = _engine()
    with _patched_injections(eng, body.injection_text_overrides):
        try:
            data = export_json(
                eng,
                route=body.route,
                injections=tuple(body.injections),
                include_overlays=body.include_overlays,
                section_overrides=body.section_overrides or None,
            )
        except (ValueError, TypeError) as exc:
            raise HTTPException(status_code=400, detail=str(exc))
    return {"data": data, "dir": str(_EXPORTS_PATH)}


@app.get("/api/exports")
def list_exports():
    rows = _exports().list()
    snapshot_names = {r["name"] for r in _snapshots().list()}
    for r in rows:
        r["has_snapshot"] = r["name"] in snapshot_names
        # Surface declared runtime slots so the ensemble UI can preload
        # context-row keys and target them only at models that declare
        # them. Cheap: each export is a small JSON file.
        r["slots"] = _slots_for(r["name"])
    return {"exports": rows, "dir": str(_EXPORTS_PATH)}


def _slots_for(name: str) -> list[dict[str, Any]]:
    row = _exports().get(name)
    data = (row or {}).get("data") or {}
    route = data.get("route") or {}
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    # Runtime slots live as inline user_sections entries with a `runtime`
    # key (see export_json). Their placeholder is "{name}".
    import re as _re
    for s in route.get("user_sections") or []:
        if not isinstance(s, dict):
            continue
        runtime = s.get("runtime")
        if runtime not in ("optional", "required"):
            continue
        tmpl = s.get("template") or ""
        m = _re.search(r"\{([A-Za-z_][A-Za-z0-9_]*)\}", tmpl)
        if not m:
            continue
        slot = m.group(1)
        if slot in seen:
            continue
        seen.add(slot)
        out.append({"name": slot, "runtime": runtime})
    return out


@app.get("/api/exports/{name}")
def get_export(name: str):
    row = _exports().get(name)
    if row is None:
        raise HTTPException(status_code=404, detail=f"no export named {name!r}")
    return row


@app.put("/api/exports/{name}")
def save_export(name: str, body: SaveExportBody):
    try:
        row = _exports().save(name, body.data)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    snapshot_saved = False
    if body.snapshot is not None:
        try:
            _snapshots().save(name, body.snapshot)
            snapshot_saved = True
        except ValueError:
            pass
    return {"ok": True, "entry": row, "snapshot_saved": snapshot_saved}


@app.delete("/api/exports/{name}")
def delete_export(name: str):
    if not _exports().delete(name):
        raise HTTPException(status_code=404, detail=f"no export named {name!r}")
    return {"ok": True}


@app.post("/api/generate")
async def generate(body: GenerateRequest):
    eng = _engine()

    with _patched_injections(eng, body.injection_text_overrides):
        try:
            result = await eng.generate_once(
                GenerationRequest(
                    mode=body.mode,
                    inputs=body.inputs,
                    injections=body.injections,
                    debug=body.debug,
                    config_overrides=body.config_overrides,
                    section_overrides=body.section_overrides,
                )
            )
        except (KeyError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc))
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
        "usage": result.usage,
        "timing": result.timing,
        "trace": result.trace.to_dict() if result.trace else None,
    }


@app.post("/api/generate/stream")
async def generate_stream(body: GenerateRequest):
    eng = _engine()
    # Patch injector instructions for the duration of the stream.
    # We save/restore manually because the async generator outlives a
    # normal `with` block.
    originals: dict[str, str] = {}
    for name, text in (body.injection_text_overrides or {}).items():
        tmpl = eng.asset_registry.injectors.get(name)
        if tmpl is not None:
            originals[name] = tmpl.instructions
            tmpl.instructions = text

    async def events():
        try:
            request = GenerationRequest(
                mode=body.mode,
                inputs=body.inputs,
                injections=body.injections,
                debug=body.debug,
                config_overrides=body.config_overrides,
                section_overrides=body.section_overrides,
            )
            async for chunk in eng.generate_stream(request):
                if chunk.done:
                    result = chunk.result
                    yield json.dumps({
                        "done": True,
                        "result": {
                            "text": result.text if result else "",
                            "accepted": result.accepted if result else False,
                            "route": result.route if result else "",
                            "usage": result.usage if result else None,
                            "timing": result.timing if result else None,
                            "trace": result.trace.to_dict()
                            if result and result.trace
                            else None,
                        },
                    }) + "\n"
                elif chunk.delta:
                    yield json.dumps({"delta": chunk.delta}) + "\n"
        except httpx.HTTPError as exc:
            yield json.dumps({
                "error": {
                    "error": "provider_unreachable",
                    "kind": type(exc).__name__,
                    "message": str(exc) or "provider closed the connection",
                    "url": f"{OLLAMA_URL}{OLLAMA_CHAT_PATH}",
                    "hint": (
                        "Tunnel or backend may have dropped. If the remote is "
                        "llama.cpp/vLLM rather than Ollama, set "
                        "OLLAMA_CHAT_PATH=/v1/chat/completions."
                    ),
                }
            }) + "\n"
        except (KeyError, ValueError) as exc:
            yield json.dumps({"error": {"message": str(exc)}}) + "\n"
        except RuntimeError as exc:
            yield json.dumps({"error": {"message": str(exc)}}) + "\n"
        finally:
            for n, orig in originals.items():
                tmpl = eng.asset_registry.injectors.get(n)
                if tmpl is not None:
                    tmpl.instructions = orig

    return StreamingResponse(events(), media_type="application/x-ndjson")


class EnsembleContextRow(BaseModel):
    key: str
    value: str = ""
    exclude: list[str] = Field(default_factory=list)


class EnsembleGenerateBody(BaseModel):
    exports: list[str] = Field(default_factory=list)
    user_input: str = ""
    context: list[EnsembleContextRow] = Field(default_factory=list)


# Cache: export name -> (mtime, engine, run). Reload when the file changes.
_ENSEMBLE_CACHE: dict[str, tuple[float, PromptEngine, Any]] = {}


def _load_ensemble_member(name: str) -> tuple[PromptEngine, Any]:
    row = _exports().get(name)
    if row is None or row.get("data") is None:
        raise HTTPException(status_code=404, detail=f"no export named {name!r}")
    saved_at = float(row.get("saved_at") or 0.0)
    cached = _ENSEMBLE_CACHE.get(name)
    if cached and cached[0] == saved_at:
        return cached[1], cached[2]
    try:
        engine, run = load_engine(row["data"])
    except (ValueError, KeyError, TypeError) as exc:
        raise HTTPException(status_code=400, detail=f"{name}: {exc}")
    # Exports don't carry provider connection details (URL, chat path);
    # swap in the studio's already-configured provider so subordinates
    # hit the same backend the studio is pointed at. Each subordinate
    # keeps its own per-request model from its loaded config.
    engine.provider = _engine().provider
    _ENSEMBLE_CACHE[name] = (saved_at, engine, run)
    return engine, run


@app.post("/api/ensemble/generate")
async def ensemble_generate(body: EnsembleGenerateBody):
    """Fan out a single user_input + context kwargs to N saved exports.

    Each subordinate runs independently with its own engine and `run()`
    closure. Subordinates don't see each other; the only shared signal is
    the per-call `context` dict, which becomes priority-10 overlays (or
    fills runtime slots) on each one.
    """
    import asyncio

    names = [n for n in (body.exports or []) if n]
    if not names:
        raise HTTPException(status_code=400, detail="exports required")

    members = [(name, *_load_ensemble_member(name)) for name in names]

    def _context_for(name: str) -> dict[str, str]:
        out: dict[str, str] = {}
        for row in body.context or []:
            if not row.key or name in (row.exclude or []):
                continue
            out[row.key] = row.value
        return out

    async def _run_one(name: str, run) -> dict[str, Any]:
        ctx = _context_for(name)
        try:
            # _debug=True asks the run-closure to enable the engine's
            # debug trace so we can return the fully-built system/user
            # prompt for the result-card flip view.
            result = await run(body.user_input or "", _debug=True, **ctx)
            trace = result.trace.to_dict() if result.trace else None
            return {
                "name": name,
                "ok": True,
                "text": result.text,
                "accepted": result.accepted,
                "route": result.route,
                "context_applied": ctx,
                "prompt": {
                    "system": (trace or {}).get("system_prompt") or "",
                    "user": (trace or {}).get("user_prompt") or "",
                } if trace else None,
            }
        except (ValueError, RuntimeError) as exc:
            return {"name": name, "ok": False, "error": str(exc), "context_applied": ctx}
        except httpx.HTTPError as exc:
            return {
                "name": name,
                "ok": False,
                "error": f"provider unreachable: {type(exc).__name__}: {exc}",
                "context_applied": ctx,
            }

    results = await asyncio.gather(*(_run_one(n, r) for n, _e, r in members))
    return {"results": results}


@app.post("/api/ensemble/resolve")
def ensemble_resolve(body: EnsembleGenerateBody):
    """Resolve prompts for a browser-direct ensemble fanout. Returns one
    provider_request + output_policy per selected export. The browser fires
    the LLM calls itself, then posts each raw output to /api/process."""
    names = [n for n in (body.exports or []) if n]
    if not names:
        raise HTTPException(status_code=400, detail="exports required")

    def _context_for(name: str) -> dict[str, str]:
        out: dict[str, str] = {}
        for row in body.context or []:
            if not row.key or name in (row.exclude or []):
                continue
            out[row.key] = row.value
        return out

    results: list[dict[str, Any]] = []
    for name in names:
        try:
            engine, run = _load_ensemble_member(name)
        except HTTPException as exc:
            results.append({"name": name, "ok": False, "error": str(exc.detail)})
            continue
        ctx = _context_for(name)
        try:
            request = run.prepare(body.user_input or "", **ctx)  # type: ignore[attr-defined]
            snapshot = engine.context_store.get_state()
            route = engine.router.select(snapshot, request)
            injections = engine._materialize_injections(request.injections)
            package, final_snapshot, merged_config, _layers, _trim = (
                engine._build_with_budget(route, request, snapshot, injections)
            )
            policy = engine.output_processor.policy_for(package.output_policy)
        except (KeyError, ValueError) as exc:
            results.append({"name": name, "ok": False, "error": str(exc), "context_applied": ctx})
            continue

        messages: list[dict[str, str]] = []
        if package.system:
            messages.append({"role": "system", "content": package.system})
        messages.append({"role": "user", "content": package.user})

        results.append({
            "name": name,
            "ok": True,
            "provider_request": {
                "model": merged_config.model,
                "messages": messages,
                "temperature": merged_config.temperature,
                "max_tokens": merged_config.max_tokens,
                "top_p": merged_config.top_p,
                "top_k": merged_config.top_k,
                "repeat_penalty": merged_config.repeat_penalty,
                "timeout_ms": merged_config.timeout_ms,
            },
            "output_policy": _policy_to_dict(policy),
            "route": route.name,
            "context_applied": ctx,
            "prompt": {
                "system": package.system or "",
                "user": package.user,
            },
        })
    return {"results": results}


class CustomRouteBody(BaseModel):
    description: str = ""
    system: str = ""
    user_template: str = "{input}"
    priority: int = 0
    generation_overrides: dict[str, Any] = Field(default_factory=dict)
    output_policy: dict[str, Any] = Field(default_factory=dict)


def _custom_routes() -> CustomRouteLibrary:
    lib = getattr(app.state, "custom_routes", None)
    if lib is None:
        raise HTTPException(status_code=503, detail="custom-route library not initialised")
    return lib


@app.get("/api/routes/custom")
def list_custom_routes():
    return {"routes": _custom_routes().list()}


@app.get("/api/routes/custom/{name}")
def get_custom_route(name: str):
    row = _custom_routes().get(name)
    if row is None:
        raise HTTPException(status_code=404, detail=f"no custom route named {name!r}")
    return row


@app.put("/api/routes/custom/{name}")
def save_custom_route(name: str, body: CustomRouteBody):
    eng = _engine()
    spec_dict = {**body.model_dump(), "name": name, "kind": CUSTOM_ROUTE_KIND}
    custom_names: set[str] = getattr(app.state, "custom_route_names", set())
    existing = eng.router.get(name)
    if existing is not None and name not in custom_names:
        raise HTTPException(
            status_code=409,
            detail=f"route {name!r} is built-in; pick a different name",
        )
    try:
        spec = RouteSpec.from_dict(spec_dict)
        route = spec.build()
    except (ValueError, TypeError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    # Validate override keys at save-time so bad fields don't lurk until
    # the first generate. Both raise ValueError on unknown keys.
    try:
        eng.config.merged_with(spec.generation_overrides)
        eng.output_processor.policy_for(spec.output_policy)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    try:
        row = _custom_routes().save(name, spec.to_dict())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    eng.register_route(route, replace=True)
    custom_names.add(row["name"])
    app.state.custom_route_names = custom_names
    return {"ok": True, "entry": row}


@app.delete("/api/routes/custom/{name}")
def delete_custom_route(name: str):
    eng = _engine()
    custom_names: set[str] = getattr(app.state, "custom_route_names", set())
    if name not in custom_names:
        raise HTTPException(status_code=404, detail=f"no custom route named {name!r}")
    _custom_routes().delete(name)
    eng.unregister_route(name)
    custom_names.discard(name)
    app.state.custom_route_names = custom_names
    # Drop any cached ensemble engines that referenced this route by name —
    # they were loaded against a stale router. Cheap; ensemble reloads lazily.
    return {"ok": True}


_static_dir = Path(__file__).parent / "static"
if _static_dir.exists():
    app.mount("/static", StaticFiles(directory=_static_dir), name="static")

    @app.get("/")
    def index():
        return FileResponse(_static_dir / "index.html")

    @app.get("/ensemble")
    def ensemble_page():
        return FileResponse(_static_dir / "ensemble.html")

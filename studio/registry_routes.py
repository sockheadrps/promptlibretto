"""Studio backend — registry endpoints.

Exposes a small REST API over :class:`promptlibretto.Engine`:

* ``POST /api/registry/load``     — parse + return the canonical registry JSON.
* ``POST /api/registry/hydrate``  — render the prompt for a given state.
* ``POST /api/registry/generate`` — hydrate + LLM + output-policy validation.

The studio frontend already does most of this client-side; these
endpoints are here for callers that want a thin server proxy (CLI tools,
notebooks, alternate frontends).
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from promptlibretto import (
    Engine,
    MockProvider,
    OllamaProvider,
    Registry,
    RegistryState,
)

router = APIRouter(prefix="/api/registry")


# ── Provider wiring ──────────────────────────────────────────────


def _build_provider():
    if os.environ.get("PROMPT_ENGINE_MOCK", "").lower() in ("1", "true", "yes"):
        return MockProvider()
    base_url = os.environ.get("OLLAMA_URL", "http://localhost:11434")
    chat_path = os.environ.get("OLLAMA_CHAT_PATH", "/api/chat")
    return OllamaProvider(base_url=base_url, chat_path=chat_path)


# ── Request/response shapes ──────────────────────────────────────


class LoadRequest(BaseModel):
    registry: dict[str, Any] = Field(..., description="Registry JSON (wrapped or bare).")


class HydrateRequest(BaseModel):
    registry: dict[str, Any]
    state: dict[str, Any] = Field(default_factory=dict)
    route: Optional[str] = None
    seed: Optional[int] = None


class GenerateRequest(HydrateRequest):
    pass


class SaveExampleRequest(BaseModel):
    path: str
    payload: dict[str, Any]


_STATIC_DIR = Path(__file__).parent / "static"
_EXAMPLE_DIRS = {
    "/static/examples/": _STATIC_DIR / "examples",
    "/static/builder-examples/": _STATIC_DIR / "builder-examples",
}


def _resolve_example_path(path: str) -> Path:
    for prefix, root in _EXAMPLE_DIRS.items():
        if not path.startswith(prefix):
            continue
        name = path.removeprefix(prefix)
        if not name or "/" in name or "\\" in name or not name.endswith(".json"):
            raise HTTPException(400, "invalid example filename")
        target = (root / name).resolve()
        root_resolved = root.resolve()
        if target.parent != root_resolved:
            raise HTTPException(400, "invalid example path")
        if not target.exists():
            raise HTTPException(404, "example does not exist")
        return target
    raise HTTPException(400, "example path must point to /static/examples or /static/builder-examples")


# ── Endpoints ────────────────────────────────────────────────────


@router.post("/load")
def load(req: LoadRequest) -> dict[str, Any]:
    try:
        reg = Registry.from_dict(req.registry)
    except Exception as e:
        raise HTTPException(400, f"failed to parse registry: {e}")
    return reg.to_dict(wrap=True)


@router.post("/hydrate")
def hydrate(req: HydrateRequest) -> dict[str, Any]:
    try:
        eng = Engine(req.registry)
        state = RegistryState.from_dict(req.state)
        prompt = eng.hydrate(state, route=req.route, seed=req.seed)
    except Exception as e:
        raise HTTPException(400, f"hydrate failed: {e}")
    return {"prompt": prompt}


@router.post("/generate")
async def generate(req: GenerateRequest) -> dict[str, Any]:
    try:
        eng = Engine(req.registry, provider=_build_provider())
        state = RegistryState.from_dict(req.state)
        result = await eng.run(state, route=req.route, seed=req.seed)
    except Exception as e:
        raise HTTPException(500, f"generate failed: {e}")
    return {
        "text": result.text,
        "accepted": result.accepted,
        "prompt": result.prompt,
        "route": result.route,
        "reason": result.reason,
        "usage": result.usage,
        "timing": result.timing,
    }


@router.post("/example/save")
def save_example(req: SaveExampleRequest) -> dict[str, Any]:
    target = _resolve_example_path(req.path)
    try:
        with target.open("w", encoding="utf-8") as f:
            json.dump(req.payload, f, indent=2, ensure_ascii=False)
            f.write("\n")
    except Exception as e:
        raise HTTPException(500, f"example save failed: {e}")
    return {"ok": True, "path": req.path}

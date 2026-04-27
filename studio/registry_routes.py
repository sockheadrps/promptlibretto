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

import os
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from promptlibretto import (
    Engine,
    HydrateState,
    MockProvider,
    OllamaProvider,
    Registry,
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


class StateBody(BaseModel):
    selections: dict[str, Any] = Field(default_factory=dict)
    array_modes: dict[str, dict[str, str]] = Field(default_factory=dict)
    section_random: dict[str, bool] = Field(default_factory=dict)
    sliders: dict[str, float] = Field(default_factory=dict)
    slider_random: dict[str, bool] = Field(default_factory=dict)
    template_vars: dict[str, str] = Field(default_factory=dict)


class HydrateRequest(BaseModel):
    registry: dict[str, Any]
    state: StateBody = Field(default_factory=StateBody)
    route: Optional[str] = None
    seed: Optional[int] = None


class GenerateRequest(HydrateRequest):
    pass


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
        state = HydrateState.from_dict(req.state.model_dump())
        prompt = eng.hydrate(state, route=req.route, seed=req.seed)
    except Exception as e:
        raise HTTPException(400, f"hydrate failed: {e}")
    return {"prompt": prompt}


@router.post("/generate")
async def generate(req: GenerateRequest) -> dict[str, Any]:
    try:
        eng = Engine(req.registry, provider=_build_provider())
        state = HydrateState.from_dict(req.state.model_dump())
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

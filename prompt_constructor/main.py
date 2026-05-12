"""promptlibretto studio — slim backend.

Serves the studio UI (``static/indexv2.html`` + ``appv2.js``) and exposes
the registry API (``/api/registry/*``). The frontend does most of its work
client-side now — selections, runtime modes, hydrate, snapshots — so the
server is intentionally thin.
"""
from __future__ import annotations

import uuid as _uuid_mod
from pathlib import Path

import httpx
from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request as StarletteRequest

from .config import MULTI_TENANT, USER_ID_COOKIE
from .registry_routes import router as registry_router
from .ensemble_routes import router as ensemble_router
from .memory_routes import router as memory_router
from .builder_routes import router as builder_router

app = FastAPI(title="promptlibretto studio")


class _UserIdMiddleware(BaseHTTPMiddleware):
    """Assign a persistent anonymous user ID cookie when MULTI_TENANT is on."""
    async def dispatch(self, request: StarletteRequest, call_next):
        response = await call_next(request)
        if MULTI_TENANT and USER_ID_COOKIE not in request.cookies:
            response.set_cookie(
                USER_ID_COOKIE,
                str(_uuid_mod.uuid4()),
                max_age=60 * 60 * 24 * 365,
                httponly=True,
                samesite="lax",
            )
        return response


if MULTI_TENANT:
    app.add_middleware(_UserIdMiddleware)

app.include_router(registry_router)
app.include_router(ensemble_router)
app.include_router(memory_router)
app.include_router(builder_router)


_static_dir = Path(__file__).parent / "static"
if _static_dir.exists():
    app.mount("/static", StaticFiles(directory=_static_dir), name="static")


@app.get("/")
def landing() -> FileResponse:
    return FileResponse(_static_dir / "home" / "index.html")


@app.get("/studio")
@app.get("/v21")  # legacy bookmark
def studio_page() -> FileResponse:
    return FileResponse(_static_dir / "studio" / "indexv2.html")


@app.get("/builder")
def builder() -> FileResponse:
    return FileResponse(_static_dir / "builder" / "templatebuilder.html")


@app.get("/assistant")
def chat_builder() -> FileResponse:
    return FileResponse(_static_dir / "assistant" / "chatbuilder.html")


@app.get("/ensemble")
def ensemble() -> FileResponse:
    return FileResponse(_static_dir / "ensemble" / "ensemble.html")


@app.get("/api/config")
def config() -> JSONResponse:
    return JSONResponse({"multi_tenant": MULTI_TENANT})


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


class _TestConnRequest(BaseModel):
    baseUrl: str
    model: str
    apiKey: str = ""


@app.post("/api/test-embed")
async def test_embed(req: _TestConnRequest) -> JSONResponse:
    base = req.baseUrl.rstrip("/")
    # Each entry: (path, payload). Try new Ollama, then old Ollama, then OpenAI-compat.
    attempts = [
        ("/api/embed",      {"model": req.model, "input": "test"}),
        ("/api/embeddings", {"model": req.model, "prompt": "test"}),
        ("/v1/embeddings",  {"model": req.model, "input": "test"}),
    ]
    last_err = "Could not reach embed endpoint."
    async with httpx.AsyncClient() as client:
        for path, payload in attempts:
            try:
                resp = await client.post(f"{base}{path}", json=payload, timeout=15.0)
                if resp.status_code == 200:
                    data = resp.json()
                    dim: int | None = None
                    if isinstance(data.get("data"), list) and data["data"]:
                        emb = data["data"][0].get("embedding", [])
                        dim = len(emb) if emb else None
                    elif "embeddings" in data:
                        embs = data["embeddings"]
                        if embs and isinstance(embs[0], list):
                            dim = len(embs[0])
                    elif "embedding" in data:
                        dim = len(data["embedding"])
                    msg = f"OK — {dim}-dim vector." if dim else "OK."
                    return JSONResponse({"ok": True, "message": msg})
                last_err = f"Embed endpoint returned {resp.status_code}."
            except Exception as exc:
                last_err = str(exc)
                continue
    return JSONResponse({"ok": False, "message": last_err})


@app.post("/api/test-classifier")
async def test_classifier(req: _TestConnRequest) -> JSONResponse:
    base = req.baseUrl.rstrip("/")
    headers = {"Authorization": f"Bearer {req.apiKey}"} if req.apiKey else {}
    paths = [
        ("/api/chat",               {"model": req.model, "messages": [{"role": "user", "content": "ping"}], "stream": False, "options": {"num_predict": 1}}),
        ("/v1/chat/completions",    {"model": req.model, "messages": [{"role": "user", "content": "ping"}], "max_tokens": 1}),
    ]
    async with httpx.AsyncClient() as client:
        for path, payload in paths:
            try:
                resp = await client.post(f"{base}{path}", json=payload, headers=headers, timeout=30.0)
                if resp.status_code == 200:
                    return JSONResponse({"ok": True, "message": f"OK ({req.model})."})
            except Exception:
                continue
    return JSONResponse({"ok": False, "message": "Could not reach classifier endpoint."})

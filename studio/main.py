"""promptlibretto studio — slim backend.

Serves the studio UI (``static/indexv2.html`` + ``appv2.js``) and exposes
the registry API (``/api/registry/*``). The frontend does most of its work
client-side now — selections, runtime modes, hydrate, snapshots — so the
server is intentionally thin.
"""
from __future__ import annotations

import uuid as _uuid_mod
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request as StarletteRequest

from .config import MULTI_TENANT, USER_ID_COOKIE
from .registry_routes import router as registry_router
from .ensemble_routes import router as ensemble_router
from .memory_routes import router as memory_router

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


_static_dir = Path(__file__).parent / "static"
if _static_dir.exists():
    app.mount("/static", StaticFiles(directory=_static_dir), name="static")


@app.get("/")
@app.get("/v21")  # legacy bookmark — redirect-equivalent
def index() -> FileResponse:
    return FileResponse(_static_dir / "indexv2.html")


@app.get("/builder")
def builder() -> FileResponse:
    return FileResponse(_static_dir / "templatebuilder.html")


@app.get("/ensemble")
def ensemble() -> FileResponse:
    return FileResponse(_static_dir / "ensemble.html")


@app.get("/api/config")
def config() -> JSONResponse:
    return JSONResponse({"multi_tenant": MULTI_TENANT})


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}

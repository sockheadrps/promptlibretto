"""promptlibretto studio — slim backend.

Serves the studio UI (``static/indexv2.html`` + ``appv2.js``) and exposes
the registry API (``/api/registry/*``). The frontend does most of its work
client-side now — selections, runtime modes, hydrate, snapshots — so the
server is intentionally thin.
"""
from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .registry_routes import router as registry_router

app = FastAPI(title="promptlibretto studio")
app.include_router(registry_router)


_static_dir = Path(__file__).parent / "static"
if _static_dir.exists():
    app.mount("/static", StaticFiles(directory=_static_dir), name="static")


@app.get("/")
@app.get("/v21")  # legacy bookmark — redirect-equivalent
def index() -> FileResponse:
    return FileResponse(_static_dir / "indexv2.html")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}

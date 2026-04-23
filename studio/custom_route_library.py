from __future__ import annotations

import json
import re
import time
from pathlib import Path
from threading import Lock
from typing import Any


_SAFE = re.compile(r"[^A-Za-z0-9_.-]+")


def _safe_name(name: str) -> str:
    cleaned = _SAFE.sub("_", name.strip()).strip("._")
    if not cleaned:
        raise ValueError("name required")
    return cleaned


class CustomRouteLibrary:
    """One JSON file per custom route. Each file is a RouteSpec.to_dict()."""

    def __init__(self, path: Path):
        self.path = path
        self.path.mkdir(parents=True, exist_ok=True)
        self._lock = Lock()

    def _file(self, name: str) -> Path:
        return self.path / f"{_safe_name(name)}.json"

    def list(self) -> list[dict[str, Any]]:
        with self._lock:
            out: list[dict[str, Any]] = []
            for p in self.path.glob("*.json"):
                try:
                    stat = p.stat()
                    data = json.loads(p.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError):
                    continue
                out.append({"name": p.stem, "saved_at": stat.st_mtime, "spec": data})
            out.sort(key=lambda r: r["name"])
            return out

    def get(self, name: str) -> dict[str, Any] | None:
        with self._lock:
            p = self._file(name)
            if not p.exists():
                return None
            try:
                stat = p.stat()
                data = json.loads(p.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                return None
            return {"name": p.stem, "saved_at": stat.st_mtime, "spec": data}

    def save(self, name: str, spec: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            payload = dict(spec or {})
            payload["name"] = _safe_name(name)
            p = self._file(name)
            tmp = p.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
            tmp.replace(p)
            return {"name": p.stem, "saved_at": time.time(), "spec": payload}

    def delete(self, name: str) -> bool:
        with self._lock:
            p = self._file(name)
            if not p.exists():
                return False
            p.unlink()
            return True

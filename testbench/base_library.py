"""JSON-backed library of named base-context snippets.

The engine only keeps one active base context at a time, but users need to
stash and recall multiple framings. This module is a tiny persistence layer
for that — intentionally separate from the engine so the engine stays pure.
"""
from __future__ import annotations

import json
import time
from pathlib import Path
from threading import Lock
from typing import Any


class BaseLibrary:
    def __init__(self, path: Path):
        self.path = path
        self._lock = Lock()
        self._entries: dict[str, dict[str, Any]] = {}
        self._load()

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return
        bases = data.get("bases", []) if isinstance(data, dict) else []
        for row in bases:
            name = str(row.get("name") or "").strip()
            text = str(row.get("text") or "")
            if not name:
                continue
            self._entries[name] = {
                "name": name,
                "text": text,
                "saved_at": float(row.get("saved_at") or time.time()),
            }

    def _persist(self) -> None:
        payload = {"bases": sorted(self._entries.values(), key=lambda r: r["saved_at"], reverse=True)}
        tmp = self.path.with_suffix(self.path.suffix + ".tmp")
        tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        tmp.replace(self.path)

    def list(self) -> list[dict[str, Any]]:
        with self._lock:
            return sorted(self._entries.values(), key=lambda r: r["saved_at"], reverse=True)

    def get(self, name: str) -> dict[str, Any] | None:
        with self._lock:
            row = self._entries.get(name)
            return dict(row) if row else None

    def save(self, name: str, text: str) -> dict[str, Any]:
        name = name.strip()
        if not name:
            raise ValueError("name required")
        with self._lock:
            row = {"name": name, "text": text, "saved_at": time.time()}
            self._entries[name] = row
            self._persist()
            return dict(row)

    def delete(self, name: str) -> bool:
        with self._lock:
            if name not in self._entries:
                return False
            del self._entries[name]
            self._persist()
            return True

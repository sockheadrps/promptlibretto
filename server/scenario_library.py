"""JSON-backed library of full app-state scenarios.

A scenario is the complete editable surface of the test bench at a moment in
time: base context, overlays, route selection, injection picks, the user's
draft prompt, generation overrides, and the recent-output ring. Saving and
reloading these lets users keep working setups across sessions and share
reproductions.

Stored opaquely as a JSON blob per name so the schema can evolve without
touching this module.
"""
from __future__ import annotations

import json
import time
from pathlib import Path
from threading import Lock
from typing import Any


class ScenarioLibrary:
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
        rows = data.get("scenarios", []) if isinstance(data, dict) else []
        for row in rows:
            name = str(row.get("name") or "").strip()
            if not name:
                continue
            self._entries[name] = {
                "name": name,
                "state": row.get("state") or {},
                "saved_at": float(row.get("saved_at") or time.time()),
            }

    def _persist(self) -> None:
        payload = {
            "scenarios": sorted(
                self._entries.values(), key=lambda r: r["saved_at"], reverse=True
            )
        }
        tmp = self.path.with_suffix(self.path.suffix + ".tmp")
        tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        tmp.replace(self.path)

    def list(self) -> list[dict[str, Any]]:
        with self._lock:
            return [
                {"name": r["name"], "saved_at": r["saved_at"]}
                for r in sorted(
                    self._entries.values(), key=lambda r: r["saved_at"], reverse=True
                )
            ]

    def get(self, name: str) -> dict[str, Any] | None:
        with self._lock:
            row = self._entries.get(name)
            return dict(row) if row else None

    def save(self, name: str, state: dict[str, Any]) -> dict[str, Any]:
        name = name.strip()
        if not name:
            raise ValueError("name required")
        if not isinstance(state, dict):
            raise ValueError("state must be an object")
        with self._lock:
            row = {"name": name, "state": state, "saved_at": time.time()}
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

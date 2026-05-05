from __future__ import annotations

import json
import sqlite3
import struct
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Optional

from .embedder import OllamaEmbedder


@dataclass
class MemoryTurn:
    text: str
    role: str                               # "user" | "assistant"
    session_id: str = ""
    tags: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)
    important: bool = False
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    timestamp: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


@dataclass
class MemoryChunk:
    turn: MemoryTurn
    score: float                            # cosine distance (lower = closer)


def _pack(vector: list[float]) -> bytes:
    return struct.pack(f"{len(vector)}f", *vector)


class MemoryStore:
    """sqlite-vec backed memory store. One .db file per registry."""

    def __init__(
        self,
        db_path: str,
        embedder: OllamaEmbedder,
        dimensions: int = 768,
    ) -> None:
        self._path = db_path
        self.embedder = embedder
        self.dimensions = dimensions
        self._db = self._connect()

    def _connect(self) -> sqlite3.Connection:
        try:
            import sqlite_vec
        except ImportError as e:
            raise ImportError(
                "sqlite-vec is required for memory support. "
                "Install it with: pip install 'promptlibretto[memory]'"
            ) from e

        db = sqlite3.connect(self._path)
        db.enable_load_extension(True)
        sqlite_vec.load(db)
        db.enable_load_extension(False)
        db.row_factory = sqlite3.Row

        db.executescript(f"""
            CREATE TABLE IF NOT EXISTS memory_turns (
                id        TEXT PRIMARY KEY,
                session_id TEXT NOT NULL DEFAULT '',
                role      TEXT NOT NULL,
                text      TEXT NOT NULL,
                tags      TEXT NOT NULL DEFAULT '[]',
                timestamp TEXT NOT NULL,
                metadata  TEXT NOT NULL DEFAULT '{{}}',
                important INTEGER NOT NULL DEFAULT 0
            );

            CREATE VIRTUAL TABLE IF NOT EXISTS memory_vss USING vec0(
                turn_id   TEXT,
                embedding float[{self.dimensions}]
            );
        """)
        db.commit()
        return db

    async def upsert(self, turn: MemoryTurn) -> None:
        if not turn.text.strip():
            return
        vector = await self.embedder.embed(turn.text)
        if len(vector) != self.dimensions:
            raise ValueError(
                f"embedding has {len(vector)} dimensions but store expects {self.dimensions}"
            )
        self._db.execute(
            """
            INSERT INTO memory_turns (id, session_id, role, text, tags, timestamp, metadata, important)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                tags=excluded.tags, metadata=excluded.metadata, important=excluded.important
            """,
            (
                turn.id,
                turn.session_id,
                turn.role,
                turn.text,
                json.dumps(turn.tags),
                turn.timestamp,
                json.dumps(turn.metadata),
                int(turn.important),
            ),
        )
        self._db.execute(
            "INSERT OR REPLACE INTO memory_vss (turn_id, embedding) VALUES (?, ?)",
            (turn.id, _pack(vector)),
        )
        self._db.commit()

    async def retrieve(self, query: str, top_k: int = 5) -> list[MemoryChunk]:
        if top_k <= 0 or not query.strip():
            return []
        vector = await self.embedder.embed(query)
        rows = self._db.execute(
            """
            SELECT v.turn_id, v.distance
            FROM memory_vss v
            WHERE v.embedding MATCH ?
              AND k = ?
            ORDER BY v.distance
            """,
            (_pack(vector), top_k),
        ).fetchall()

        chunks: list[MemoryChunk] = []
        for row in rows:
            turn_row = self._db.execute(
                "SELECT * FROM memory_turns WHERE id = ?", (row["turn_id"],)
            ).fetchone()
            if turn_row:
                chunks.append(MemoryChunk(
                    turn=_row_to_turn(turn_row),
                    score=row["distance"],
                ))
        return chunks

    async def forget(self, turn_id: str) -> None:
        self._db.execute("DELETE FROM memory_turns WHERE id = ?", (turn_id,))
        self._db.execute("DELETE FROM memory_vss WHERE turn_id = ?", (turn_id,))
        self._db.commit()

    def prune(self, keep_last: int = 200) -> int:
        """Delete oldest turns beyond keep_last, preserving important=1 rows.
        keep_last=0 clears the entire store. Returns the number of rows deleted."""
        if keep_last == 0:
            count = self._db.execute("SELECT COUNT(*) FROM memory_turns WHERE important = 0").fetchone()[0]
            self._db.execute("DELETE FROM memory_turns WHERE important = 0")
            self._db.execute(
                "DELETE FROM memory_vss WHERE turn_id NOT IN (SELECT id FROM memory_turns)"
            )
            self._db.commit()
            return count

        rows = self._db.execute(
            """
            SELECT id FROM memory_turns
            WHERE important = 0
            ORDER BY timestamp DESC
            LIMIT -1 OFFSET ?
            """,
            (keep_last,),
        ).fetchall()
        if not rows:
            return 0
        ids = [r["id"] for r in rows]
        placeholders = ",".join("?" * len(ids))
        self._db.execute(f"DELETE FROM memory_turns WHERE id IN ({placeholders})", ids)
        self._db.execute(f"DELETE FROM memory_vss WHERE turn_id IN ({placeholders})", ids)
        self._db.commit()
        return len(ids)

    def recent_turns(self, session_id: str, limit: int = 6) -> list[MemoryTurn]:
        """Return the most recent turns for a session, oldest-first."""
        if not session_id or limit <= 0:
            return []
        rows = self._db.execute(
            """
            SELECT * FROM memory_turns
            WHERE session_id = ?
            ORDER BY timestamp DESC
            LIMIT ?
            """,
            (session_id, limit),
        ).fetchall()
        return list(reversed([_row_to_turn(r) for r in rows]))

    def count(self) -> int:
        return self._db.execute("SELECT COUNT(*) FROM memory_turns").fetchone()[0]

    def close(self) -> None:
        self._db.close()

    def __enter__(self) -> "MemoryStore":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()


def _row_to_turn(row: sqlite3.Row) -> MemoryTurn:
    return MemoryTurn(
        id=row["id"],
        session_id=row["session_id"],
        role=row["role"],
        text=row["text"],
        tags=json.loads(row["tags"]),
        timestamp=row["timestamp"],
        metadata=json.loads(row["metadata"]),
        important=bool(row["important"]),
    )

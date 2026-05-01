"""System-prompt summary — a periodically-refreshed compressed version of
the participant's assembled system prompt, EXCLUDING the output-directive
sections (which need to stay precise). Inspection-only for now; future
work can swap it into generation to save context tokens."""
from __future__ import annotations

import json
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

from ..providers.base import ProviderAdapter, ProviderMessage, ProviderRequest


_SYSTEM_GENERIC = (
    "You are a prompt-compression assistant. Compress the provided system prompt "
    "into a shorter form that preserves all critical content (persona, scene, "
    "instructions, tone, character) while cutting redundancy. Reply with ONLY the "
    "compressed text — no preamble, no labels, no quotes, no commentary."
)

_SYSTEM_IN_CHARACTER = """\
You are this character — this is YOU:
{persona}

Below is the FULL system prompt that defines you. Compress it into a shorter version
that preserves your character, your situation, your tone, and any instructions —
but cuts redundancy. The output should still feel like the same character description
when read back. Reply with ONLY the compressed prompt text — no preamble, no quotes,
no meta-commentary."""

_USER = """\
Current compressed version:
{current}

Full system prompt to compress:
{full}

Produce an updated compressed version. Stay under ~{max_tokens} tokens. Reply with
the compressed prompt text only."""


@dataclass
class SystemSummary:
    text: str = ""
    last_updated: str = ""
    update_count: int = 0
    source_chars: int = 0  # length of the prompt that produced this summary

    def to_dict(self) -> dict:
        return {
            "text": self.text,
            "last_updated": self.last_updated,
            "update_count": self.update_count,
            "source_chars": self.source_chars,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "SystemSummary":
        return cls(
            text=str(d.get("text", "")),
            last_updated=str(d.get("last_updated", "")),
            update_count=int(d.get("update_count", 0)),
            source_chars=int(d.get("source_chars", 0)),
        )


class SystemSummaryLayer:
    """File-backed compressed system-prompt cache + LLM-driven update."""

    def __init__(self, path: str) -> None:
        self._path = path
        self._summary: Optional[SystemSummary] = None

    def load(self) -> SystemSummary:
        if os.path.exists(self._path):
            with open(self._path, encoding="utf-8") as f:
                self._summary = SystemSummary.from_dict(json.load(f))
        else:
            self._summary = SystemSummary()
        return self._summary

    @property
    def summary(self) -> SystemSummary:
        if self._summary is None:
            self.load()
        return self._summary  # type: ignore[return-value]

    @property
    def text(self) -> str:
        return self.summary.text

    def save(self) -> None:
        with open(self._path, "w", encoding="utf-8") as f:
            json.dump(self.summary.to_dict(), f, indent=2, ensure_ascii=False)

    def clear(self) -> None:
        self._summary = SystemSummary()
        self.save()

    async def update(
        self,
        full_prompt: str,
        provider: ProviderAdapter,
        model: str,
        max_tokens: int = 300,
        persona: Optional[str] = None,
    ) -> bool:
        """Side-call to refresh the compressed summary. Returns True on change."""
        if not full_prompt or not full_prompt.strip():
            return False

        current = self.summary.text or "(none yet)"

        if persona and persona.strip():
            system_content = _SYSTEM_IN_CHARACTER.format(persona=persona.strip())
            temperature = 0.4
        else:
            system_content = _SYSTEM_GENERIC
            temperature = 0.2

        request = ProviderRequest(
            model=model,
            messages=[
                ProviderMessage(role="system", content=system_content),
                ProviderMessage(
                    role="user",
                    content=_USER.format(
                        current=current,
                        full=full_prompt,
                        max_tokens=max_tokens,
                    ),
                ),
            ],
            temperature=temperature,
            max_tokens=max_tokens + 64,
            timeout_ms=30_000,
        )

        try:
            response = await provider.generate(request)
            updated = response.text.strip()
        except Exception:
            return False

        if not updated or updated == self.summary.text:
            return False

        self.summary.text = updated
        self.summary.last_updated = datetime.now(timezone.utc).isoformat()
        self.summary.update_count += 1
        self.summary.source_chars = len(full_prompt)
        self.save()
        return True

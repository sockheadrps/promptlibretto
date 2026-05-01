"""Working-notes scratchpad — a participant's running summary of the
conversation. Maintained via periodic side-calls to a small LLM. Never
replaces conversation history; injected alongside it as a context block.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Optional

from ..providers.base import ProviderAdapter, ProviderMessage, ProviderRequest

if TYPE_CHECKING:
    from .store import MemoryTurn


_SYSTEM_GENERIC = (
    "You are a working-notes archivist for an AI agent in an ongoing conversation. "
    "Maintain a concise running list of important facts, observations, decisions, and "
    "impressions about the conversation — useful as scratchpad context. "
    "Reply with ONLY the updated notes — no preamble, no labels, no quotes."
)

DEFAULT_ABOUT_ME_PROMPT = (
    "How I'm feeling, my mood, my state, decisions I've made about how to handle this. "
    "Use markdown — short bullets for distinct thoughts, **bold** for things I've decided, "
    "*italic* for emotional texture."
)
DEFAULT_ABOUT_OTHER_PROMPT = (
    "My read on them — what they want, how they're behaving, my opinion of them. "
    "Use markdown — short bullets for distinct observations, **bold** for things I'm sure of, "
    "*italic* for hunches I'm not yet certain about."
)

_SYSTEM_IN_CHARACTER = """\
You are this character — this is YOU:
{persona}

You are keeping your own private running notes during a conversation with someone
named {other_name}. The notes capture YOUR perspective. They are FOR YOU, in your
own voice — first-person internal monologue.

Important about the conversation log below:
- Lines marked "YOU ({self_name}):" are things YOU said.
- Lines marked "{other_name}:" are things {other_name} said.
Never confuse the two. {other_name} is the person you're talking to, not you.

Structure your notes in two clear parts (use these exact headings):

ABOUT ME:
({about_me_prompt})

ABOUT {other_name_upper}:
({about_other_prompt})

Write in your character's voice — sarcasm, frustration, warmth, whatever fits.
Reply with ONLY the updated notes (the two-section block). No preamble, no quotes,
no third-person 'the agent thinks'."""

_USER = """\
Current notes:
{notes}

Recent conversation:
{turns}

Update your notes. Keep what's still important, add what's new and noteworthy, drop
what's no longer relevant. Keep the ABOUT ME / ABOUT {other_name_upper} structure.
Stay under ~{max_tokens} tokens. Reply with only the notes."""


@dataclass
class WorkingNotes:
    text: str = ""
    last_updated: str = ""
    update_count: int = 0

    def to_dict(self) -> dict:
        return {
            "text": self.text,
            "last_updated": self.last_updated,
            "update_count": self.update_count,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "WorkingNotes":
        return cls(
            text=str(d.get("text", "")),
            last_updated=str(d.get("last_updated", "")),
            update_count=int(d.get("update_count", 0)),
        )


class WorkingNotesLayer:
    """Loads/saves a working-notes JSON file and runs LLM-driven updates."""

    def __init__(self, path: str) -> None:
        self._path = path
        self._notes: Optional[WorkingNotes] = None

    def load(self) -> WorkingNotes:
        if os.path.exists(self._path):
            with open(self._path, encoding="utf-8") as f:
                self._notes = WorkingNotes.from_dict(json.load(f))
        else:
            self._notes = WorkingNotes()
        return self._notes

    @property
    def notes(self) -> WorkingNotes:
        if self._notes is None:
            self.load()
        return self._notes  # type: ignore[return-value]

    @property
    def text(self) -> str:
        return self.notes.text

    def save(self) -> None:
        with open(self._path, "w", encoding="utf-8") as f:
            json.dump(self.notes.to_dict(), f, indent=2, ensure_ascii=False)

    def clear(self) -> None:
        self._notes = WorkingNotes()
        self.save()

    async def update(
        self,
        recent_turns: list["MemoryTurn"],
        provider: ProviderAdapter,
        model: str,
        max_tokens: int = 200,
        persona: Optional[str] = None,
        self_name: str = "you",
        other_name: str = "the other person",
        about_me_prompt: Optional[str] = None,
        about_other_prompt: Optional[str] = None,
    ) -> bool:
        """Side-call to refresh the notes. Returns True if the file changed.

        When `persona` is provided, the notes are written in-character — first
        person, in the participant's voice. `self_name` / `other_name` are
        used to label conversation turns unambiguously and to structure the
        output into ABOUT ME / ABOUT <OTHER> sections.
        """
        if not recent_turns:
            return False

        # Label turns by name so the model can't confuse who said what.
        # Each participant's store records own turns as role="assistant"
        # and other-speaker turns as role="user".
        def _label(t: "MemoryTurn") -> str:
            return f"YOU ({self_name})" if t.role == "assistant" else other_name
        turns_text = "\n".join(f"{_label(t)}: {t.text}" for t in recent_turns[-12:])
        current = self.notes.text or "(none yet)"

        if persona and persona.strip():
            system_content = _SYSTEM_IN_CHARACTER.format(
                persona=persona.strip(),
                self_name=self_name,
                other_name=other_name,
                other_name_upper=other_name.upper(),
                about_me_prompt=(about_me_prompt or DEFAULT_ABOUT_ME_PROMPT).strip(),
                about_other_prompt=(about_other_prompt or DEFAULT_ABOUT_OTHER_PROMPT).strip(),
            )
            temperature = 0.7  # let voice come through
        else:
            system_content = _SYSTEM_GENERIC
            temperature = 0.3

        request = ProviderRequest(
            model=model,
            messages=[
                ProviderMessage(role="system", content=system_content),
                ProviderMessage(
                    role="user",
                    content=_USER.format(
                        notes=current,
                        turns=turns_text,
                        max_tokens=max_tokens,
                        other_name_upper=other_name.upper(),
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

        if not updated or updated == self.notes.text:
            return False

        self.notes.text = updated
        self.notes.last_updated = datetime.now(timezone.utc).isoformat()
        self.notes.update_count += 1
        self.save()
        return True

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any, Optional

from ..providers.base import ProviderAdapter, ProviderMessage, ProviderRequest
from ..registry.hydrate import HydrateState

if TYPE_CHECKING:
    from .store import MemoryTurn

_AMEND_SYSTEM = (
    "You are a personality archivist. "
    "Given a conversation and an existing personality profile, identify any NEW insight "
    "about this character's personality, preferences, quirks, or tendencies that is NOT "
    "already captured in the profile. "
    "Reply with a single concise observation (1-2 sentences), or exactly 'nothing new' if "
    "there is nothing to add. No preamble, no labels."
)

_AMEND_USER = """\
Current profile:
{assembled}

Recent conversation:
{turns}

What new personality insight, if any, does this conversation reveal?"""

_TVAR_KEY = "base_context::personality_context"


@dataclass
class Amendment:
    timestamp: str
    text: str
    source_session: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "timestamp": self.timestamp,
            "text": self.text,
            "source_session": self.source_session,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "Amendment":
        return cls(
            timestamp=d.get("timestamp", ""),
            text=d.get("text", ""),
            source_session=d.get("source_session", ""),
        )


@dataclass
class PersonalityProfile:
    version: int = 1
    seed: str = ""
    amendments: list[Amendment] = field(default_factory=list)
    assembled: str = ""

    def rebuild(self) -> None:
        parts = [self.seed] + [a.text for a in self.amendments if a.text.strip()]
        self.assembled = " ".join(p.strip() for p in parts if p.strip())

    def to_dict(self) -> dict[str, Any]:
        return {
            "version": self.version,
            "seed": self.seed,
            "amendments": [a.to_dict() for a in self.amendments],
            "assembled": self.assembled,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "PersonalityProfile":
        return cls(
            version=int(d.get("version", 1)),
            seed=str(d.get("seed", "")),
            amendments=[Amendment.from_dict(a) for a in (d.get("amendments") or [])],
            assembled=str(d.get("assembled", "")),
        )


class PersonalityLayer:
    """Loads/saves a personality JSON file and can merge it into HydrateState."""

    def __init__(self, path: str) -> None:
        self._path = path
        self._profile: Optional[PersonalityProfile] = None

    def load(self) -> PersonalityProfile:
        if os.path.exists(self._path):
            with open(self._path, encoding="utf-8") as f:
                self._profile = PersonalityProfile.from_dict(json.load(f))
        else:
            self._profile = PersonalityProfile()
        return self._profile

    @property
    def profile(self) -> PersonalityProfile:
        if self._profile is None:
            self.load()
        return self._profile  # type: ignore[return-value]

    def merge_into_state(self, state: HydrateState) -> HydrateState:
        assembled = self.profile.assembled
        if not assembled:
            return state
        tvars = dict(state.template_vars or {})
        tvars[_TVAR_KEY] = assembled
        return HydrateState(
            selections=state.selections,
            array_modes=state.array_modes,
            section_random=state.section_random,
            sliders=state.sliders,
            slider_random=state.slider_random,
            template_vars=tvars,
        )

    def save(self) -> None:
        self.profile.rebuild()
        with open(self._path, "w", encoding="utf-8") as f:
            json.dump(self.profile.to_dict(), f, indent=2, ensure_ascii=False)

    async def amend(
        self,
        session_turns: list[MemoryTurn],
        provider: ProviderAdapter,
        model: str = "llama3.2:1b",
        session_id: str = "",
    ) -> bool:
        if not session_turns:
            return False

        assembled = self.profile.assembled or self.profile.seed or "(empty)"
        turns_text = "\n".join(
            f"[{t.role}] {t.text}" for t in session_turns[-12:]
        )

        request = ProviderRequest(
            model=model,
            messages=[
                ProviderMessage(role="system", content=_AMEND_SYSTEM),
                ProviderMessage(
                    role="user",
                    content=_AMEND_USER.format(
                        assembled=assembled, turns=turns_text
                    ),
                ),
            ],
            temperature=0.3,
            max_tokens=128,
            timeout_ms=20_000,
        )

        try:
            response = await provider.generate(request)
            observation = response.text.strip()
        except Exception:
            return False

        if not observation or observation.lower().startswith("nothing new"):
            return False

        self.profile.amendments.append(
            Amendment(
                timestamp=datetime.now(timezone.utc).isoformat(),
                text=observation,
                source_session=session_id,
            )
        )
        self.save()
        return True

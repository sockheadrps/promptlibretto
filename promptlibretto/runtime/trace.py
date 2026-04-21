from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Any, Optional, Sequence


@dataclass
class GenerationAttempt:
    raw: str
    cleaned: str
    accepted: bool
    reject_reason: Optional[str] = None


@dataclass
class GenerationTrace:
    route: str
    active_context: str
    user_prompt: str
    system_prompt: Optional[str] = None
    injections: Sequence[str] = field(default_factory=tuple)
    config: dict = field(default_factory=dict)
    output_raw: str = ""
    output_final: str = ""
    attempts: list[GenerationAttempt] = field(default_factory=list)
    usage: Optional[dict] = None
    timing: Optional[dict] = None
    metadata: dict = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "route": self.route,
            "active_context": self.active_context,
            "user_prompt": self.user_prompt,
            "system_prompt": self.system_prompt,
            "injections": list(self.injections),
            "config": self.config,
            "output_raw": self.output_raw,
            "output_final": self.output_final,
            "attempts": [asdict(a) for a in self.attempts],
            "usage": self.usage,
            "timing": self.timing,
            "metadata": self.metadata,
        }

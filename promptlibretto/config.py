from __future__ import annotations

from dataclasses import dataclass, replace, asdict
from typing import Any, Mapping, Optional


@dataclass(frozen=True)
class GenerationConfig:
    # `provider` is informational only — it reflects the ProviderAdapter the
    # engine was built with (set by PromptEngine on construction). Setting it
    # here does NOT switch providers; pass `provider=` to PromptEngine for that.
    provider: str = "ollama"
    model: str = "default"
    temperature: float = 0.8
    top_p: Optional[float] = None
    top_k: Optional[int] = None
    max_tokens: int = 256
    repeat_penalty: Optional[float] = None
    timeout_ms: int = 60_000
    retries: int = 1
    max_prompt_chars: Optional[int] = None

    def merged_with(self, overrides: Optional[Mapping[str, Any]]) -> "GenerationConfig":
        if not overrides:
            return self
        known_fields = set(asdict(self).keys())
        unknown = [k for k in overrides if k not in known_fields]
        if unknown:
            raise ValueError(
                f"unknown GenerationConfig fields: {unknown} (known: {sorted(known_fields)})"
            )
        return replace(self, **dict(overrides))

    def to_dict(self) -> dict:
        return asdict(self)

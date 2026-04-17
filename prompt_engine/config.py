from __future__ import annotations

from dataclasses import dataclass, replace, asdict
from typing import Any, Mapping, Optional


@dataclass(frozen=True)
class GenerationConfig:
    provider: str = "ollama"
    model: str = "default"
    temperature: float = 0.8
    top_p: Optional[float] = None
    top_k: Optional[int] = None
    max_tokens: int = 256
    repeat_penalty: Optional[float] = None
    timeout_ms: int = 60_000
    retries: int = 1
    lock_params: bool = False
    max_prompt_chars: Optional[int] = None

    def merged_with(self, overrides: Optional[Mapping[str, Any]]) -> "GenerationConfig":
        if not overrides:
            return self
        known = {f: overrides[f] for f in asdict(self).keys() if f in overrides}
        return replace(self, **known)

    def to_dict(self) -> dict:
        return asdict(self)

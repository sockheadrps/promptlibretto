from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Optional, Protocol, Sequence


@dataclass
class ProviderMessage:
    role: str  # "system" | "user" | "assistant"
    content: str


@dataclass
class ProviderRequest:
    model: str
    messages: Sequence[ProviderMessage]
    temperature: float
    max_tokens: int
    top_p: Optional[float] = None
    top_k: Optional[int] = None
    repeat_penalty: Optional[float] = None
    timeout_ms: int = 60_000


@dataclass
class ProviderUsage:
    prompt_tokens: Optional[int] = None
    completion_tokens: Optional[int] = None
    total_tokens: Optional[int] = None


@dataclass
class ProviderTiming:
    total_ms: Optional[float] = None
    load_ms: Optional[float] = None
    prompt_eval_ms: Optional[float] = None
    eval_ms: Optional[float] = None


@dataclass
class ProviderResponse:
    text: str
    usage: ProviderUsage = field(default_factory=ProviderUsage)
    timing: ProviderTiming = field(default_factory=ProviderTiming)
    raw: Any = None


class ProviderAdapter(Protocol):
    async def generate(self, request: ProviderRequest) -> ProviderResponse: ...


@dataclass
class ProviderStreamChunk:
    text: str
    done: bool = False
    response: Optional[ProviderResponse] = None


class StreamingProviderAdapter(ProviderAdapter, Protocol):
    """Provider extension that yields incremental chunks. The final chunk has
    `done=True` and a `response` holding aggregated text/usage/timing.
    """

    def stream(
        self, request: ProviderRequest
    ) -> AsyncIterator["ProviderStreamChunk"]: ...


def supports_streaming(provider: ProviderAdapter) -> bool:
    return callable(getattr(provider, "stream", None))

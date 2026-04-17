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
    stream: bool = False
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
    """Wraps a model backend behind a normalized request/response.

    Providers MUST implement `generate`. Streaming is optional: providers
    that support it implement `stream`, which yields text chunks as they
    arrive and returns a final `ProviderResponse` via `StopAsyncIteration`'s
    value — or more pragmatically, callers use `supports_streaming()` to
    check and fall back to `generate` otherwise.
    """

    async def generate(self, request: ProviderRequest) -> ProviderResponse: ...


@dataclass
class ProviderStreamChunk:
    text: str
    done: bool = False
    # Populated on the final chunk; callers can read usage/timing there.
    response: Optional[ProviderResponse] = None


class StreamingProviderAdapter(ProviderAdapter, Protocol):
    """Optional extension: providers that can emit incremental chunks.

    Implementers yield `ProviderStreamChunk` as tokens arrive. The final
    chunk has `done=True` and a `response` holding the aggregated text,
    usage, and timing so downstream processors have the same shape they'd
    see from `generate`.
    """

    def stream(
        self, request: ProviderRequest
    ) -> AsyncIterator["ProviderStreamChunk"]: ...


def supports_streaming(provider: ProviderAdapter) -> bool:
    return callable(getattr(provider, "stream", None))

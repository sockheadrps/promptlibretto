"""Middleware hooks around PromptEngine.generate_once.

A middleware is any object implementing `before` and/or `after`:

    class Middleware(Protocol):
        async def before(self, request): ...         # may return a new request
        async def after(self, request, result): ...  # may return a new result

Either method can be sync or async. Returning `None` means "pass through".
Middlewares run in registration order around `generate_once` — outer
middleware wraps inner — so a logging middleware registered first sees the
final (post-middleware) request going out and the final result coming back.

This is deliberately small. It does NOT intercept provider calls directly,
add retry semantics, or expose the build pipeline. Use it for cross-cutting
concerns (logging, metrics, caching, rate-limiting, redaction) that don't
need to mutate prompt construction itself.
"""
from __future__ import annotations

import inspect
from typing import Any, Optional, Protocol


class Middleware(Protocol):
    async def before(self, request: Any) -> Optional[Any]: ...
    async def after(self, request: Any, result: Any) -> Optional[Any]: ...


async def _maybe_await(value: Any) -> Any:
    if inspect.isawaitable(value):
        return await value
    return value


async def apply_before(middlewares: list[Any], request: Any) -> Any:
    current = request
    for mw in middlewares:
        fn = getattr(mw, "before", None)
        if fn is None:
            continue
        returned = await _maybe_await(fn(current))
        if returned is not None:
            current = returned
    return current


async def apply_after(middlewares: list[Any], request: Any, result: Any) -> Any:
    current = result
    # Reverse order on the way out so outer middleware sees the final result.
    for mw in reversed(middlewares):
        fn = getattr(mw, "after", None)
        if fn is None:
            continue
        returned = await _maybe_await(fn(request, current))
        if returned is not None:
            current = returned
    return current

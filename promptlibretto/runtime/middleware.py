"""Middleware hooks around PromptEngine.generate_once / generate_stream.

A middleware is any object with a `before(request)` and/or `after(request, result)`
method (sync or async). Return `None` to pass through, or a new value to replace.
Middlewares run in registration order on the way in, reverse on the way out.
"""
from __future__ import annotations

import inspect
from typing import Any


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
    for mw in reversed(middlewares):
        fn = getattr(mw, "after", None)
        if fn is None:
            continue
        returned = await _maybe_await(fn(request, current))
        if returned is not None:
            current = returned
    return current

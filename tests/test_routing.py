from __future__ import annotations

import pytest

from promptlibretto import (
    CompositeBuilder,
    GenerationRequest,
    PromptRoute,
    PromptRouter,
    section,
)
from promptlibretto.context.overlay import ContextSnapshot


def _builder(name="t"):
    return CompositeBuilder(name=name, user_sections=(section("Q"),))


def _snap():
    return ContextSnapshot(base="", active="")


def test_router_mode_forces_route():
    router = PromptRouter(default_route="default")
    router.register(PromptRoute(name="default", builder=_builder("default")))
    router.register(PromptRoute(name="other", builder=_builder("other")))
    picked = router.select(_snap(), GenerationRequest(mode="other"))
    assert picked.name == "other"


def test_router_applies_predicate():
    router = PromptRouter(default_route="fallback")
    router.register(PromptRoute(
        name="special",
        builder=_builder("special"),
        priority=10,
        applies=lambda snap, req: req.inputs.get("flag") == "on",
    ))
    router.register(PromptRoute(name="fallback", builder=_builder("fallback")))
    on = router.select(_snap(), GenerationRequest(inputs={"flag": "on"}))
    off = router.select(_snap(), GenerationRequest(inputs={"flag": "off"}))
    assert on.name == "special"
    assert off.name == "fallback"


def test_router_rejects_duplicate_registration():
    router = PromptRouter()
    router.register(PromptRoute(name="a", builder=_builder("a")))
    with pytest.raises(ValueError):
        router.register(PromptRoute(name="a", builder=_builder("a")))

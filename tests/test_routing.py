from __future__ import annotations

from dataclasses import dataclass, field

import pytest

from prompt_engine import (
    CompositeBuilder,
    GenerationRequest,
    InputValidationError,
    PromptRoute,
    PromptRouter,
    section,
)
from prompt_engine.context.overlay import ContextSnapshot


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


# --- typed inputs -----------------------------------------------------------

@dataclass
class AnalystInputs:
    topic: str
    tone: str = "neutral"
    tags: list[str] = field(default_factory=list)


def test_required_inputs_reads_dataclass():
    route = PromptRoute(name="analyst", builder=_builder(), inputs_schema=AnalystInputs)
    assert route.required_inputs() == ["topic"]


def test_validate_inputs_raises_on_missing_field():
    route = PromptRoute(name="analyst", builder=_builder(), inputs_schema=AnalystInputs)
    with pytest.raises(InputValidationError) as exc:
        route.validate_inputs({"tone": "crisp"})
    assert exc.value.route == "analyst"
    assert exc.value.missing == ["topic"]


def test_validate_inputs_accepts_extras():
    route = PromptRoute(name="analyst", builder=_builder(), inputs_schema=AnalystInputs)
    # extras beyond the schema are fine — contract is additive
    route.validate_inputs({"topic": "X", "whatever": 1})


def test_validate_inputs_noop_without_schema():
    route = PromptRoute(name="loose", builder=_builder())
    route.validate_inputs(None)
    route.validate_inputs({})


async def test_engine_surfaces_input_validation_error(make_engine_fn):
    @dataclass
    class Needs:
        question: str

    builder = CompositeBuilder(
        name="strict",
        user_sections=(section(lambda c: c.request.inputs.get("question", "")),),
    )
    route = PromptRoute(name="strict", builder=builder, inputs_schema=Needs)
    engine = make_engine_fn(routes=[route], default_route="strict")
    with pytest.raises(InputValidationError) as exc:
        await engine.generate_once(GenerationRequest(mode="strict", inputs={}))
    assert "question" in exc.value.missing

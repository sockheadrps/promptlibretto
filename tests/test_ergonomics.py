from __future__ import annotations

import pytest

from promptlibretto import (
    CompositeBuilder,
    ContextStore,
    GenerationConfig,
    GenerationRequest,
    MockProvider,
    PromptEngine,
    PromptRoute,
    PromptRouter,
    section,
)


async def test_minimal_engine_only_requires_routes():
    engine = PromptEngine(routes={"default": "Say hi."})
    result = await engine.generate_once()
    assert result.accepted is True
    assert "Say hi." in result.text


async def test_engine_accepts_string_request():
    engine = PromptEngine(routes={"default": [section(lambda c: c.request.inputs["input"])]})
    result = await engine.generate_once("hello world")
    assert "hello world" in result.text


async def test_engine_accepts_dict_request():
    engine = PromptEngine(routes={"default": "Q"})
    result = await engine.generate_once({"debug": True})
    assert result.trace is not None


async def test_engine_accepts_dict_config():
    engine = PromptEngine(routes={"default": "Q"}, config={"temperature": 0.4, "max_tokens": 32})
    assert engine.config.temperature == 0.4
    assert engine.config.max_tokens == 32
    assert engine.config.provider == "mock"


def test_engine_accepts_string_context_store():
    engine = PromptEngine(routes={"default": "Q"}, context_store="BASE_TEXT")
    assert engine.context_store.get_state().base == "BASE_TEXT"


def test_engine_accepts_multiple_routes_as_dict():
    engine = PromptEngine(routes={"a": "Alpha", "b": "Beta"})
    names = [r.name for r in engine.router.routes()]
    assert names == ["a", "b"]


def test_engine_accepts_list_of_promptroutes():
    routes = [
        PromptRoute(name="x", builder=CompositeBuilder(name="x", user_sections=(section("X"),))),
        PromptRoute(name="y", builder=CompositeBuilder(name="y", user_sections=(section("Y"),))),
    ]
    engine = PromptEngine(routes=routes)
    assert [r.name for r in engine.router.routes()] == ["x", "y"]


def test_engine_accepts_builder_instance_in_routes():
    b = CompositeBuilder(name="custom", user_sections=(section("done"),))
    engine = PromptEngine(routes={"custom": b})
    assert engine.router.get("custom").builder is b


def test_engine_accepts_mapping_for_route_builder_kwargs():
    engine = PromptEngine(routes={
        "r": {
            "system_sections": ["You are terse."],
            "user_sections": ["Q"],
            "generation_overrides": {"temperature": 0.1},
        }
    })
    route = engine.router.get("r")
    assert route.builder.generation_overrides == {"temperature": 0.1}


def test_engine_passthrough_of_existing_types_is_unchanged():
    config = GenerationConfig(provider="mock", model="m", max_tokens=10)
    store = ContextStore(base="B")
    router = PromptRouter(default_route="d")
    router.register(PromptRoute(name="d", builder=CompositeBuilder(name="d", user_sections=(section("q"),))))
    engine = PromptEngine(
        config=config,
        context_store=store,
        router=router,
        provider=MockProvider(),
    )
    assert engine.config is config
    assert engine.context_store is store
    assert engine.router is router


async def test_default_engine_with_no_args_runs():
    engine = PromptEngine()
    result = await engine.generate_once("ping")
    assert result.accepted is True


def test_unknown_provider_string_raises():
    with pytest.raises(ValueError):
        PromptEngine(provider="nonexistent", routes={"default": "Q"})

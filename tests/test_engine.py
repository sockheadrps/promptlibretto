from __future__ import annotations

import pytest

from promptlibretto import (
    CompositeBuilder,
    GenerationConfig,
    GenerationRequest,
    PromptRoute,
    section,
)


async def test_generate_once_returns_cleaned_text(engine):
    result = await engine.generate_once(GenerationRequest(inputs={"input": "ping"}))
    assert result.accepted is True
    assert result.route == "default"
    assert "ping" in result.text


async def test_debug_trace_populated(engine):
    result = await engine.generate_once(GenerationRequest(inputs={"input": "hi"}, debug=True))
    assert result.trace is not None
    assert result.trace.route == "default"
    assert "hi" in result.trace.user_prompt
    assert result.trace.system_prompt
    assert len(result.trace.attempts) >= 1


async def test_request_config_overrides_win_over_route_defaults(make_engine_fn):
    seen = {}

    def responder(request):
        seen["temperature"] = request.temperature
        seen["max_tokens"] = request.max_tokens
        return "ok"

    builder = CompositeBuilder(
        name="default",
        user_sections=(section(lambda ctx: ctx.request.inputs.get("input", "")),),
        generation_overrides={"temperature": 0.2, "max_tokens": 10},
    )
    engine = make_engine_fn(
        responder=responder,
        config=GenerationConfig(
            provider="mock",
            model="m",
            temperature=0.7,
            max_tokens=64,
        ),
        routes=[PromptRoute(name="default", builder=builder)],
    )

    result = await engine.generate_once(
        GenerationRequest(
            inputs={"input": "hello"},
            debug=True,
            config_overrides={"temperature": 0.95, "max_tokens": 123},
        )
    )

    assert seen == {"temperature": 0.95, "max_tokens": 123}
    assert result.trace.config["temperature"] == 0.95
    assert result.trace.config["max_tokens"] == 123
    assert result.trace.metadata["config_layers"]["base_config"]["temperature"] == 0.7
    assert result.trace.metadata["config_layers"]["package_overrides"] == {
        "temperature": 0.2,
        "max_tokens": 10,
    }
    assert result.trace.metadata["config_layers"]["request_overrides"] == {
        "temperature": 0.95,
        "max_tokens": 123,
    }
    assert result.usage["completion_tokens"] is not None
    assert result.timing["total_ms"] is not None
    assert engine.config.temperature == 0.7
    assert engine.config.max_tokens == 64

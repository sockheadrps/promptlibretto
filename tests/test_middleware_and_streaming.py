from __future__ import annotations

from promptlibretto import GenerationRequest


async def test_middleware_before_and_after_fire(make_engine_fn):
    events: list[tuple[str, ...]] = []

    class Recorder:
        async def before(self, request):
            events.append(("before", request.mode or ""))

        async def after(self, request, result):
            events.append(("after", result.route, result.accepted))

    engine = make_engine_fn(middlewares=[Recorder()])
    await engine.generate_once(GenerationRequest(mode="default", inputs={"input": "hi"}))
    assert events[0] == ("before", "default")
    assert events[1][0] == "after"
    assert events[1][1] == "default"
    assert events[1][2] is True


async def test_middleware_can_replace_request(make_engine_fn):
    class Rewriter:
        async def before(self, request):
            return GenerationRequest(
                mode=request.mode,
                inputs={**request.inputs, "input": "REWRITTEN"},
                injections=request.injections,
                debug=request.debug,
            )

    engine = make_engine_fn(middlewares=[Rewriter()])
    result = await engine.generate_once(GenerationRequest(inputs={"input": "original"}))
    assert "REWRITTEN" in result.text
    assert "original" not in result.text


async def test_middleware_ordering_reverse_on_after(make_engine_fn):
    order: list[str] = []

    def factory(name):
        class M:
            async def before(self, request):
                order.append(f"before:{name}")

            async def after(self, request, result):
                order.append(f"after:{name}")

        return M()

    engine = make_engine_fn(middlewares=[factory("outer"), factory("inner")])
    await engine.generate_once(GenerationRequest(inputs={"input": "x"}))
    assert order == ["before:outer", "before:inner", "after:inner", "after:outer"]


async def test_stream_emits_deltas_and_terminal_result(make_engine_fn):
    engine = make_engine_fn()
    deltas = []
    final = None
    async for chunk in engine.generate_stream(GenerationRequest(inputs={"input": "alpha beta gamma"})):
        if chunk.done:
            final = chunk.result
        elif chunk.delta:
            deltas.append(chunk.delta)
    assert len(deltas) > 1
    assert final is not None
    assert final.accepted is True
    assert "alpha" in final.text
    assert final.usage["completion_tokens"] is not None
    assert final.timing["total_ms"] is not None


async def test_stream_applies_middleware(make_engine_fn):
    events: list[str] = []

    class Tag:
        async def before(self, req):
            events.append("before")

        async def after(self, req, res):
            events.append("after")

    engine = make_engine_fn(middlewares=[Tag()])
    async for chunk in engine.generate_stream(GenerationRequest(inputs={"input": "q"})):
        if chunk.done:
            break
    assert events == ["before", "after"]

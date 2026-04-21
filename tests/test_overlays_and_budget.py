from __future__ import annotations

from promptlibretto import (
    ContextOverlay,
    ContextStore,
    GenerationConfig,
    GenerationRequest,
    make_turn_overlay,
)


def test_overlay_priority_ordering_in_active():
    store = ContextStore(base="BASE")
    store.set_overlay("low", ContextOverlay(text="L", priority=1))
    store.set_overlay("high", ContextOverlay(text="H", priority=10))
    active = store.get_active()
    # higher priority appears before lower
    assert active.index("H") < active.index("L")
    assert active.startswith("BASE")


def test_expired_overlay_is_dropped():
    store = ContextStore()
    store.set_overlay("stale", ContextOverlay(text="stale", expires_at=100.0))
    snap = store.get_state(now=200.0)
    assert "stale" not in snap.overlays
    assert "stale" not in snap.active


def test_snapshot_with_overlays_returns_new_snapshot():
    store = ContextStore(base="BASE")
    store.set_overlay("a", ContextOverlay(text="OVERLAY_A", priority=1))
    store.set_overlay("b", ContextOverlay(text="OVERLAY_B", priority=5))
    snap = store.get_state()
    trimmed = snap.with_overlays({"b": snap.overlays["b"]})
    assert "OVERLAY_A" not in trimmed.active
    assert "OVERLAY_B" in trimmed.active
    # original snapshot unchanged
    assert "OVERLAY_A" in snap.active


def test_make_turn_overlay_preserves_verbatim():
    overlay = make_turn_overlay("original long text", compacted="short", priority=7)
    assert overlay.text == "short"
    assert overlay.metadata["verbatim"] == "original long text"
    assert overlay.metadata["compacted"] == "short"
    assert overlay.metadata["kind"] == "turn"
    assert overlay.priority == 7


def test_make_turn_overlay_without_compaction():
    overlay = make_turn_overlay("just verbatim")
    assert overlay.text == "just verbatim"
    assert "compacted" not in overlay.metadata


async def test_budget_drops_lowest_priority_first(make_engine_fn):
    engine = make_engine_fn(
        config=GenerationConfig(provider="mock", model="m", max_prompt_chars=80),
    )
    store = engine.context_store
    store.set_overlay("low", ContextOverlay(text="L" * 100, priority=1))
    store.set_overlay("mid", ContextOverlay(text="M" * 100, priority=5))
    store.set_overlay("high", ContextOverlay(text="H" * 100, priority=10))
    result = await engine.generate_once(GenerationRequest(inputs={"input": "q"}, debug=True))
    budget = result.trace.metadata["budget"]
    # lowest-priority overlay goes first, then mid; high is last to drop
    assert budget["dropped"][0] == "low"
    assert "high" not in budget["dropped"] or budget["dropped"].index("high") > budget["dropped"].index("mid")
    assert budget["budget_chars"] == 80


async def test_budget_reports_over_budget_when_overlays_exhausted(make_engine_fn):
    engine = make_engine_fn(
        config=GenerationConfig(provider="mock", model="m", max_prompt_chars=10),
    )
    result = await engine.generate_once(GenerationRequest(inputs={"input": "x" * 200}, debug=True))
    budget = result.trace.metadata["budget"]
    assert budget["over_budget"] is True

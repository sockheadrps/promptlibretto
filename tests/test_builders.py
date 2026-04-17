from __future__ import annotations

from prompt_engine import (
    CompositeBuilder,
    ContextOverlay,
    ContextStore,
    GenerationRequest,
    PromptAssetRegistry,
    section,
)
from prompt_engine.builders.builder import BuildContext
from prompt_engine.random_source import DefaultRandom


def _build(builder: CompositeBuilder, *, store: ContextStore | None = None, inputs=None, injections=()):
    store = store or ContextStore()
    snap = store.get_state()
    ctx = BuildContext(
        snapshot=snap,
        request=GenerationRequest(inputs=inputs or {}),
        assets=PromptAssetRegistry(),
        random=DefaultRandom(),
        injections=injections,
    )
    return builder.build(ctx)


def test_composite_skips_empty_sections():
    builder = CompositeBuilder(
        name="t",
        user_sections=(
            section(lambda c: ""),
            section(lambda c: "keep"),
            section(lambda c: "   "),
            section(lambda c: "also"),
        ),
    )
    pkg = _build(builder)
    assert pkg.user == "keep\n\nalso"


def test_composite_prepends_active_context():
    store = ContextStore(base="BASE")
    store.set_overlay("o", ContextOverlay(text="OVER", priority=5))
    builder = CompositeBuilder(
        name="t",
        user_sections=(section(lambda c: "Q"),),
    )
    pkg = _build(builder, store=store)
    # base + overlay are both in snapshot.active, which prepends the user text
    assert "BASE" in pkg.user
    assert "OVER" in pkg.user
    assert pkg.user.endswith("Q")


def test_composite_can_disable_context_and_injections():
    store = ContextStore(base="BASE")
    builder = CompositeBuilder(
        name="t",
        user_sections=(section("Q"),),
        include_active_context=False,
        include_injections=False,
    )
    pkg = _build(builder, store=store)
    assert "BASE" not in pkg.user
    assert pkg.user == "Q"


def test_generation_overrides_propagate():
    builder = CompositeBuilder(
        name="t",
        user_sections=(section("Q"),),
        generation_overrides={"temperature": 0.1, "max_tokens": 999},
    )
    pkg = _build(builder)
    assert pkg.generation_overrides == {"temperature": 0.1, "max_tokens": 999}

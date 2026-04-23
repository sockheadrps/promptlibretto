from __future__ import annotations

from typing import Callable, Optional

import pytest

from promptlibretto import (
    CompositeBuilder,
    ContextStore,
    GenerationConfig,
    MockProvider,
    OutputProcessor,
    PromptAssetRegistry,
    PromptEngine,
    PromptRoute,
    PromptRouter,
    section,
)
from promptlibretto.providers.base import ProviderRequest


def make_engine(
    *,
    responder: Optional[Callable[[ProviderRequest], str]] = None,
    config: Optional[GenerationConfig] = None,
    routes: Optional[list[PromptRoute]] = None,
    default_route: str = "default",
    base: str = "",
    middlewares: Optional[list] = None,
) -> PromptEngine:
    cfg = config or GenerationConfig(provider="mock", model="m", max_tokens=64)
    store = ContextStore(base=base)
    assets = PromptAssetRegistry()
    router = PromptRouter(default_route=default_route)
    if routes:
        router.register_many(routes)
    else:
        builder = CompositeBuilder(
            name="default",
            system_sections=(section("You are a test bot."),),
            user_sections=(section(lambda ctx: ctx.request.inputs.get("input", "")),),
        )
        router.register(PromptRoute(name="default", builder=builder))
    provider = MockProvider(responder=responder, latency_ms=0.0)
    return PromptEngine(
        config=cfg,
        context_store=store,
        asset_registry=assets,
        router=router,
        provider=provider,
        output_processor=OutputProcessor(),
        middlewares=middlewares,
    )


@pytest.fixture
def engine() -> PromptEngine:
    return make_engine()


@pytest.fixture
def make_engine_fn():
    return make_engine

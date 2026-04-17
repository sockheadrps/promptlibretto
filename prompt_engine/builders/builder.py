from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping, Optional, Protocol, Sequence

from ..assets.registry import PromptAssetRegistry, PromptInjection
from ..context.overlay import ContextSnapshot
from ..random_source import RandomSource


@dataclass
class GenerationRequest:
    """Request entering the engine.

    `mode` is an optional explicit route override. `inputs` are slot values
    or builder-specific arguments. `injections` lists named injectors the
    caller wants applied (the router/builder may add more).
    """

    mode: Optional[str] = None
    inputs: Mapping[str, Any] = field(default_factory=dict)
    injections: Sequence[str] = field(default_factory=tuple)
    metadata: Mapping[str, Any] = field(default_factory=dict)
    debug: bool = False
    config_overrides: Mapping[str, Any] = field(default_factory=dict)


@dataclass
class PromptPackage:
    """Builder output: ready-to-send messages plus optional overrides."""

    route: str
    user: str
    system: Optional[str] = None
    metadata: Mapping[str, Any] = field(default_factory=dict)
    generation_overrides: Mapping[str, Any] = field(default_factory=dict)
    output_policy: Mapping[str, Any] = field(default_factory=dict)
    injections: Sequence[PromptInjection] = field(default_factory=tuple)


class BuildContext:
    """Helper passed to builders so they don't need to remember positional args."""

    def __init__(
        self,
        snapshot: ContextSnapshot,
        request: GenerationRequest,
        assets: PromptAssetRegistry,
        random: RandomSource,
        injections: Sequence[PromptInjection],
    ):
        self.snapshot = snapshot
        self.request = request
        self.assets = assets
        self.random = random
        self.injections = list(injections)


class PromptBuilder(Protocol):
    """A builder converts BuildContext into a PromptPackage.

    Implementations should be small and pure — no I/O, no engine state mutation.
    """

    def build(self, ctx: BuildContext) -> PromptPackage: ...

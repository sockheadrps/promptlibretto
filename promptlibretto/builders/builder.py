from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping, Optional, Sequence

from ..assets.registry import PromptAssetRegistry, PromptInjection
from ..context.overlay import ContextSnapshot
from ..random_source import RandomSource


@dataclass
class GenerationRequest:
    """Request entering the engine.

    `section_overrides` is an escape hatch: when keys `"system"` or `"user"`
    are present, the corresponding side of the built `PromptPackage` is
    REPLACED wholesale. This bypasses normal context injection, asset
    interpolation, and the route's section pipeline for the overridden side
    only — use it for tests or one-off manual prompts, not for routine
    composition.
    """

    mode: Optional[str] = None
    inputs: Mapping[str, Any] = field(default_factory=dict)
    injections: Sequence[str] = field(default_factory=tuple)
    metadata: Mapping[str, Any] = field(default_factory=dict)
    debug: bool = False
    config_overrides: Mapping[str, Any] = field(default_factory=dict)
    section_overrides: Mapping[str, str] = field(default_factory=dict)


@dataclass
class PromptPackage:
    """Builder output: messages plus optional generation/policy overrides."""

    route: str
    user: str
    system: Optional[str] = None
    metadata: Mapping[str, Any] = field(default_factory=dict)
    generation_overrides: Mapping[str, Any] = field(default_factory=dict)
    output_policy: Mapping[str, Any] = field(default_factory=dict)
    injections: Sequence[PromptInjection] = field(default_factory=tuple)


class BuildContext:
    """Aggregates the inputs a builder / section callable needs."""

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

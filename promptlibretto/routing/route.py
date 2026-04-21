from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Callable, Optional

if TYPE_CHECKING:
    from ..builders.composite import CompositeBuilder
    from ..builders.builder import GenerationRequest
    from ..context.overlay import ContextSnapshot

RouteApplies = Callable[["ContextSnapshot", "GenerationRequest"], bool]


@dataclass
class PromptRoute:
    """A named prompt strategy with an applicability predicate."""

    name: str
    builder: "CompositeBuilder"
    priority: int = 0
    applies: Optional[RouteApplies] = None
    description: str = ""

    def matches(self, snapshot: "ContextSnapshot", request: "GenerationRequest") -> bool:
        if self.applies is None:
            return True
        return bool(self.applies(snapshot, request))

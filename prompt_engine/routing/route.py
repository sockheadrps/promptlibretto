from __future__ import annotations

import dataclasses
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Callable, Mapping, Optional

if TYPE_CHECKING:
    from ..builders.builder import PromptBuilder, GenerationRequest
    from ..context.overlay import ContextSnapshot

RouteApplies = Callable[["ContextSnapshot", "GenerationRequest"], bool]


class InputValidationError(ValueError):
    """Raised when `request.inputs` does not satisfy a route's `inputs_schema`.

    The `missing` attribute lists the names of required fields that were
    absent from the request. `route` names the route whose schema failed.
    Callers that want machine-readable error handling can catch this and
    read both attributes; the message is also human-readable.
    """

    def __init__(self, route: str, missing: list[str]):
        self.route = route
        self.missing = list(missing)
        names = ", ".join(missing)
        super().__init__(f"route {route!r} is missing required inputs: {names}")


@dataclass
class PromptRoute:
    """A named prompt strategy with an applicability predicate.

    `inputs_schema` is an optional dataclass declaring the shape this
    route's builder expects in `GenerationRequest.inputs`. When set, the
    engine validates `inputs` before building: any required field (no
    default, no `default_factory`) missing from `inputs` raises
    `InputValidationError`. Extra keys are allowed — the contract is
    additive, so callers can pass through metadata without breaking
    existing routes.
    """

    name: str
    builder: "PromptBuilder"
    priority: int = 0
    applies: Optional[RouteApplies] = None
    description: str = ""
    inputs_schema: Optional[type] = None

    def matches(self, snapshot: "ContextSnapshot", request: "GenerationRequest") -> bool:
        if self.applies is None:
            return True
        return bool(self.applies(snapshot, request))

    def required_inputs(self) -> list[str]:
        """Return the names of inputs that must be present in a request.

        Empty list if no schema is declared. A field counts as required if
        its dataclass `default` and `default_factory` are both MISSING.
        """
        schema = self.inputs_schema
        if schema is None or not dataclasses.is_dataclass(schema):
            return []
        required: list[str] = []
        for f in dataclasses.fields(schema):
            if f.default is dataclasses.MISSING and f.default_factory is dataclasses.MISSING:  # type: ignore[misc]
                required.append(f.name)
        return required

    def validate_inputs(self, inputs: Optional[Mapping[str, Any]]) -> None:
        """Raise `InputValidationError` when required fields are missing.

        No-op when the route declares no schema. Safe to call with `None`
        (treated as an empty mapping).
        """
        required = self.required_inputs()
        if not required:
            return
        present = set((inputs or {}).keys())
        missing = [name for name in required if name not in present]
        if missing:
            raise InputValidationError(self.name, missing)

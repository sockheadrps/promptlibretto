from __future__ import annotations

from typing import TYPE_CHECKING, Iterable, Optional

from .route import PromptRoute

if TYPE_CHECKING:
    from ..builders.builder import GenerationRequest
    from ..context.overlay import ContextSnapshot


class PromptRouter:
    """Selects a PromptRoute given the active context and request.

    Selection rules:
      1. If `request.mode` names a route, prefer it (mode is an explicit override).
      2. Otherwise, scan all routes whose `applies` predicate returns True.
      3. Among matches, pick the highest priority. Ties: first-registered wins.
      4. If nothing matches, fall back to the route flagged as default.
    """

    def __init__(self, default_route: Optional[str] = None):
        self._routes: list[PromptRoute] = []
        self._default = default_route

    def register(self, route: PromptRoute) -> None:
        if any(r.name == route.name for r in self._routes):
            raise ValueError(f"route already registered: {route.name}")
        self._routes.append(route)

    def register_many(self, routes: Iterable[PromptRoute]) -> None:
        for r in routes:
            self.register(r)

    def set_default(self, name: str) -> None:
        if not any(r.name == name for r in self._routes):
            raise ValueError(f"unknown default route: {name}")
        self._default = name

    def routes(self) -> list[PromptRoute]:
        return list(self._routes)

    def get(self, name: str) -> Optional[PromptRoute]:
        for r in self._routes:
            if r.name == name:
                return r
        return None

    def select(
        self,
        snapshot: "ContextSnapshot",
        request: "GenerationRequest",
    ) -> PromptRoute:
        if request.mode:
            forced = self.get(request.mode)
            if forced is not None:
                return forced

        matches = [r for r in self._routes if r.matches(snapshot, request)]
        if matches:
            matches.sort(key=lambda r: (-r.priority, self._routes.index(r)))
            return matches[0]

        if self._default:
            fallback = self.get(self._default)
            if fallback is not None:
                return fallback

        if self._routes:
            return self._routes[0]

        raise RuntimeError("PromptRouter has no routes registered")

from __future__ import annotations

from typing import TYPE_CHECKING, Iterable, Optional

from .route import PromptRoute

if TYPE_CHECKING:
    from ..builders.builder import GenerationRequest
    from ..context.overlay import ContextSnapshot


class PromptRouter:
    """Picks a route. Precedence:
      1. an explicit `request.mode` matching a registered route name;
      2. the highest-priority route whose `applies` predicate matches
         (registration order breaks ties);
      3. the default route, or the first registered route.
    An explicit `request.mode` that does not match any registered route
    raises `KeyError` (it does not silently fall through to predicate
    routing — that hides typos).
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

    def unregister(self, name: str) -> bool:
        for i, r in enumerate(self._routes):
            if r.name == name:
                del self._routes[i]
                if self._default == name:
                    self._default = self._routes[0].name if self._routes else None
                return True
        return False

    def replace(self, route: PromptRoute) -> None:
        """Register or replace a route by name (preserves position if existing)."""
        for i, r in enumerate(self._routes):
            if r.name == route.name:
                self._routes[i] = route
                return
        self._routes.append(route)

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
            known = [r.name for r in self._routes]
            raise KeyError(
                f"unknown route mode: {request.mode!r} (registered: {known})"
            )

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

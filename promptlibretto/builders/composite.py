from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, Mapping, Optional, Sequence

from .builder import BuildContext, PromptPackage

SectionFn = Callable[[BuildContext], str]


def section(text_or_fn: str | SectionFn) -> SectionFn:
    """Wrap a literal string or callable as a section function."""
    if callable(text_or_fn):
        return text_or_fn
    literal = text_or_fn
    return lambda _ctx: literal


def join_sections(parts: Iterable[str], separator: str = "\n\n") -> str:
    return separator.join(p.strip() for p in parts if p and p.strip())


@dataclass
class CompositeBuilder:
    """Composes a prompt from ordered section callables; empty sections are skipped."""

    name: str
    user_sections: Sequence[SectionFn] = field(default_factory=tuple)
    system_sections: Sequence[SectionFn] = field(default_factory=tuple)
    separator: str = "\n\n"
    generation_overrides: Mapping[str, Any] = field(default_factory=dict)
    output_policy: Mapping[str, Any] = field(default_factory=dict)
    include_active_context: bool = True
    include_injections: bool = True

    def build(self, ctx: BuildContext) -> PromptPackage:
        system_parts = [s(ctx) for s in self.system_sections]
        system_text = join_sections(system_parts, self.separator) if system_parts else None

        user_parts: list[str] = []
        if self.include_active_context and ctx.snapshot.active:
            user_parts.append(ctx.snapshot.active)

        if self.include_injections and ctx.injections:
            for inj in ctx.injections:
                if inj.instructions:
                    user_parts.append(inj.instructions.strip())
                if inj.examples:
                    user_parts.append("Examples:\n" + "\n".join(f"- {e}" for e in inj.examples))

        for fn in self.user_sections:
            user_parts.append(fn(ctx))

        user_text = join_sections(user_parts, self.separator)

        merged_overrides: dict[str, Any] = dict(self.generation_overrides)
        merged_policy: dict[str, Any] = dict(self.output_policy)
        for inj in ctx.injections:
            if inj.generation_overrides:
                merged_overrides.update(inj.generation_overrides)
            if inj.output_policy:
                merged_policy.update(inj.output_policy)

        return PromptPackage(
            route=self.name,
            user=user_text,
            system=system_text,
            metadata={"builder": "composite", "name": self.name},
            generation_overrides=merged_overrides,
            output_policy=merged_policy,
            injections=tuple(ctx.injections),
        )

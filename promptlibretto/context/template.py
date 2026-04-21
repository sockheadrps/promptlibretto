from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, Mapping, Optional, Sequence

_SLOT_PATTERN = re.compile(r"\{([a-zA-Z_][a-zA-Z0-9_]*)\}")
_WHITESPACE = re.compile(r"[ \t]+")
_BLANK_LINES = re.compile(r"\n{3,}")


@dataclass
class TemplateField:
    """Structured input for a template slot.

    `aliases` lets the same value resolve multiple slot names (e.g. {topic}/{subject}).
    `fallback_sentence` builds a trailing sentence when the slot is missing from
    the template but the field still needs to appear in the rendered output.
    """

    key: str
    value: Any
    aliases: Sequence[str] = field(default_factory=tuple)
    fallback_sentence: Optional[Callable[[Any], str]] = None

    def matches(self, slot: str) -> bool:
        return slot == self.key or slot in self.aliases


@dataclass
class TemplateRenderOptions:
    append_missing_fields: bool = True
    normalize_whitespace: bool = True
    keep_unknown_slots: bool = False


class TemplateRenderer:
    """Render a template string by substituting named slots.

    The renderer is intentionally small. It supports two input styles:
      * a flat mapping (legacy), or
      * a list of TemplateField for slots that may need fallbacks/aliases.
    """

    def render(
        self,
        template: str,
        values: Mapping[str, Any] | Iterable[TemplateField],
        options: Optional[TemplateRenderOptions] = None,
    ) -> str:
        opts = options or TemplateRenderOptions()
        fields = self._coerce_fields(values)
        used_keys: set[str] = set()

        def substitute(match: re.Match[str]) -> str:
            slot = match.group(1)
            for f in fields:
                if f.matches(slot):
                    used_keys.add(f.key)
                    return "" if f.value is None else str(f.value)
            return match.group(0) if opts.keep_unknown_slots else ""

        rendered = _SLOT_PATTERN.sub(substitute, template)

        if opts.append_missing_fields:
            tail = []
            for f in fields:
                if f.key in used_keys or f.value in (None, "", []):
                    continue
                if f.fallback_sentence is None:
                    continue
                sentence = f.fallback_sentence(f.value).strip()
                if sentence:
                    tail.append(sentence)
            if tail:
                rendered = rendered.rstrip() + " " + " ".join(tail)

        if opts.normalize_whitespace:
            rendered = _WHITESPACE.sub(" ", rendered)
            rendered = _BLANK_LINES.sub("\n\n", rendered).strip()

        return rendered

    def infer_template(
        self,
        rendered: str,
        values: Mapping[str, Any] | Iterable[TemplateField],
    ) -> str:
        """Recover a template by replacing known values with `{slot}` tokens.

        Conservative: only exact, longest-first matches are replaced. Empty values
        are skipped to avoid replacing the empty string everywhere.
        """
        fields = self._coerce_fields(values)
        replacements: list[tuple[str, str]] = []
        for f in fields:
            if f.value in (None, ""):
                continue
            replacements.append((str(f.value), "{" + f.key + "}"))
        replacements.sort(key=lambda pair: len(pair[0]), reverse=True)

        out = rendered
        for value, slot in replacements:
            out = out.replace(value, slot)
        return out

    @staticmethod
    def _coerce_fields(
        values: Mapping[str, Any] | Iterable[TemplateField],
    ) -> list[TemplateField]:
        if isinstance(values, Mapping):
            return [TemplateField(key=k, value=v) for k, v in values.items()]
        return list(values)

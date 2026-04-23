from __future__ import annotations

import re
from dataclasses import dataclass, field, replace
from typing import Any, Iterable, Mapping, Optional, Sequence

@dataclass(frozen=True)
class ValidationResult:
    ok: bool
    reason: Optional[str] = None


@dataclass
class OutputPolicy:
    """Per-route output rules. All fields are optional and merged onto defaults."""

    strip_prefixes: Sequence[str] = field(default_factory=tuple)
    strip_patterns: Sequence[str] = field(default_factory=tuple)
    forbidden_substrings: Sequence[str] = field(default_factory=tuple)
    forbidden_patterns: Sequence[str] = field(default_factory=tuple)
    max_length: Optional[int] = None
    min_length: Optional[int] = None
    require_patterns: Sequence[str] = field(default_factory=tuple)
    append_suffix: Optional[str] = None
    collapse_whitespace: bool = True

    def merged_with(self, overrides: Optional[Mapping[str, Any]]) -> "OutputPolicy":
        """Merge `overrides` onto this policy. Sequence-typed fields
        (`strip_prefixes`, `strip_patterns`, `forbidden_substrings`,
        `forbidden_patterns`, `require_patterns`) are extended additively —
        layered injections accumulate rules rather than clobbering them.
        Scalar fields (`max_length`, `min_length`, `append_suffix`,
        `collapse_whitespace`) replace.
        """
        if not overrides:
            return self
        unknown = [k for k in overrides if not hasattr(self, k)]
        if unknown:
            raise ValueError(
                f"unknown OutputPolicy fields: {unknown} "
                f"(known: {sorted(self.__dataclass_fields__.keys())})"
            )
        additive_fields = {
            "strip_prefixes",
            "strip_patterns",
            "forbidden_substrings",
            "forbidden_patterns",
            "require_patterns",
        }
        merged: dict[str, Any] = {}
        for k, v in overrides.items():
            if k in additive_fields:
                existing = tuple(getattr(self, k) or ())
                incoming = tuple(v or ())
                merged[k] = existing + incoming
            else:
                merged[k] = v
        return replace(self, **merged)


@dataclass
class ProcessingContext:
    route: str
    user_prompt: str
    metadata: Mapping[str, Any] = field(default_factory=dict)


# Collapse inline whitespace but keep newlines so markdown/structure survives.
_INLINE_WS = re.compile(r"[ \t]+")
_BLANK_LINES = re.compile(r"\n{3,}")
_TRAILING_INLINE_WS = re.compile(r"[ \t]+\n")


class OutputProcessor:
    """Cleans and validates generated text against an OutputPolicy."""

    def __init__(self, default_policy: Optional[OutputPolicy] = None):
        self._default = default_policy or OutputPolicy()

    def policy_for(self, overrides: Optional[Mapping[str, Any]] = None) -> OutputPolicy:
        return self._default.merged_with(overrides)

    def clean(
        self,
        text: str,
        ctx: ProcessingContext,
        policy: Optional[OutputPolicy] = None,
    ) -> str:
        p = policy or self._default
        out = text or ""
        for prefix in p.strip_prefixes:
            if out.lstrip().lower().startswith(prefix.lower()):
                idx = out.lower().find(prefix.lower())
                out = out[idx + len(prefix):]
        for pattern in p.strip_patterns:
            out = re.sub(pattern, "", out, flags=re.MULTILINE)
        out = out.strip()
        if p.collapse_whitespace:
            out = _INLINE_WS.sub(" ", out)
            out = _TRAILING_INLINE_WS.sub("\n", out)
            out = _BLANK_LINES.sub("\n\n", out).strip()
        if p.max_length is not None and len(out) > p.max_length:
            out = out[: p.max_length].rstrip()
        if p.append_suffix:
            out = (out + p.append_suffix).strip()
        return out

    def validate(
        self,
        text: str,
        ctx: ProcessingContext,
        policy: Optional[OutputPolicy] = None,
    ) -> ValidationResult:
        p = policy or self._default
        if p.min_length is not None and len(text) < p.min_length:
            return ValidationResult(False, f"too short (<{p.min_length})")
        if p.max_length is not None and len(text) > p.max_length:
            return ValidationResult(False, f"too long (>{p.max_length})")
        for sub in p.forbidden_substrings:
            if sub and sub in text:
                return ValidationResult(False, f"forbidden substring: {sub!r}")
        for pattern in p.forbidden_patterns:
            if pattern and re.search(pattern, text):
                return ValidationResult(False, f"forbidden pattern: {pattern!r}")
        for pattern in p.require_patterns:
            if pattern and not re.search(pattern, text):
                return ValidationResult(False, f"missing required pattern: {pattern!r}")
        return ValidationResult(True)

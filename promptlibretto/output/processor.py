from __future__ import annotations

import re
from dataclasses import dataclass, field, replace
from typing import Any, Iterable, Mapping, Optional, Sequence

from .memory import RecentOutputMemory


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
    dedupe_against_recent: bool = False
    dedupe_similarity_threshold: float = 0.9
    append_suffix: Optional[str] = None
    collapse_whitespace: bool = True

    def merged_with(self, overrides: Optional[Mapping[str, Any]]) -> "OutputPolicy":
        if not overrides:
            return self
        valid = {k: v for k, v in overrides.items() if hasattr(self, k)}
        return replace(self, **valid)


@dataclass
class ProcessingContext:
    route: str
    user_prompt: str
    recent: Optional[RecentOutputMemory] = None
    metadata: Mapping[str, Any] = field(default_factory=dict)


# Collapse runs of inline whitespace (spaces / tabs) but preserve newlines so
# structured output like markdown stays intact. A separate pass collapses 3+
# blank lines into a single blank line.
_INLINE_WS = re.compile(r"[ \t]+")
_BLANK_LINES = re.compile(r"\n{3,}")
_TRAILING_INLINE_WS = re.compile(r"[ \t]+\n")


class OutputProcessor:
    """Cleans and validates generated text against an OutputPolicy.

    Usage pattern:
      cleaned = processor.clean(text, ctx, policy)
      result = processor.validate(cleaned, ctx, policy)
      if not result.ok: retry
    """

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
        if p.dedupe_against_recent and ctx.recent is not None:
            if ctx.recent.is_too_similar(text, threshold=p.dedupe_similarity_threshold):
                return ValidationResult(False, "duplicate of recent output")
        return ValidationResult(True)

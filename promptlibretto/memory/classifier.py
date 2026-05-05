from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Optional

from ..providers.base import ProviderAdapter, ProviderMessage, ProviderRequest

if TYPE_CHECKING:
    from .store import MemoryChunk


@dataclass
class ClassifierResult:
    tags: list[str] = field(default_factory=list)
    ms: float = 0.0
    tokens: Optional[int] = None
    model: str = ""
    raw_response: str = ""           # what the classifier actually said
    error: Optional[str] = None      # set when the call failed
    known_tags: list[str] = field(default_factory=list)

_SYSTEM = (
    "You are a context classifier. "
    "Given a user message and relevant past exchanges, return ONLY a JSON array "
    "of matching tags from the provided vocabulary. "
    "Reply with nothing except the JSON array. Example: [\"tag_a\", \"tag_b\"]"
)

_USER_TMPL = """\
Known tags: {tags}

User message:
{input}

Relevant past exchanges:
{chunks}

Which tags apply? Reply with a JSON array only."""

_USER_TMPL_WITH_DESC = """\
Known tags and what each one means:
{tag_lines}

User message:
{input}

Relevant past exchanges:
{chunks}

Which tags apply? Reply with a JSON array only."""


class Classifier:
    """Extracts memory tags from retrieved chunks via a small LLM call."""

    def __init__(
        self,
        provider: ProviderAdapter,
        model: str = "llama3.2:1b",
        timeout_ms: int = 15_000,
    ) -> None:
        self._provider = provider
        self._model = model
        self._timeout_ms = timeout_ms

    async def extract_tags(
        self,
        user_input: str,
        chunks: list[MemoryChunk],
        known_tags: list[str],
        tag_descriptions: Optional[dict[str, str]] = None,
    ) -> ClassifierResult:
        if not known_tags:
            return ClassifierResult(model=self._model, error="no known_tags configured (registry has no memory_rules)")

        chunk_text = "\n---\n".join(
            f"[{c.turn.role}] {c.turn.text}" for c in chunks[:6]
        ) or "(none)"

        if tag_descriptions:
            tag_lines = "\n".join(
                f"- {t}: {tag_descriptions[t]}" if t in tag_descriptions else f"- {t}"
                for t in known_tags
            )
            prompt = _USER_TMPL_WITH_DESC.format(
                tag_lines=tag_lines,
                input=user_input.strip(),
                chunks=chunk_text,
            )
        else:
            prompt = _USER_TMPL.format(
                tags=", ".join(known_tags),
                input=user_input.strip(),
                chunks=chunk_text,
            )

        request = ProviderRequest(
            model=self._model,
            messages=[
                ProviderMessage(role="system", content=_SYSTEM),
                ProviderMessage(role="user", content=prompt),
            ],
            temperature=0.0,
            max_tokens=64,
            timeout_ms=self._timeout_ms,
        )

        t0 = time.monotonic()
        try:
            response = await self._provider.generate(request)
            ms = (time.monotonic() - t0) * 1000
            # `response.usage` is a ProviderUsage dataclass on success — it
            # exposes attributes, not dict-like .get(). Coerce to a dict via
            # asdict() and fall back to {} when missing.
            usage_obj = response.usage
            if usage_obj is None:
                usage = {}
            elif isinstance(usage_obj, dict):
                usage = usage_obj
            else:
                try:
                    from dataclasses import asdict
                    usage = asdict(usage_obj)
                except Exception:
                    usage = {}
            tokens = (
                usage.get("completion_tokens")
                or usage.get("eval_count")
                or usage.get("total_tokens")
            )
            raw = (response.text or "").strip()
            tags = _parse_tags(raw, known_tags)
            err: Optional[str] = None
            if not tags:
                # The call succeeded but produced no usable tags. Distinguish
                # between "model said no" and "couldn't parse a JSON array".
                if "[" not in raw:
                    err = "classifier reply did not contain a JSON array"
                else:
                    err = None  # legitimately matched nothing
            return ClassifierResult(
                tags=tags,
                ms=round(ms, 1),
                tokens=tokens,
                model=self._model,
                raw_response=raw[:500],
                error=err,
                known_tags=list(known_tags),
            )
        except Exception as e:
            ms = (time.monotonic() - t0) * 1000
            return ClassifierResult(
                ms=round(ms, 1),
                model=self._model,
                error=f"{type(e).__name__}: {e}",
                known_tags=list(known_tags),
            )


def _parse_tags(text: str, known_tags: list[str]) -> list[str]:
    """Extract a JSON array from the response, filter to known tags."""
    text = text.strip()
    # find first [...] block
    match = re.search(r"\[.*?\]", text, re.DOTALL)
    if not match:
        return []
    try:
        parsed = json.loads(match.group())
        if not isinstance(parsed, list):
            return []
        known = set(known_tags)
        return [str(t) for t in parsed if str(t) in known]
    except (json.JSONDecodeError, TypeError):
        return []

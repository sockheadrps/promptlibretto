from __future__ import annotations

from promptlibretto import OutputPolicy, OutputProcessor, RecentOutputMemory
from promptlibretto.output.processor import ProcessingContext


def _ctx(recent=None):
    return ProcessingContext(route="r", user_prompt="u", recent=recent)


def test_strip_prefix_removes_leading_fence():
    proc = OutputProcessor()
    policy = OutputPolicy(strip_prefixes=("```json", "```"))
    cleaned = proc.clean("```json\n{\"a\":1}", _ctx(), policy)
    assert cleaned.startswith("{")


def test_strip_pattern_removes_trailing_fence():
    proc = OutputProcessor()
    policy = OutputPolicy(strip_patterns=(r"^```$",))
    cleaned = proc.clean("{\"a\":1}\n```", _ctx(), policy)
    assert "```" not in cleaned


def test_forbidden_substring_rejects():
    proc = OutputProcessor()
    policy = OutputPolicy(forbidden_substrings=("nope",))
    assert proc.validate("this contains nope here", _ctx(), policy).ok is False
    assert proc.validate("this is fine", _ctx(), policy).ok is True


def test_required_pattern_enforced():
    proc = OutputProcessor()
    policy = OutputPolicy(require_patterns=(r"\bSummary\b",))
    assert proc.validate("Summary: ok", _ctx(), policy).ok is True
    assert proc.validate("nothing here", _ctx(), policy).ok is False


def test_max_length_truncates_on_clean():
    proc = OutputProcessor()
    policy = OutputPolicy(max_length=5)
    assert proc.clean("abcdefghij", _ctx(), policy) == "abcde"


def test_dedupe_against_recent():
    recent = RecentOutputMemory(capacity=4)
    recent.add("the quick brown fox")
    proc = OutputProcessor()
    policy = OutputPolicy(dedupe_against_recent=True, dedupe_similarity_threshold=0.5)
    assert proc.validate("the quick brown fox", _ctx(recent), policy).ok is False
    assert proc.validate("totally different output", _ctx(recent), policy).ok is True


def test_collapse_whitespace_preserves_newlines():
    proc = OutputProcessor()
    cleaned = proc.clean("a    b\n\n\n\nc", _ctx())
    assert cleaned == "a b\n\nc"

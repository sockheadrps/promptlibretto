from __future__ import annotations

import pytest

from promptlibretto import RunHistory, RunRecord


def _rec(text: str) -> RunRecord:
    return RunRecord(request={}, text=text, accepted=True, route="default")


def test_bounded_capacity_drops_oldest():
    history = RunHistory(capacity=3)
    for i in range(5):
        history.add(_rec(f"r{i}"))
    texts = [r.text for r in history.items()]
    assert texts == ["r2", "r3", "r4"]


def test_remove_at_shifts_indices():
    history = RunHistory(capacity=5)
    for i in range(4):
        history.add(_rec(f"r{i}"))
    assert history.remove_at(1) is True
    assert [r.text for r in history.items()] == ["r0", "r2", "r3"]
    assert history.remove_at(99) is False


def test_clear_empties_buffer():
    history = RunHistory(capacity=5)
    history.add(_rec("x"))
    history.clear()
    assert history.items() == []


def test_capacity_must_be_positive():
    with pytest.raises(ValueError):
        RunHistory(capacity=0)


def test_to_dict_is_serialisable():
    rec = _rec("hello")
    d = rec.to_dict()
    assert d["text"] == "hello"
    assert d["accepted"] is True
    assert d["route"] == "default"
    assert "at" in d

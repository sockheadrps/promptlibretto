from __future__ import annotations

import json

import pytest

from promptlibretto import (
    ContextOverlay,
    PromptEngine,
    export_json,
    load_engine,
    section,
)


async def test_round_trip_minimal():
    engine = PromptEngine(routes={"default": "Say hi."})
    data = export_json(engine)
    assert data["version"] == 1
    assert data["route"]["name"] == "default"

    engine2, run = load_engine(data)
    result = await run()
    assert "Say hi." in result.text


async def test_round_trip_preserves_system_and_user_sections():
    engine = PromptEngine(routes={
        "r": {
            "system_sections": ["You are terse."],
            "user_sections": ["Q"],
        }
    })
    data = export_json(engine, route="r")
    assert "You are terse." in data["route"]["system_sections"]
    assert "Q" in data["route"]["user_sections"]

    _, run = load_engine(data)
    result = await run()
    assert "Q" in result.text


async def test_input_slot_becomes_template():
    engine = PromptEngine(routes={
        "r": {
            "user_sections": [
                section(lambda ctx: f"Q:\n{ctx.request.inputs.get('input', '')}"),
            ],
        }
    })
    data = export_json(engine, route="r")
    assert data["route"]["user_sections"][0] == {"template": "Q:\n{input}"}

    _, run = load_engine(data)
    result = await run("hello there")
    assert "Q:\nhello there" in result.text


async def test_round_trip_overlays():
    engine = PromptEngine(context_store="BASE", routes={"default": "Q"})
    engine.context_store.set_overlay(
        "note", ContextOverlay(text="Use markdown.", priority=15)
    )
    data = export_json(engine)
    overlays = {o["name"]: o for o in data["overlays"]}
    assert overlays["note"]["text"] == "Use markdown."
    assert overlays["note"]["priority"] == 15

    engine2, _ = load_engine(data)
    state = engine2.context_store.get_state()
    assert state.overlays["note"].text == "Use markdown."
    assert state.overlays["note"].priority == 15


async def test_round_trip_generation_overrides():
    engine = PromptEngine(routes={
        "r": {"user_sections": ["Q"], "generation_overrides": {"temperature": 0.33}}
    })
    data = export_json(engine, route="r")
    engine2, _ = load_engine(data)
    route = engine2.router.get("r")
    assert route.builder.generation_overrides["temperature"] == 0.33


async def test_round_trip_base_context():
    engine = PromptEngine(context_store="SYSTEM BASE", routes={"default": "Q"})
    data = export_json(engine)
    engine2, _ = load_engine(data)
    assert engine2.context_store.get_state().base == "SYSTEM BASE"


async def test_runtime_slots_inline_in_user_sections():
    engine = PromptEngine(context_store="BASE", routes={"default": "Q"})
    engine.context_store.set_overlay(
        "location",
        ContextOverlay(text="placeholder", priority=20, metadata={"runtime": "required"}),
    )
    engine.context_store.set_overlay(
        "focus",
        ContextOverlay(text="placeholder", priority=15, metadata={"runtime": "optional"}),
    )
    engine.context_store.set_overlay(
        "fixed_note", ContextOverlay(text="Use markdown.", priority=10),
    )
    data = export_json(engine)

    # Runtime overlays land in user_sections as template placeholders;
    # fixed overlays stay in the overlays list.
    user_sections = data["route"]["user_sections"]
    runtime_entries = [s for s in user_sections if isinstance(s, dict) and s.get("runtime")]
    assert any(s.get("template") == "{location}" and s["runtime"] == "required" for s in runtime_entries)
    assert any(s.get("template") == "{focus}" and s["runtime"] == "optional" for s in runtime_entries)
    assert [o["name"] for o in data["overlays"]] == ["fixed_note"]

    engine2, run = load_engine(data)

    with pytest.raises(ValueError):
        await run("hi", location="")

    # MockProvider echoes the concatenated prompt, so the expanded
    # `{location}` appears in the result text.
    result = await run("hello", location="kitchen")
    assert "kitchen" in result.text

    # Optional slot left empty becomes an empty string in the prompt,
    # not a hard error. Fixed overlay is preserved.
    result2 = await run("hello", location="kitchen")
    state = engine2.context_store.get_state()
    assert state.overlays["fixed_note"].text == "Use markdown."
    # Extra kwargs become priority-10 overlays for the next call.
    await run("hello", location="kitchen", scenario_focus="cooking")
    state = engine2.context_store.get_state()
    assert state.overlays["scenario_focus"].text == "cooking"
    # And are cleared on the next invocation.
    await run("again", location="kitchen")
    state = engine2.context_store.get_state()
    assert "scenario_focus" not in state.overlays
    assert "fixed_note" in state.overlays


async def test_section_overrides_split_on_separator():
    engine = PromptEngine(routes={"r": {"system_sections": ["original"], "user_sections": ["Q"]}})
    data = export_json(
        engine,
        route="r",
        section_overrides={"system": "rule one\n\nrule two\n\nrule three"},
    )
    assert data["route"]["system_sections"] == ["rule one", "rule two", "rule three"]


async def test_load_from_file(tmp_path):
    engine = PromptEngine(routes={"default": "hello"})
    path = tmp_path / "engine.json"
    path.write_text(json.dumps(export_json(engine)), encoding="utf-8")
    _, run = load_engine(path)
    result = await run()
    assert "hello" in result.text


async def test_load_rejects_unknown_version():
    with pytest.raises(ValueError, match="schema version"):
        load_engine({"version": 999, "route": {"name": "default"}})

from __future__ import annotations

import pytest

from promptlibretto import (
    Engine,
    MockProvider,
    Registry,
    RegistryState,
    Route,
    SectionState,
    export_json,
    hydrate,
    load_registry,
)


def test_registry_roundtrips_through_dict(twitch_registry: Registry) -> None:
    data = twitch_registry.to_dict(wrap=True)
    again = Registry.from_dict(data)
    assert again.title == twitch_registry.title
    assert again.assembly_order == twitch_registry.assembly_order
    assert set(again.sections) == set(twitch_registry.sections)


def test_registry_accepts_bare_dict(twitch_registry: Registry) -> None:
    bare = twitch_registry.to_dict(wrap=False)
    assert "registry" not in bare
    again = Registry.from_dict(bare)
    assert again.title == twitch_registry.title


def test_registry_rejects_old_schema_versions(twitch_registry: Registry) -> None:
    data = twitch_registry.to_dict(wrap=False)
    data["version"] = 22
    with pytest.raises(ValueError, match="unsupported registry schema version 22"):
        Registry.from_dict(data)


def test_export_json_string(twitch_registry: Registry) -> None:
    eng = Engine(twitch_registry)
    text = export_json(eng)
    assert text.lstrip().startswith("{")
    assert "Twitch Chatter" in text


def test_hydrate_default_picks_first_items(twitch_registry: Registry) -> None:
    out = hydrate(twitch_registry)
    assert "Rules: short message." in out
    assert "Streamer is at stream." in out
    assert "the_lurker" not in out
    assert "You usually never speak." in out
    assert "- React with excitement." in out


def test_hydrate_honors_explicit_section_state(twitch_registry: Registry) -> None:
    state = RegistryState(
        sections={
            "sentiment": SectionState(selected="negative"),
            "personas": SectionState(selected="the_hype_man"),
            "base_context": SectionState(
                template_vars={"location": "Times Square"}
            ),
        }
    )
    out = hydrate(twitch_registry, state)
    assert "Streamer is at Times Square." in out
    assert "You're the streamer's biggest fan." in out
    assert "Your opinion is negative:" in out


def test_hydrate_array_mode_random_is_seeded(twitch_registry: Registry) -> None:
    state = RegistryState(
        sections={
            "sentiment": SectionState(
                array_modes={"groups[positive_cues]": "random:1"}
            )
        }
    )
    a = hydrate(twitch_registry, state, seed=42)
    b = hydrate(twitch_registry, state, seed=42)
    c = hydrate(twitch_registry, state, seed=99)
    assert a == b
    assert a != c


def test_hydrate_array_mode_none_drops_group_token(twitch_registry: Registry) -> None:
    state = RegistryState(
        sections={"groups": SectionState(array_modes={"items": "none"})}
    )
    out = hydrate(twitch_registry, state)
    assert "lmao" not in out
    assert "Here are example phrases:" not in out


def test_hydrate_pre_context_merge_across_group_tokens(
    twitch_registry: Registry,
) -> None:
    state = RegistryState(
        sections={"sentiment": SectionState(selected="positive")}
    )
    out = hydrate(twitch_registry, state, seed=1)
    assert out.count("Here are example phrases:") == 1
    assert "- lmao" in out
    assert "- lets gooo" in out


def test_hydrate_runtime_injection_appends(twitch_registry: Registry) -> None:
    state = RegistryState(
        sections={
            "runtime_injections": SectionState(
                selected=["raid"],
                template_vars={"raider": "Pokimane"},
            )
        }
    )
    out = hydrate(twitch_registry, state)
    assert "Streamer is at stream." in out
    assert "Rules: short message." in out
    assert "You usually never speak." in out
    assert out.endswith("IMPORTANT: Pokimane just raided!")


def test_hydrate_sentiment_scale_token(twitch_registry: Registry) -> None:
    state = RegistryState(
        sections={
            "sentiment": SectionState(selected="positive", slider=8),
        }
    )
    out = hydrate(twitch_registry, state)
    assert "intensity is 8 on excited" in out


def test_hydrate_sentiment_scale_random(twitch_registry: Registry) -> None:
    state = RegistryState(
        sections={
            "sentiment": SectionState(
                selected="negative",
                slider_random=True,
            )
        }
    )
    out = hydrate(twitch_registry, state, seed=7)
    assert "intensity is" in out
    assert "on annoyed" in out


def test_routes_override_assembly_order(twitch_registry: Registry) -> None:
    twitch_registry.routes["short"] = Route(
        assembly_order=["output_prompt_directions"]
    )
    out_default = hydrate(twitch_registry)
    out_short = hydrate(twitch_registry, route="short")
    assert "Streamer is at" in out_default
    assert "Streamer is at" not in out_short
    assert out_short == "Rules: short message."


@pytest.mark.asyncio
async def test_engine_run_returns_result(twitch_engine: Engine) -> None:
    result = await twitch_engine.run()
    assert result.accepted is True
    assert result.text
    assert "Rules: short message." in result.prompt


@pytest.mark.asyncio
async def test_engine_run_route(twitch_engine: Engine) -> None:
    twitch_engine.registry.routes["short"] = Route(
        assembly_order=["output_prompt_directions"]
    )
    result = await twitch_engine.run(route="short")
    assert result.route == "short"
    assert result.prompt == "Rules: short message."


def test_load_registry_from_dict_returns_engine(twitch_registry: Registry) -> None:
    eng = load_registry(twitch_registry.to_dict(wrap=True), provider=MockProvider())
    assert isinstance(eng, Engine)
    assert eng.registry.title == "Twitch Chatter"

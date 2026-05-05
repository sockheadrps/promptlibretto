from __future__ import annotations

import pytest

from promptlibretto import Engine, MockProvider, Registry


_TWITCH_REGISTRY = {
    "registry": {
        "version": 2,
        "title": "Twitch Chatter",
        "assembly_order": [
            "output_prompt_directions",
            "base_context.text",
            "personas.context",
            "personas.groups",
            "sentiment.context",
            "sentiment.groups[positive_cues]",
            "sentiment.scale",
            "groups[normal_examples]",
            "sentiment.groups[positive_examples]",
            "prompt_endings",
        ],
        "base_context": {
            "required": True,
            "template_vars": ["location"],
            "items": [
                {
                    "id": "stream_context",
                    "text": "Streamer is at {location}.",
                    "template_defaults": {"location": "stream"},
                }
            ],
        },
        "personas": {
            "required": True,
            "items": [
                {
                    "id": "the_lurker",
                    "context": "You usually never speak.",
                    "groups": ["lurker_directives"],
                },
                {
                    "id": "the_hype_man",
                    "context": "You're the streamer's biggest fan.",
                    "groups": ["hype_directives"],
                },
            ],
        },
        "sentiment": {
            "required": True,
            "items": [
                {
                    "id": "positive",
                    "context": "Your opinion is positive:",
                    "groups": ["positive_cues", "positive_examples"],
                    "scale": {
                        "scale_descriptor": "excited",
                        "template": "intensity is {value} on {scale_descriptor}",
                        "default_value": 5,
                    },
                },
                {
                    "id": "negative",
                    "context": "Your opinion is negative:",
                    "groups": ["negative_cues", "negative_examples"],
                    "scale": {
                        "scale_descriptor": "annoyed",
                        "template": "intensity is {value} on {scale_descriptor}",
                        "default_value": 5,
                    },
                },
            ],
        },
        "static_injections": {"required": False, "items": []},
        "runtime_injections": {
            "required": False,
            "template_vars": ["raider"],
            "items": [
                {
                    "id": "raid",
                    "text": "IMPORTANT: {raider} just raided!",
                    "include_sections": ["personas"],
                }
            ],
        },
        "output_prompt_directions": {
            "required": True,
            "items": [
                {"id": "rules_chat", "text": "Rules: short message."},
            ],
        },
        "groups": {
            "required": False,
            "items": [
                {
                    "id": "lurker_directives",
                    "items": ["Be brief.", "Be shy."],
                },
                {
                    "id": "hype_directives",
                    "items": ["Exaggerate.", "High energy."],
                },
                {
                    "id": "positive_cues",
                    "items": ["React with excitement.", "Sound impressed."],
                },
                {
                    "id": "positive_examples",
                    "items": ["lets gooo", "huge W"],
                },
                {
                    "id": "negative_cues",
                    "items": ["Be sarcastic.", "Sound bored."],
                },
                {
                    "id": "negative_examples",
                    "items": ["yikes", "L"],
                },
                {
                    "id": "normal_examples",
                    "pre_context": "Here are example phrases:",
                    "items": ["lmao", "W", "pog", "bruh"],
                },
            ],
        },
        "prompt_endings": {
            "required": True,
            "items": [
                {"id": "prompt_endings", "items": ["Your message:", "You type:"]},
            ],
        },
    }
}


@pytest.fixture
def twitch_registry() -> Registry:
    return Registry.from_dict(_TWITCH_REGISTRY)


@pytest.fixture
def twitch_engine(twitch_registry: Registry) -> Engine:
    return Engine(twitch_registry, provider=MockProvider(latency_ms=0.0))

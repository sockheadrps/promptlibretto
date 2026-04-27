from __future__ import annotations

import pytest

from promptlibretto import Engine, MockProvider, Registry


_TWITCH_REGISTRY = {
    "registry": {
        "version": 22,
        "title": "Twitch Chatter",
        "assembly_order": [
            "output_prompt_directions",
            "base_context.text",
            "persona.context",
            "sentiment.context",
            "sentiment.nudges",
            "sentiment.scale",
            "examples.normal_examples",
            "sentiment.examples",
            "prompt_endings.examples",
        ],
        "base_context": {
            "required": True,
            "template_vars": ["location"],
            "items": [
                {
                    "name": "stream_context",
                    "text": "Streamer is at {location}.",
                }
            ],
        },
        "personas": {
            "required": True,
            "items": [
                {
                    "id": "the_lurker",
                    "context": "You usually never speak.",
                    "base_directives": ["Be brief.", "Be shy."],
                },
                {
                    "id": "the_hype_man",
                    "context": "You're the streamer's biggest fan.",
                    "base_directives": ["Exaggerate.", "High energy."],
                },
            ],
        },
        "sentiment": {
            "required": True,
            "items": [
                {
                    "id": "positive",
                    "context": "Your opinion is positive:",
                    "nudges": ["React with excitement.", "Sound impressed."],
                    "examples": ["lets gooo", "huge W"],
                },
                {
                    "id": "negative",
                    "context": "Your opinion is negative:",
                    "nudges": ["Be sarcastic.", "Sound bored."],
                    "examples": ["yikes", "L"],
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
                {"name": "rules_chat", "text": "Rules: short message."},
            ],
        },
        "examples": {
            "required": False,
            "items": [
                {
                    "name": "normal_examples",
                    "pre_context": "Here are example phrases:",
                    "items": ["lmao", "W", "pog", "bruh"],
                }
            ],
        },
        "prompt_endings": {
            "required": True,
            "items": [
                {"name": "prompt_endings", "items": ["Your message:", "You type:"]},
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

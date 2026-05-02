"""Registry-based prompt model — schema v22.

The registry is a flat list of *sections* (``personas``, ``sentiment``,
``examples``, …); each section has ``items``. ``assembly_order`` is a
list of tokens (``section`` / ``section.field`` / ``section[expr]``) that
specify how the final prompt is built from the selected items.

Quick start::

    from promptlibretto import load_registry, OllamaProvider

    eng = load_registry("twitch_chatter.json", provider=OllamaProvider(...))
    prompt = eng.hydrate(state={
        "selections": {"sentiment": "positive", "personas": "the_troll"},
        "array_modes": {"sentiment": {"nudges": "random:1"}},
        "template_vars": {"base_context::location": "NYC"},
    })

    # Or hydrate + LLM + validate:
    result = await eng.run(state={...}, route="raid")
"""
from __future__ import annotations

from .engine import Engine, GenerationChunk, GenerationResult
from .hydrate import HydrateState, hydrate
from .model import (
    SCHEMA_VERSION,
    SECTION_KEYS,
    ContextItem,
    ExampleGroup,
    Fragment,
    OutputDirection,
    Persona,
    PromptEnding,
    Registry,
    Route,
    RuntimeInjection,
    Section,
    SentimentItem,
    StaticInjection,
)
from .serialize import export_json, load_registry

__all__ = [
    "Engine",
    "GenerationChunk",
    "GenerationResult",
    "HydrateState",
    "Registry",
    "Route",
    "Section",
    "SCHEMA_VERSION",
    "SECTION_KEYS",
    "export_json",
    "hydrate",
    "load_registry",
    # Typed item builders
    "ContextItem",
    "ExampleGroup",
    "Fragment",
    "OutputDirection",
    "Persona",
    "PromptEnding",
    "RuntimeInjection",
    "SentimentItem",
    "StaticInjection",
]

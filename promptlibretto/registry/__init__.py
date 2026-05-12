"""Registry-based prompt model."""
from __future__ import annotations

from .engine import Engine, GenerationChunk, GenerationResult
from .hydrate import hydrate
from .model import (
    SCHEMA_VERSION,
    SECTION_KEYS,
    WELL_KNOWN_SECTIONS,
    BaseItem,
    ContextItem,
    Display,
    DynamicMixin,
    Fragment,
    Group,
    Item,
    OutputDirection,
    Persona,
    PromptEnding,
    Registry,
    Route,
    RuntimeInjection,
    Scale,
    ScalableMixin,
    Section,
    Sentiment,
    StaticInjection,
)
from .schema import StateSchema, SectionStateSchema, SelectableItem, derive_state_schema
from .serialize import export_json, load_registry
from .state import RegistryState, SectionState

__all__ = [
    # Engine
    "Engine",
    "GenerationChunk",
    "GenerationResult",
    # State
    "RegistryState",
    "SectionState",
    # Registry model
    "Registry",
    "Route",
    "Section",
    "SCHEMA_VERSION",
    "SECTION_KEYS",
    "WELL_KNOWN_SECTIONS",
    "export_json",
    "hydrate",
    "load_registry",
    # Core building blocks
    "BaseItem",
    "Display",
    "DynamicMixin",
    "Fragment",
    "Scale",
    "ScalableMixin",
    # Item types
    "Item",
    "ContextItem",
    "Group",
    "OutputDirection",
    "Persona",
    "PromptEnding",
    "RuntimeInjection",
    "Sentiment",
    "StaticInjection",
    # State schema
    "StateSchema",
    "SectionStateSchema",
    "SelectableItem",
    "derive_state_schema",
]

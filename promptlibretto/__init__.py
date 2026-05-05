"""promptlibretto — registry-based prompt model + runtime."""
from __future__ import annotations

from .config import GenerationConfig
from .output.processor import OutputPolicy, OutputProcessor, ValidationResult
from .providers.base import (
    ProviderAdapter,
    ProviderRequest,
    ProviderResponse,
    ProviderStreamChunk,
    StreamingProviderAdapter,
    supports_streaming,
)
from .providers.mock import MockProvider
from .providers.ollama import OllamaProvider
from .registry import (
    BaseItem,
    derive_state_schema,
    SelectableItem,
    SectionStateSchema,
    StateSchema,
    ContextItem,
    Display,
    DynamicMixin,
    Engine,
    Fragment,
    GenerationChunk,
    GenerationResult,
    Group,
    OutputDirection,
    Persona,
    PromptEnding,
    Registry,
    RegistryState,
    Route,
    RuntimeInjection,
    SCHEMA_VERSION,
    SECTION_KEYS,
    Scale,
    ScalableMixin,
    Section,
    SectionState,
    Sentiment,
    StaticInjection,
    export_json,
    hydrate,
    load_registry,
)

__all__ = [
    # Engine
    "Engine",
    "GenerationChunk",
    "GenerationResult",
    # State
    "RegistryState",
    "SectionState",
    # Registry
    "Registry",
    "Route",
    "Section",
    "SCHEMA_VERSION",
    "SECTION_KEYS",
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
    # Providers
    "ProviderAdapter",
    "ProviderRequest",
    "ProviderResponse",
    "ProviderStreamChunk",
    "StreamingProviderAdapter",
    "supports_streaming",
    "MockProvider",
    "OllamaProvider",
    # Config + output
    "GenerationConfig",
    "OutputPolicy",
    "OutputProcessor",
    "ValidationResult",
]

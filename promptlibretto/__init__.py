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
    ContextItem,
    Engine,
    ExampleGroup,
    Fragment,
    GenerationChunk,
    GenerationResult,
    HydrateState,
    OutputDirection,
    Persona,
    PromptEnding,
    Registry,
    Route,
    RuntimeInjection,
    Section,
    SentimentItem,
    SCHEMA_VERSION,
    SECTION_KEYS,
    StaticInjection,
    export_json,
    hydrate,
    load_registry,
)

__all__ = [
    # Registry
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
    # Typed item builders for canonical sections
    "ContextItem",
    "ExampleGroup",
    "Fragment",
    "OutputDirection",
    "Persona",
    "PromptEnding",
    "RuntimeInjection",
    "SentimentItem",
    "StaticInjection",
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

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
    Engine,
    GenerationChunk,
    GenerationResult,
    HydrateState,
    Registry,
    Route,
    Section,
    SCHEMA_VERSION,
    SECTION_KEYS,
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

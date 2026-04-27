"""Serialization helpers — load/save registries and engines."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Mapping, Optional, Union

from ..output.processor import OutputProcessor
from ..providers.base import ProviderAdapter
from .engine import Engine
from .model import Registry


def load_registry(
    source: Union[str, Path, Mapping[str, Any]],
    provider: Union[ProviderAdapter, str, None] = None,
    output_processor: Optional[OutputProcessor] = None,
) -> Engine:
    """Load a registry from a file path, JSON string, or dict.

    Returns a ready-to-use :class:`Engine`. If *provider* is omitted you
    can still call :meth:`Engine.hydrate`; calling :meth:`Engine.run`
    needs a real provider.
    """
    data: dict[str, Any]
    if isinstance(source, (str, Path)):
        path = Path(source)
        if path.exists():
            data = json.loads(path.read_text(encoding="utf-8"))
        else:
            data = json.loads(str(source))
    elif isinstance(source, Mapping):
        data = dict(source)
    else:
        raise TypeError(f"unsupported source type: {type(source)!r}")
    registry = Registry.from_dict(data)
    return Engine(
        registry, provider=provider, output_processor=output_processor
    )


def export_json(
    engine_or_registry: Union[Engine, Registry], *, indent: Optional[int] = 2
) -> str:
    """Serialize an :class:`Engine` (or its :class:`Registry`) to JSON."""
    reg = (
        engine_or_registry.registry
        if isinstance(engine_or_registry, Engine)
        else engine_or_registry
    )
    return json.dumps(reg.to_dict(wrap=True), indent=indent, ensure_ascii=False)

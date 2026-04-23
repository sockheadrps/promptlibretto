"""JSON-based engine serialization.

The studio (or any caller) writes a tuned `PromptEngine` to a portable
JSON document; calling apps load that document back into a runnable
engine plus a `run()` closure that handles runtime overlay slots and
extra-kwarg overlays.

This is the supported deploy path. The JSON schema is `{"version": 1, ...}`.
"""

from __future__ import annotations

import json
import re
from dataclasses import asdict
from pathlib import Path
from typing import Any, Awaitable, Callable, Mapping, Optional, Sequence, Union

from .builders.builder import BuildContext, GenerationRequest, SafeFormatDict
from .builders.composite import CompositeBuilder
from .config import GenerationConfig
from .context.overlay import ContextOverlay
from .runtime.engine import GenerationResult, PromptEngine


SCHEMA_VERSION = 1
_INPUT_MARKER = "__PROMPTLIBRETTO_INPUT__"
_DEFAULT_CONFIG = GenerationConfig()


def export_json(
    engine: PromptEngine,
    *,
    route: Optional[str] = None,
    injections: Sequence[str] = (),
    include_overlays: bool = True,
    section_overrides: Optional[Mapping[str, str]] = None,
) -> dict[str, Any]:
    """Serialise the resolved engine state to a JSON-safe dict.

    The returned dict can be `json.dump`'d directly, or passed to
    `load_engine()` to rebuild the engine.
    """
    route_name = route or engine.router._default or (engine.router.routes()[0].name)
    route_obj = engine.router.get(route_name)
    if route_obj is None:
        raise ValueError(f"unknown route: {route_name!r}")
    builder = route_obj.builder
    if not isinstance(builder, CompositeBuilder):
        raise TypeError(
            f"export_json only supports CompositeBuilder routes (got {type(builder).__name__})"
        )

    full_snapshot = engine.context_store.get_state()

    # Split runtime vs fixed overlays. Runtime overlays become inline
    # `{"template": "{name}", "runtime": mode}` entries in user_sections so
    # the JSON self-documents exactly where the caller's value lands.
    runtime_entries: list[tuple[str, int, str, str]] = []  # name, priority, mode, template
    fixed_overlays: dict[str, ContextOverlay] = {}
    for name, overlay in full_snapshot.overlays.items():
        mode = str(overlay.metadata.get("runtime") or "").lower()
        if mode in ("optional", "required"):
            tmpl = str(overlay.metadata.get("template") or "")
            runtime_entries.append((name, overlay.priority, mode, tmpl))
        else:
            fixed_overlays[name] = overlay
    runtime_entries.sort(key=lambda t: -t[1])

    # Build sections against a snapshot that only includes fixed overlays —
    # the active-context render path would otherwise duplicate `{name}`
    # placeholders once we append them as template sections below.
    fixed_snapshot = full_snapshot.with_overlays(fixed_overlays)
    request = GenerationRequest(
        mode=route_name,
        inputs={"input": _INPUT_MARKER},
        injections=tuple(injections),
    )
    materialized = engine._materialize_injections(request.injections)
    ctx = BuildContext(
        snapshot=fixed_snapshot,
        request=request,
        assets=engine.asset_registry,
        random=engine.random,
        injections=materialized,
    )

    system_parts = [s(ctx) for s in builder.system_sections]
    user_parts = [s(ctx) for s in builder.user_sections]
    if section_overrides:
        sep = builder.separator or "\n\n"
        if "system" in section_overrides:
            system_parts = _split_override(section_overrides["system"], sep)
        if "user" in section_overrides:
            user_parts = _split_override(section_overrides["user"], sep)

    user_section_json: list[Any] = [
        _section_to_json(p) for p in user_parts if p.strip()
    ]
    # Append runtime placeholders as their own template user_sections,
    # highest priority first.
    for name, _priority, mode, tmpl in runtime_entries:
        template_str = tmpl if tmpl else "{" + name + "}"
        user_section_json.append(
            {"template": template_str, "runtime": mode}
        )

    out: dict[str, Any] = {
        "version": SCHEMA_VERSION,
        "config": _nondefault_config(engine.config),
        "context_store": full_snapshot.base or "",
        "route": {
            "name": route_name,
            "system_sections": [_section_to_json(p) for p in system_parts if p.strip()],
            "user_sections": user_section_json,
            "generation_overrides": dict(builder.generation_overrides or {}),
            "output_policy": dict(builder.output_policy or {}),
            "separator": builder.separator or "\n\n",
        },
        "overlays": [],
    }

    if include_overlays:
        sorted_overlays = sorted(
            fixed_overlays.items(), key=lambda kv: -kv[1].priority
        )
        for name, overlay in sorted_overlays:
            entry: dict[str, Any] = {
                "name": name,
                "priority": overlay.priority,
                "text": overlay.text,
            }
            if overlay.expires_at is not None:
                entry["expires_at"] = overlay.expires_at
            meta = {k: v for k, v in overlay.metadata.items() if k != "runtime"}
            if meta:
                entry["metadata"] = meta
            out["overlays"].append(entry)

    return out


RunFn = Callable[..., Awaitable[GenerationResult]]


def load_engine(source: Union[str, Path, Mapping[str, Any]]) -> tuple[PromptEngine, RunFn]:
    """Build a `PromptEngine` and a `run()` closure from JSON.

    `source` is a path to a `.json` file, or an already-parsed dict.

    Returns `(engine, run)`. Call `await run(user_input, **slots)`:

    - Required runtime slots raise `ValueError` if missing/empty.
    - Optional runtime slots are applied only if non-empty.
    - Any other keyword args become priority-10 overlays for that call.
    """
    data = _load_data(source)
    if data.get("version") != SCHEMA_VERSION:
        raise ValueError(
            f"unsupported export schema version: {data.get('version')!r} "
            f"(expected {SCHEMA_VERSION})"
        )

    config = data.get("config") or {}
    base = data.get("context_store") or ""
    route_d = data["route"]

    # Collect runtime slots declared inline on user_sections. Required slots
    # raise before model call; optional slots flow into request.inputs so
    # `{name}` in the template expands to the caller's value (or empty).
    inline_required: list[str] = []
    inline_optional: list[str] = []
    system_sections = [_section_from_json(s) for s in route_d.get("system_sections", [])]
    user_sections: list[Any] = []
    for s in route_d.get("user_sections", []):
        if isinstance(s, Mapping) and s.get("runtime") in ("optional", "required"):
            name = _slot_name_from_template(str(s.get("template", "")))
            if name:
                if s["runtime"] == "required":
                    inline_required.append(name)
                else:
                    inline_optional.append(name)
        user_sections.append(_section_from_json(s))

    route_dict: dict[str, Any] = {
        "system_sections": system_sections,
        "user_sections": user_sections,
    }
    if route_d.get("generation_overrides"):
        route_dict["generation_overrides"] = dict(route_d["generation_overrides"])
    if route_d.get("output_policy"):
        route_dict["output_policy"] = dict(route_d["output_policy"])
    if route_d.get("separator"):
        route_dict["separator"] = route_d["separator"]

    route_name = route_d.get("name") or "default"
    engine = PromptEngine(
        config=config or None,
        context_store=base or None,
        routes={route_name: route_dict},
    )

    fixed_names: list[str] = []
    for ov in data.get("overlays") or []:
        name = ov["name"]
        engine.context_store.set_overlay(
            name,
            ContextOverlay(
                text=ov.get("text", ""),
                priority=int(ov.get("priority", 10)),
                expires_at=ov.get("expires_at"),
                metadata=ov.get("metadata") or {},
            ),
        )
        fixed_names.append(name)

    fixed_set = set(fixed_names)
    inline_required_set = set(inline_required)
    inline_slot_set = inline_required_set | set(inline_optional)

    def _prepare(user_input: str, kwargs: dict) -> "GenerationRequest":
        """Apply slot/overlay side-effects to the engine's context_store and
        return the GenerationRequest that `run` would hand to the engine.
        Raises ValueError on missing required slots.
        """
        debug = bool(kwargs.pop("_debug", False))
        for _name in list(engine.context_store.overlays()):
            if _name not in fixed_set:
                engine.context_store.clear_overlay(_name)
        for name in inline_required_set:
            if not kwargs.get(name, ""):
                raise ValueError(f"runtime slot {name!r} is required")
        inline_values: dict[str, str] = {}
        for name in list(kwargs):
            if name in inline_slot_set:
                inline_values[name] = str(kwargs.pop(name) or "")
        for name, value in kwargs.items():
            if value:
                engine.context_store.set_overlay(
                    name, ContextOverlay(text=str(value), priority=10)
                )
        inputs = {"input": user_input, **inline_values}
        return GenerationRequest(inputs=inputs, debug=debug)

    async def run(user_input: str = "", **kwargs: str) -> GenerationResult:
        request = _prepare(user_input, kwargs)
        return await engine.generate_once(request)

    def prepare(user_input: str = "", **kwargs: str) -> "GenerationRequest":
        """Pre-LLM half of `run` exposed for callers that own the provider
        call themselves (e.g. the studio's browser-direct flow). Returns the
        `GenerationRequest` after mutating the engine's context_store the same
        way `run` would.
        """
        return _prepare(user_input, dict(kwargs))

    run.prepare = prepare  # type: ignore[attr-defined]
    return engine, run


def _load_data(source: Union[str, Path, Mapping[str, Any]]) -> dict[str, Any]:
    if isinstance(source, Mapping):
        return dict(source)
    return json.loads(Path(source).read_text(encoding="utf-8"))


def _split_override(text: str, sep: str) -> list[str]:
    parts = [p.strip() for p in text.split(sep)]
    return [p for p in parts if p]


def _nondefault_config(config: GenerationConfig) -> dict[str, Any]:
    out: dict[str, Any] = {}
    defaults = asdict(_DEFAULT_CONFIG)
    for k, v in asdict(config).items():
        if v != defaults.get(k):
            out[k] = v
    return out


def _section_to_json(rendered: str) -> Any:
    if _INPUT_MARKER not in rendered:
        return rendered
    return {"template": rendered.replace(_INPUT_MARKER, "{input}")}


def _slot_name_from_template(template: str) -> Optional[str]:
    """Extract the slot name from a template containing a `{name}` placeholder.
    Supports both pure `{name}` and richer templates like `"the topic is {name}"`.
    Returns None if no placeholder is found."""
    m = re.search(r"\{(\w+)\}", template or "")
    return m.group(1) if m else None


def _section_from_json(item: Any):
    if isinstance(item, str):
        return item
    if isinstance(item, Mapping) and "template" in item:
        template = str(item["template"])
        def _render(ctx: BuildContext, _t: str = template):
            return _t.format_map(SafeFormatDict(dict(ctx.request.inputs or {})))
        return _render
    raise ValueError(f"unsupported section entry: {item!r}")

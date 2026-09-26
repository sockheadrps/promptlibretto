"""
prompt_constructor/builder_routes.py

POST /api/builder/chat — agentic registry builder.

The builder assistant is itself defined as a promptlibretto registry.
It talks with the user, decides what to add, and calls builder_api tools
to mutate an in-progress draft. No MCP transport required — tool dispatch
runs directly in-process against builder_api.

SSE events:
  {"type": "draft_id",  "draft_id": "..."}           — emitted once at start
  {"type": "tool_call", "name": "...", "args": {...}, "result": {...}}
  {"type": "chunk",     "text": "..."}
  {"type": "done"}
  {"type": "error",     "message": "..."}
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, AsyncGenerator, Optional

import httpx
from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from promptlibretto import RegistryState, load_registry
from promptlibretto.registry import builder_api as api

router = APIRouter(prefix="/api/builder")

_EXAMPLES_DIR = Path(__file__).parent / "static" / "builder-examples"
_BUILDER_API_DOC = Path(__file__).parent / "BUILDER_API.md"

# ── builder assistant registry ────────────────────────────────────────────────
# Loaded from plpriest_builder.json and hydrated with its bundled state.
# BUILDER_API.md is appended after hydration so the model always sees the
# current tool reference without it being duplicated inside the registry JSON.

def _build_system_prompt() -> str:
    registry_file = _EXAMPLES_DIR / "plpriest_builder.json"
    if registry_file.exists():
        data = json.loads(registry_file.read_text(encoding="utf-8"))
        engine = load_registry(data)
        state = RegistryState.from_dict(data.get("state") or {})
        prompt = engine.hydrate(state)
    else:
        fallback = {
            "registry": {
                "version": 2,
                "title": "Registry Builder",
                "assembly_order": ["base_context.text"],
                "base_context": {
                    "required": True,
                    "template_vars": [],
                    "items": [{"id": "core", "text": (
                        "You are a Prompt Libretto registry builder. Help the user build a registry "
                        "through conversation by calling MCP builder tools. Only call tools on explicit "
                        "user directive. Describe each planned call before making it."
                    )}],
                },
            }
        }
        prompt = load_registry(fallback).hydrate(RegistryState())

    if _BUILDER_API_DOC.exists():
        prompt = prompt.rstrip() + "\n\n" + _BUILDER_API_DOC.read_text(encoding="utf-8")
    return prompt


_BROWSER_BUILDER_PROMPT = """You are the PromptLibretto Registry Assistant.
Build complete PromptLibretto model registries through tool calls.

Rules:
- If there is no draft_id, call registry.draft.create first.
- If the user asks for a complete registry, make reasonable choices and do not ask follow-up questions.
- Prefer this order: meta.set, section.add_item for base_context/personas/sentiment/output_prompt_directions/prompt_endings, assembly.set_order, generation.set, validate, then explain briefly.
- Use user_message only as an assembly_order token; do not create a user_message section.
- Required core sections are base_context, personas, sentiment, output_prompt_directions, and prompt_endings.
- prompt_endings item should use name "endings" and may include items ["you say:"].
- Use assembly_order field tokens like base_context.text, personas.text, sentiment.text, output_prompt_directions.text, memory_recall.text, prompt_endings.endings. Do not use bare section names.
- Valid generation keys only: max_prompt_chars, max_tokens, model, provider, repeat_penalty, retries, temperature, timeout_ms, top_k, top_p. Do not use presence_penalty or frequency_penalty.
- For memory registries, add memory_recall with text "{memory_recall}", configure memory, add useful classifier rules, and include memory_recall.text in assembly_order.
- Section field types: base_context → fields={"text": "..."}. personas/sentiment/any custom section → fields={"text": "..."}. output_prompt_directions/static_injections/runtime_injections → fields={"text": "..."}. prompt_endings → fields={"name": "endings", "text": "..."}.
- fields must contain the actual written prompt text for that section — never empty strings, never placeholders. Write real content based on what the user asked for.
- Keep tool-call arguments compact and valid. After tool calls are applied, answer with a short summary of what was built.
"""

_ASSEMBLY_TOKEN_ALIASES = {
    "base_context": "base_context.text",
    "personas": "personas.text",
    "sentiment": "sentiment.text",
    "static_injections": "static_injections.text",
    "runtime_injections": "runtime_injections.text",
    "output_prompt_directions": "output_prompt_directions.text",
    "memory_recall": "memory_recall.text",
    "prompt_endings": "prompt_endings.endings",
}

_GENERATION_KEYS = {
    "max_prompt_chars",
    "max_tokens",
    "model",
    "provider",
    "repeat_penalty",
    "retries",
    "temperature",
    "timeout_ms",
    "top_k",
    "top_p",
}


def _strip_tool_descriptions(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: _strip_tool_descriptions(val)
            for key, val in value.items()
            if key != "description"
        }
    if isinstance(value, list):
        return [_strip_tool_descriptions(item) for item in value]
    return value


_BROWSER_CORE_TOOLS = {
    "registry.draft.create",
    "registry.meta.set",
    "registry.section.add_item",
    "registry.item.update",
    "registry.assembly.set_order",
    "registry.generation.set",
    "registry.draft.validate",
    "registry.draft.export",
}

def _browser_tools() -> list[dict[str, Any]]:
    core = [
        t for t in _TOOLS
        if t.get("function", {}).get("name") in _BROWSER_CORE_TOOLS
    ]
    return _strip_tool_descriptions(core)


def _normalize_tool_args(name: str, args: dict[str, Any]) -> dict[str, Any]:
    """Accept common model-produced aliases without crashing tool dispatch."""
    out = dict(args or {})
    if "section" in out and "section_key" not in out:
        out["section_key"] = out.pop("section")

    if name == "registry.section.add_item":
        item = out.pop("item", None)
        if isinstance(item, dict):
            out.setdefault("item_id", item.get("id") or item.get("name"))
            fields = dict(item)
            fields.pop("id", None)
            fields.pop("name", None)
            out.setdefault("fields", fields)
        if "fields" not in out:
            reserved = {"draft_id", "section_key", "item_id"}
            fields = {key: val for key, val in out.items() if key not in reserved}
            if fields:
                out["fields"] = fields
                for key in fields:
                    out.pop(key, None)
        # remap context → text for sections where text is the correct field name
        # (personas and sentiment legitimately use context, so skip those)
        _context_uses_text = {"base_context", "output_prompt_directions", "static_injections",
                               "runtime_injections", "prompt_endings"}
        fields = out.get("fields")
        if (isinstance(fields, dict) and "context" in fields and "text" not in fields
                and out.get("section_key") in _context_uses_text):
            fields["text"] = fields.pop("context")

    if name == "registry.item.add_fragment":
        fragment = out.pop("fragment", None)
        if isinstance(fragment, dict):
            out.setdefault("fragment_id", fragment.get("id") or fragment.get("name"))
            for key in ("text", "condition", "label"):
                if key in fragment:
                    out.setdefault(key, fragment[key])

    if name == "registry.item.add_group":
        group = out.pop("group", None)
        if isinstance(group, dict):
            out.setdefault("group_id", group.get("id") or group.get("name"))
            if "items" in group and "directives" not in out:
                out["directives"] = group["items"]
            if "directives" in group:
                out.setdefault("directives", group["directives"])
            if "pre_context" in group:
                out.setdefault("pre_context", group["pre_context"])

    if name == "registry.assembly.set_order" and "assembly_order" in out and "order" not in out:
        out["order"] = out.pop("assembly_order")
    if name == "registry.generation.set" and "generation" in out and "params" not in out:
        out["params"] = out.pop("generation")
    if name == "registry.output_policy.set" and "output_policy" in out and "policy" not in out:
        out["policy"] = out.pop("output_policy")
    if name == "registry.memory.configure" and "memory_config" in out and "config" not in out:
        out["config"] = out.pop("memory_config")

    if name == "registry.draft.create":
        out.pop("draft_id", None)
        draft = out.pop("draft", None)
        if isinstance(draft, dict):
            out.setdefault("title", draft.get("registry_name") or draft.get("title") or draft.get("name"))
            for key in ("description", "template"):
                if key in draft:
                    out.setdefault(key, draft[key])

    if name == "registry.assembly.set_order" and isinstance(out.get("order"), list):
        out["order"] = [_ASSEMBLY_TOKEN_ALIASES.get(token, token) for token in out["order"]]

    if name == "registry.generation.set" and isinstance(out.get("params"), dict):
        out["params"] = {
            key: val
            for key, val in out["params"].items()
            if key in _GENERATION_KEYS
        }

    if name in ("registry.classifier_rule.add", "registry.classifier_rule.update"):
        if "rule" in out and isinstance(out["rule"], dict):
            rule = out.pop("rule")
            for key, val in rule.items():
                out.setdefault(key, val)
        if "ending" in out and "ending_text" not in out:
            out["ending_text"] = out.pop("ending")
        if "endingText" in out and "ending_text" not in out:
            out["ending_text"] = out.pop("endingText")
        if name == "registry.classifier_rule.add" and "description" not in out and out.get("tag"):
            out["description"] = f"When the classifier emits {out['tag']}."

    return out


# ── tool definitions ──────────────────────────────────────────────────────────

_TOOLS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "registry.draft.create",
            "description": "Create a new registry draft. Call this first. Returns draft_id.",
            "parameters": {
                "type": "object",
                "properties": {
                    "title":       {"type": "string", "description": "Registry title"},
                    "description": {"type": "string", "description": "Registry description"},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "registry.draft.get",
            "description": "Return the full current state of the draft.",
            "parameters": {
                "type": "object",
                "properties": {
                    "draft_id": {"type": "string"},
                },
                "required": ["draft_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "registry.draft.validate",
            "description": "Validate the draft. Returns {ok, errors, warnings}. Call before export.",
            "parameters": {
                "type": "object",
                "properties": {
                    "draft_id": {"type": "string"},
                },
                "required": ["draft_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "registry.draft.export",
            "description": "Export the validated draft as Builder-compatible JSON.",
            "parameters": {
                "type": "object",
                "properties": {
                    "draft_id": {"type": "string"},
                },
                "required": ["draft_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "registry.meta.set",
            "description": "Set the registry title and/or description.",
            "parameters": {
                "type": "object",
                "properties": {
                    "draft_id":    {"type": "string"},
                    "title":       {"type": "string"},
                    "description": {"type": "string"},
                },
                "required": ["draft_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "registry.section.add_var",
            "description": (
                "Add a template variable to a section. "
                "Accepts bare names or {braced} format — always stored bare."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "draft_id":    {"type": "string"},
                    "section_key": {
                        "type": "string",
                        "enum": [
                            "base_context", "personas", "sentiment",
                            "static_injections", "runtime_injections",
                            "output_prompt_directions", "memory_recall",
                            "prompt_endings",
                        ],
                    },
                    "var_name": {"type": "string"},
                },
                "required": ["draft_id", "section_key", "var_name"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "registry.section.add_item",
            "description": (
                "Add an item to a section. "
                "personas/sentiment: fields={context}. "
                "base_context: fields={text}. "
                "output_prompt_directions/static_injections/runtime_injections: fields={text}. "
                "prompt_endings: fields={name, text}. "
                "prompt_endings uses 'name' not 'id'."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "draft_id":    {"type": "string"},
                    "section_key": {"type": "string"},
                    "item_id":     {"type": "string", "description": "Unique ID within the section"},
                    "fields":      {"type": "object", "additionalProperties": True, "description": "Item fields (varies by section type)"},
                },
                "required": ["draft_id", "section_key", "item_id", "fields"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "registry.item.update",
            "description": "Update fields on an existing item. 'id' and 'name' are protected.",
            "parameters": {
                "type": "object",
                "properties": {
                    "draft_id":    {"type": "string"},
                    "section_key": {"type": "string"},
                    "item_id":     {"type": "string"},
                    "fields":      {"type": "object"},
                },
                "required": ["draft_id", "section_key", "item_id", "fields"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "registry.item.add_fragment",
            "description": (
                "Add a conditional text fragment to an item. "
                "If condition is given, it is auto-added to section template_vars."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "draft_id":    {"type": "string"},
                    "section_key": {"type": "string"},
                    "item_id":     {"type": "string"},
                    "fragment_id": {"type": "string"},
                    "text":        {"type": "string"},
                    "condition":   {"type": "string", "description": "Template var that gates this fragment"},
                    "label":       {"type": "string"},
                },
                "required": ["draft_id", "section_key", "item_id", "fragment_id", "text"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "registry.item.add_group",
            "description": (
                "Attach an inline directive group to a persona, sentiment, or output_direction item. "
                "Creates the group if it doesn't exist; appends directives if it does."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "draft_id":    {"type": "string"},
                    "section_key": {"type": "string"},
                    "item_id":     {"type": "string"},
                    "group_id":    {"type": "string"},
                    "directives":  {"type": "array", "items": {"type": "string"}},
                    "pre_context": {"type": "string"},
                },
                "required": ["draft_id", "section_key", "item_id", "group_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "registry.group.add_item",
            "description": "Add a directive string to an existing inline group. Searches all items.",
            "parameters": {
                "type": "object",
                "properties": {
                    "draft_id":  {"type": "string"},
                    "group_id":  {"type": "string"},
                    "directive": {"type": "string"},
                },
                "required": ["draft_id", "group_id", "directive"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "registry.assembly.set_order",
            "description": (
                "Set the assembly_order list. "
                "Common tokens: base_context.text, personas.text, sentiment.text, "
                "memory_recall.text, user_message.text, output_prompt_directions.text, prompt_endings.text"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "draft_id": {"type": "string"},
                    "order":    {"type": "array", "items": {"type": "string"}},
                },
                "required": ["draft_id", "order"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "registry.generation.set",
            "description": "Set generation parameter overrides.",
            "parameters": {
                "type": "object",
                "properties": {
                    "draft_id": {"type": "string"},
                    "params": {
                        "type": "object",
                        "description": "Keys: temperature, top_p, top_k, max_tokens, repeat_penalty, retries",
                    },
                },
                "required": ["draft_id", "params"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "registry.output_policy.set",
            "description": "Set output policy fields (e.g. strip_thinking, format).",
            "parameters": {
                "type": "object",
                "properties": {
                    "draft_id": {"type": "string"},
                    "policy":   {"type": "object"},
                },
                "required": ["draft_id", "policy"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "registry.memory.configure",
            "description": (
                "Configure the memory system. "
                "Keys: classifier_url, embed_url, classifier_model, embed_model, "
                "retrieval_top_k, emotional_state_enabled, working_notes_enabled, defaults."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "draft_id": {"type": "string"},
                    "config":   {"type": "object"},
                },
                "required": ["draft_id", "config"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "registry.classifier_rule.add",
            "description": "Add a classifier rule that fires when a tag is detected.",
            "parameters": {
                "type": "object",
                "properties": {
                    "draft_id":    {"type": "string"},
                    "tag":         {"type": "string", "description": "e.g. 'frustration', 'praise'"},
                    "description": {"type": "string"},
                    "ending_text": {"type": "string"},
                    "actions": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "description": "e.g. {type: emotion_delta, dimension: tension, delta: 0.15}",
                        },
                    },
                },
                "required": ["draft_id", "tag", "description"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "registry.classifier_rule.update",
            "description": "Update an existing classifier rule by tag.",
            "parameters": {
                "type": "object",
                "properties": {
                    "draft_id": {"type": "string"},
                    "tag":      {"type": "string"},
                    "fields":   {"type": "object"},
                },
                "required": ["draft_id", "tag", "fields"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "registry.classifier_rule.remove",
            "description": "Remove a classifier rule by tag.",
            "parameters": {
                "type": "object",
                "properties": {
                    "draft_id": {"type": "string"},
                    "tag":      {"type": "string"},
                },
                "required": ["draft_id", "tag"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "registry.style_blend.set",
            "description": (
                "Configure style blending. When the axis dimension exceeds threshold, "
                "secondary blends in."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "draft_id":  {"type": "string"},
                    "section":   {"type": "string", "enum": ["personas", "sentiment"]},
                    "axis":      {"type": "string", "description": "Emotion dimension, e.g. 'playfulness'"},
                    "primary":   {"type": "string", "description": "ID of primary item"},
                    "secondary": {"type": "string", "description": "ID of secondary item"},
                    "threshold": {"type": "number", "description": "0.0–1.0, default 0.60"},
                },
                "required": ["draft_id", "section", "axis", "primary", "secondary"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "registry.style_blend.disable",
            "description": "Disable style blending for one section or all sections.",
            "parameters": {
                "type": "object",
                "properties": {
                    "draft_id": {"type": "string"},
                    "section":  {"type": "string", "description": "Omit to disable all"},
                },
                "required": ["draft_id"],
            },
        },
    },
]


# ── tool dispatch ─────────────────────────────────────────────────────────────

def _dispatch(name: str, args: dict[str, Any]) -> dict[str, Any]:
    """Execute a builder_api function by tool name. Returns a plain result dict."""
    args = _normalize_tool_args(name, args)
    try:
        if name == "registry.draft.create":
            return api.draft_create(**args)
        if name == "registry.draft.get":
            return api.draft_get(**args)
        if name == "registry.draft.validate":
            return api.draft_validate(**args)
        if name == "registry.draft.export":
            return api.draft_export(**args)
        if name == "registry.meta.set":
            return api.meta_set(**args)
        if name == "registry.section.add_var":
            return api.section_add_var(**args)
        if name == "registry.section.add_item":
            fields = args.pop("fields", {}) or {}
            return api.section_add_item(fields=fields, **args)
        if name == "registry.item.update":
            return api.item_update(**args)
        if name == "registry.item.add_fragment":
            return api.item_add_fragment(**args)
        if name == "registry.item.add_group":
            return api.item_add_group(**args)
        if name == "registry.group.add_item":
            return api.group_add_item(**args)
        if name == "registry.assembly.set_order":
            return api.assembly_set_order(**args)
        if name == "registry.generation.set":
            params = args.pop("params", {}) or {}
            return api.generation_set(draft_id=args["draft_id"], params=params)
        if name == "registry.output_policy.set":
            policy = args.pop("policy", {}) or {}
            return api.output_policy_set(draft_id=args["draft_id"], policy=policy)
        if name == "registry.memory.configure":
            config = args.pop("config", {}) or {}
            return api.memory_configure(draft_id=args["draft_id"], config=config)
        if name == "registry.classifier_rule.add":
            return api.classifier_rule_add(**args)
        if name == "registry.classifier_rule.update":
            fields = args.pop("fields", {}) or {}
            return api.classifier_rule_update(fields=fields, **args)
        if name == "registry.classifier_rule.remove":
            return api.classifier_rule_remove(**args)
        if name == "registry.style_blend.set":
            return api.style_blend_set(**args)
        if name == "registry.style_blend.disable":
            return api.style_blend_disable(**args)
        return {"error": f"Unknown tool: {name}"}
    except (KeyError, TypeError, ValueError) as exc:
        return {"error": str(exc)}


# ── request / response models ─────────────────────────────────────────────────

class BuilderChatRequest(BaseModel):
    messages: list[dict[str, Any]]
    model: str = "llama3.1"
    base_url: str = "http://localhost:11434"
    chat_path: str = "/api/chat"
    draft_id: Optional[str] = None
    # Generation params for the builder assistant itself
    temperature: float = Field(default=0.4, ge=0.0, le=2.0)
    max_tokens: int = Field(default=1024, ge=1)


class BuilderSessionRequest(BaseModel):
    draft_id: Optional[str] = None


class BuilderToolRequest(BaseModel):
    name: str
    args: dict[str, Any] = Field(default_factory=dict)
    draft_id: Optional[str] = None


# ── endpoint ──────────────────────────────────────────────────────────────────

_SYSTEM_PROMPT: Optional[str] = None


def _get_system_prompt() -> str:
    global _SYSTEM_PROMPT
    if _SYSTEM_PROMPT is None:
        _SYSTEM_PROMPT = _build_system_prompt()
    return _SYSTEM_PROMPT


@router.post("/session")
async def builder_session(req: BuilderSessionRequest) -> dict[str, Any]:
    """Return prompt/tool metadata for browser-delegated builder chat."""
    draft_id = req.draft_id
    if not draft_id:
        draft_id = api.draft_create()["draft_id"]
    return {
        "draft_id": draft_id,
        "system_prompt": _BROWSER_BUILDER_PROMPT,
        "tools": _browser_tools(),
    }


class ImportRegistryRequest(BaseModel):
    registry: dict[str, Any]


@router.post("/import")
async def import_registry(req: ImportRegistryRequest) -> dict[str, Any]:
    """Create a server-side draft from an existing registry JSON."""
    result = api.draft_import(req.registry)
    return result


@router.post("/tool")
async def builder_tool(req: BuilderToolRequest) -> dict[str, Any]:
    """Apply one builder tool call from a browser-delegated LLM response."""
    args = _normalize_tool_args(req.name, dict(req.args or {}))
    if req.draft_id and req.name != "registry.draft.create" and not args.get("draft_id"):
        args["draft_id"] = req.draft_id
    result = _dispatch(req.name, args)
    if not isinstance(result, dict):
        result = {"result": result}
    return {
        "name": req.name,
        "args": args,
        "result": result,
        "draft_id": result.get("draft_id") or args.get("draft_id") or req.draft_id,
    }


@router.post("/chat")
async def builder_chat(req: BuilderChatRequest) -> StreamingResponse:
    async def generate() -> AsyncGenerator[str, None]:
        def emit(event: dict) -> str:
            return f"data: {json.dumps(event)}\n\n"

        draft_id = req.draft_id
        messages = list(req.messages)
        base_url = req.base_url.rstrip("/")
        url = f"{base_url}{req.chat_path if req.chat_path.startswith('/') else '/' + req.chat_path}"

        # If no draft_id, create one and emit it so the client can track it.
        if not draft_id:
            result = api.draft_create()
            draft_id = result["draft_id"]
            yield emit({"type": "draft_id", "draft_id": draft_id})

        system_prompt = _get_system_prompt()
        full_messages = [{"role": "system", "content": system_prompt}, *messages]

        # Detect payload shape: openai if path contains /v1/, else ollama.
        openai_shape = "/v1/" in req.chat_path

        def _build_payload(msgs: list) -> dict[str, Any]:
            if openai_shape:
                return {
                    "model": req.model,
                    "messages": msgs,
                    "tools": _TOOLS,
                    "stream": False,
                    "temperature": req.temperature,
                    "max_tokens": req.max_tokens,
                }
            return {
                "model": req.model,
                "messages": msgs,
                "tools": _TOOLS,
                "stream": False,
                "options": {
                    "temperature": req.temperature,
                    "num_predict": req.max_tokens,
                },
            }

        def _extract_message(data: dict) -> dict:
            """Return the assistant message dict from either Ollama or OpenAI response."""
            # Ollama: {"message": {"role": "assistant", "content": "...", "tool_calls": [...]}}
            if "message" in data:
                return data["message"] or {}
            # OpenAI: {"choices": [{"message": {...}}]}
            choices = data.get("choices") or []
            if choices:
                return (choices[0] or {}).get("message") or {}
            return {}

        try:
            async with httpx.AsyncClient() as client:
                while True:
                    resp = await client.post(url, json=_build_payload(full_messages), timeout=120.0)
                    resp.raise_for_status()
                    data = resp.json()

                    # Surface any server-side error field before proceeding.
                    if "error" in data and "message" not in data and "choices" not in data:
                        yield emit({"type": "error", "message": str(data["error"])})
                        break

                    msg = _extract_message(data)
                    tool_calls = msg.get("tool_calls") or []

                    if not tool_calls:
                        text = msg.get("content") or ""
                        if text:
                            chunk_size = 40
                            for i in range(0, len(text), chunk_size):
                                yield emit({"type": "chunk", "text": text[i:i + chunk_size]})
                        else:
                            # Model returned nothing — emit a generic nudge so
                            # the user isn't staring at blank output.
                            yield emit({"type": "chunk", "text": "(no response from model — check your connection settings)"})
                        break

                    # Append the assistant turn with its tool calls.
                    full_messages.append({
                        "role": "assistant",
                        "content": msg.get("content") or "",
                        "tool_calls": tool_calls,
                    })

                    for tc in tool_calls:
                        fn = tc.get("function") or {}
                        name = fn.get("name", "")
                        raw_args = fn.get("arguments") or {}
                        if isinstance(raw_args, str):
                            try:
                                raw_args = json.loads(raw_args)
                            except json.JSONDecodeError:
                                raw_args = {}

                        result = _dispatch(name, dict(raw_args))
                        yield emit({"type": "tool_call", "name": name, "args": raw_args, "result": result})

                        # OpenAI format requires tool_call_id on the result message.
                        tool_msg: dict[str, Any] = {
                            "role": "tool",
                            "content": json.dumps(result),
                        }
                        if openai_shape:
                            tool_msg["tool_call_id"] = tc.get("id", "call_0")
                        full_messages.append(tool_msg)

            yield emit({"type": "done", "draft_id": draft_id})

        except httpx.HTTPStatusError as exc:
            body = exc.response.text[:300]
            yield emit({"type": "error", "message": f"LLM {exc.response.status_code}: {body}"})
        except Exception as exc:
            yield emit({"type": "error", "message": str(exc)})

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/draft/{draft_id}")
async def get_draft(draft_id: str) -> dict[str, Any]:
    """Return the current draft state. Useful for the UI to display progress."""
    try:
        return api.draft_get(draft_id)
    except KeyError as exc:
        from fastapi import HTTPException
        raise HTTPException(404, str(exc))


@router.post("/draft/{draft_id}/validate")
async def validate_draft(draft_id: str) -> dict[str, Any]:
    """Validate the draft outside of a chat turn."""
    try:
        return api.draft_validate(draft_id)
    except KeyError as exc:
        from fastapi import HTTPException
        raise HTTPException(404, str(exc))


@router.post("/draft/{draft_id}/export")
async def export_draft(draft_id: str) -> dict[str, Any]:
    """Export the draft as Builder-compatible JSON."""
    try:
        return api.draft_export(draft_id)
    except KeyError as exc:
        from fastapi import HTTPException
        raise HTTPException(404, str(exc))

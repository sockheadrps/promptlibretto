"""Preset prompt routes used by the demo server.

These are intentionally generic so the engine stays domain-agnostic. Each
preset shows a different composition style — direct instruction, persona +
examples, structured task, summarisation, etc. — so the GUI can demonstrate
the engine's full surface area against a local model.
"""
from __future__ import annotations

from prompt_engine import (
    CompositeBuilder,
    InjectionTemplate,
    PromptAssetRegistry,
    PromptRoute,
    PromptRouter,
    section,
)
from prompt_engine.builders.builder import BuildContext


# ----------------------------------------------------------------------
# asset bootstrap
# ----------------------------------------------------------------------

def build_asset_registry() -> PromptAssetRegistry:
    reg = PromptAssetRegistry()

    reg.add_frame(
        "core",
        "You are a careful, helpful assistant. Respond clearly and directly. "
        "Do not fabricate facts. If a request is ambiguous, ask one focused question.",
    )
    reg.add_frame(
        "creative",
        "You are an inventive collaborator. Lean into vivid, specific language. "
        "Surprise the reader without losing clarity.",
    )
    reg.add_frame(
        "analyst",
        "You are a precise analyst. Prefer structure, evidence, and named tradeoffs. "
        "Distinguish facts from inferences.",
    )

    reg.add_rule("brevity", "Be concise. No filler, no apologies, no preamble.")
    reg.add_rule("format_markdown", "Use markdown when it aids scanning, but never gratuitously.")
    reg.add_rule("no_meta", "Do not narrate what you are about to do — just do it.")

    reg.add_persona("plain", "Voice: clear, plainspoken, no jargon.")
    reg.add_persona("expert", "Voice: domain expert, but explain unfamiliar terms inline.")
    reg.add_persona("editor", "Voice: a sharp editor — every sentence must earn its place.")

    reg.add_ending("standard", "Begin your response now.")
    reg.add_ending("structured", "Respond using the requested structure exactly.")

    reg.add_examples(
        "concise_answers",
        [
            "Q: What is entropy in 1 sentence?\nA: Entropy is a measure of how many microscopic configurations correspond to the same macroscopic state.",
            "Q: Why does ice float?\nA: Ice has lower density than liquid water because hydrogen bonding holds it in a more open lattice.",
        ],
    )
    reg.add_nudges(
        "creative_lift",
        [
            "Lead with a concrete image, not an abstraction.",
            "Vary sentence length deliberately for rhythm.",
            "Pick the unexpected verb when two would do.",
        ],
    )

    reg.add_injector(
        "tighten",
        InjectionTemplate(
            instructions="Compress aggressively. Aim for the shortest answer that is still complete.",
            generation_overrides={"temperature": 0.4, "max_tokens": 200},
        ),
    )
    reg.add_injector(
        "expand",
        InjectionTemplate(
            instructions="Be expansive. Use a worked example or analogy where it helps.",
            generation_overrides={"temperature": 0.85, "max_tokens": 600},
        ),
    )
    reg.add_injector(
        "json_only",
        InjectionTemplate(
            instructions=(
                "Return ONLY valid minified JSON. No prose, no code fences, no commentary."
            ),
            output_policy={
                "strip_prefixes": ["```json", "```"],
                "strip_patterns": [r"^```$"],
                "require_patterns": [r"^\s*[\{\[]"],
                "forbidden_substrings": ["I cannot", "As an AI"],
            },
        ),
    )
    reg.add_injector(
        "markdown",
        InjectionTemplate(
            instructions=(
                "Format the response using markdown. Use ## headings to organise sections, "
                "bullet lists for enumerations, **bold** for key terms, and `code` for "
                "technical or literal values. Keep formatting purposeful — never decorative."
            ),
        ),
    )

    return reg


# ----------------------------------------------------------------------
# builders
# ----------------------------------------------------------------------

def _frame(name: str):
    def fn(ctx: BuildContext) -> str:
        return ctx.assets.frame(name)
    return fn


def _rule(name: str):
    def fn(ctx: BuildContext) -> str:
        return ctx.assets.rule(name)
    return fn


def _persona(name: str):
    def fn(ctx: BuildContext) -> str:
        return ctx.assets.persona(name)
    return fn


def _ending(name: str):
    def fn(ctx: BuildContext) -> str:
        return ctx.assets.ending(name)
    return fn


def _user_input(field: str = "input", label: str = "Request"):
    def fn(ctx: BuildContext) -> str:
        value = ctx.request.inputs.get(field, "")
        if not value:
            return ""
        return f"{label}:\n{value}"
    return fn


def _example_pool(pool: str, count: int = 1, label: str = "Examples"):
    def fn(ctx: BuildContext) -> str:
        picks = ctx.assets.pick_examples(pool, count)
        if not picks:
            return ""
        return f"{label}:\n" + "\n\n".join(picks)
    return fn


def _nudge_pool(pool: str):
    def fn(ctx: BuildContext) -> str:
        nudge = ctx.assets.pick_nudge(pool)
        return f"Style nudge: {nudge}" if nudge else ""
    return fn


def _suggest_count_instruction():
    def fn(ctx: BuildContext) -> str:
        try:
            n = int(ctx.request.inputs.get("count", 5))
        except (TypeError, ValueError):
            n = 5
        n = max(1, min(n, 20))
        return (
            f"Produce exactly {n} distinct overlay suggestions that would plausibly "
            "change responses for this base. Each suggestion is a FILL-IN-THE-BLANK "
            "overlay — describe the variable the user should pin down, not a pre-baked "
            "instruction. Vary what they control (audience, tone, constraint, recent "
            "signal, goal, emphasis).\n\n"
            "For each overlay output:\n"
            "- name: short snake_case id\n"
            "- priority: integer, higher = applied first\n"
            "- scenario: a noun phrase naming the dimension the user will specify "
            "(e.g. \"the maximum acceptable drive time from the chosen destination\"), "
            "NOT a full instruction sentence\n"
            "- placeholder: an example value the user might fill in (e.g. \"14 hours\")\n"
            "- rationale: one short sentence explaining why this dimension matters here\n\n"
            "Schema: {\"overlays\": [{\"name\": string, \"priority\": int, "
            "\"scenario\": string, \"placeholder\": string, \"rationale\": string}]}"
        )
    return fn


def _pending_user_input_section():
    """Include the user's current draft prompt so suggestions are tailored.

    Without this, the model only sees the base context and produces generic
    dimensions that often duplicate information already present in the user's
    actual question.
    """
    def fn(ctx: BuildContext) -> str:
        text = str(ctx.request.inputs.get("user_input") or "").strip()
        if not text:
            return ""
        return (
            "The user is about to send this specific request (tailor overlays to it, "
            "and do NOT suggest dimensions the request already resolves):\n" + text
        )
    return fn


def _turn_user_prompt():
    def fn(ctx: BuildContext) -> str:
        text = str(ctx.request.inputs.get("user_prompt") or "").strip()
        return f"Original user prompt:\n{text}" if text else ""
    return fn


def _turn_assistant_output():
    def fn(ctx: BuildContext) -> str:
        text = str(ctx.request.inputs.get("assistant_output") or "").strip()
        return f"Assistant output:\n{text}" if text else ""
    return fn


def _turn_user_response():
    def fn(ctx: BuildContext) -> str:
        text = str(ctx.request.inputs.get("user_response") or "").strip()
        return f"User follow-up:\n{text}" if text else ""
    return fn


def _existing_overlays_section():
    """Render the user's existing overlays so the model can avoid duplicates."""
    def fn(ctx: BuildContext) -> str:
        existing = ctx.request.inputs.get("existing") or []
        if not existing:
            return ""
        lines = []
        for o in existing:
            try:
                name = str(o.get("name") or "").strip()
                text = str(o.get("text") or "").strip()
                if not name or not text:
                    continue
                lines.append(f"- {name}: {text}")
            except AttributeError:
                continue
        if not lines:
            return ""
        return (
            "Existing overlays the user already has (do NOT suggest these or trivial "
            "rewordings — produce genuinely new angles):\n" + "\n".join(lines)
        )
    return fn


# ----------------------------------------------------------------------
# routes
# ----------------------------------------------------------------------

def build_router(_assets: PromptAssetRegistry) -> PromptRouter:
    router = PromptRouter(default_route="default")

    router.register(
        PromptRoute(
            name="default",
            description="General assistant — clear, direct, neutral voice.",
            builder=CompositeBuilder(
                name="default",
                system_sections=(
                    _frame("core"),
                    _rule("no_meta"),
                    _persona("plain"),
                ),
                user_sections=(
                    _user_input(),
                    _ending("standard"),
                ),
            ),
        )
    )

    router.register(
        PromptRoute(
            name="concise",
            description="Concise factual answer with a worked example.",
            builder=CompositeBuilder(
                name="concise",
                system_sections=(
                    _frame("core"),
                    _rule("brevity"),
                    _persona("editor"),
                ),
                user_sections=(
                    _example_pool("concise_answers", count=2),
                    _user_input(label="Question"),
                    _ending("standard"),
                ),
                generation_overrides={"temperature": 0.5, "max_tokens": 220},
            ),
        )
    )

    router.register(
        PromptRoute(
            name="creative",
            description="Creative composition with style nudges.",
            builder=CompositeBuilder(
                name="creative",
                system_sections=(
                    _frame("creative"),
                    _persona("expert"),
                ),
                user_sections=(
                    _nudge_pool("creative_lift"),
                    _user_input(label="Brief"),
                    _ending("standard"),
                ),
                generation_overrides={"temperature": 0.95, "max_tokens": 500},
            ),
        )
    )

    router.register(
        PromptRoute(
            name="analyst",
            description="Structured analysis with explicit tradeoffs.",
            builder=CompositeBuilder(
                name="analyst",
                system_sections=(
                    _frame("analyst"),
                    _rule("format_markdown"),
                    _rule("no_meta"),
                ),
                user_sections=(
                    _user_input(label="Topic"),
                    section(
                        "Structure your response with these sections: "
                        "**Summary**, **Key facts**, **Tradeoffs**, **Open questions**."
                    ),
                    _ending("structured"),
                ),
                generation_overrides={"temperature": 0.6, "max_tokens": 700},
            ),
        )
    )

    router.register(
        PromptRoute(
            name="suggest_overlays",
            description="Suggest possible context overlays from a base context.",
            builder=CompositeBuilder(
                name="suggest_overlays",
                system_sections=(
                    _frame("analyst"),
                    section(
                        "You suggest short-lived CONTEXT OVERLAYS that a user could "
                        "attach on top of the given base context to steer responses. "
                        "Each overlay has a short snake_case name, an integer priority "
                        "(higher = applied first), and 1–2 sentences of text that "
                        "states a concrete transient fact, mood, constraint, or emphasis. "
                        "Return strictly minified JSON, no prose, no code fences."
                    ),
                ),
                user_sections=(
                    _user_input(label="Base context"),
                    _pending_user_input_section(),
                    _existing_overlays_section(),
                    _suggest_count_instruction(),
                ),
                generation_overrides={"temperature": 0.7, "max_tokens": 700},
                output_policy={
                    "strip_prefixes": ["```json", "```"],
                    "strip_patterns": [r"^```$"],
                    "require_patterns": [r"^\s*\{"],
                },
            ),
        )
    )

    router.register(
        PromptRoute(
            name="compact_turn",
            description="Densify a user follow-up into a 1-2 sentence overlay.",
            builder=CompositeBuilder(
                name="compact_turn",
                system_sections=(
                    section(
                        "You compress an iteration turn into a SHORT overlay (1-2 sentences) "
                        "that captures the new constraint, preference, correction, or emphasis "
                        "the user just revealed. Do NOT restate the original prompt or output. "
                        "Do NOT add new information. Write in third person, present tense, as a "
                        "standing instruction the model can apply on the next turn. Output ONLY "
                        "the overlay text — no preamble, no quotes, no markdown."
                    ),
                ),
                user_sections=(
                    _turn_user_prompt(),
                    _turn_assistant_output(),
                    _turn_user_response(),
                    section("Write the overlay text now."),
                ),
                generation_overrides={"temperature": 0.4, "max_tokens": 160},
            ),
        )
    )

    router.register(
        PromptRoute(
            name="json_extract",
            description="Extract structured JSON from a freeform input.",
            builder=CompositeBuilder(
                name="json_extract",
                system_sections=(
                    _frame("analyst"),
                    section(
                        "Output strictly minified JSON with no surrounding text. "
                        "If a field is unknown, use null."
                    ),
                ),
                user_sections=(
                    _user_input(label="Source"),
                    section(
                        "Schema: {\"title\": string, \"summary\": string, "
                        "\"entities\": string[], \"sentiment\": \"positive\"|\"neutral\"|\"negative\"}"
                    ),
                ),
                generation_overrides={"temperature": 0.2, "max_tokens": 400},
                output_policy={
                    "strip_prefixes": ["```json", "```"],
                    "strip_patterns": [r"^```$"],
                    "require_patterns": [r"^\s*\{"],
                },
            ),
        )
    )

    return router

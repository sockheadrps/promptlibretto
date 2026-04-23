from __future__ import annotations

from promptlibretto import (
    CompositeBuilder,
    InjectionTemplate,
    PromptAssetRegistry,
    PromptRoute,
    PromptRouter,
    section,
)
from promptlibretto.builders.builder import BuildContext


def build_asset_registry() -> PromptAssetRegistry:
    reg = PromptAssetRegistry()

    reg.add(
        "frame.core",
        "You are a careful, helpful assistant. Respond clearly and directly. "
        "Do not fabricate facts. If a request is ambiguous, ask one focused question.",
    )
    reg.add(
        "frame.creative",
        "You are an inventive collaborator. Lean into vivid, specific language. "
        "Surprise the reader without losing clarity.",
    )
    reg.add(
        "frame.analyst",
        "You are a precise analyst. Prefer structure, evidence, and named tradeoffs. "
        "Distinguish facts from inferences.",
    )

    reg.add("rule.brevity", "Be concise. No filler, no apologies, no preamble.")
    reg.add("rule.format_markdown", "Use markdown when it aids scanning, but never gratuitously.")
    reg.add("rule.no_meta", "Do not narrate what you are about to do — just do it.")

    reg.add("persona.plain", "Voice: clear, plainspoken, no jargon.")
    reg.add("persona.expert", "Voice: domain expert, but explain unfamiliar terms inline.")
    reg.add("persona.editor", "Voice: a sharp editor — every sentence must earn its place.")

    reg.add("ending.standard", "Begin your response now.")
    reg.add("ending.structured", "Respond using the requested structure exactly.")

    reg.add_pool(
        "concise_answers",
        [
            "Q: What is entropy in 1 sentence?\nA: Entropy is a measure of how many microscopic configurations correspond to the same macroscopic state.",
            "Q: Why does ice float?\nA: Ice has lower density than liquid water because hydrogen bonding holds it in a more open lattice.",
        ],
    )
    reg.add_pool(
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


def _asset(name: str):
    def fn(ctx: BuildContext) -> str:
        return ctx.assets.get(name)
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
        picks = ctx.assets.pick(pool, count)
        if not picks:
            return ""
        return f"{label}:\n" + "\n\n".join(picks)
    return fn


def _nudge_pool(pool: str):
    def fn(ctx: BuildContext) -> str:
        nudge = ctx.assets.pick_one(pool)
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
    def fn(ctx: BuildContext) -> str:
        text = str(ctx.request.inputs.get("user_input") or "").strip()
        if not text:
            return ""
        return (
            "The user is about to send this specific request (tailor overlays to it, "
            "and do NOT suggest dimensions the request already resolves):\n" + text
        )
    return fn


def _existing_overlays_section():
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


def build_router(_assets: PromptAssetRegistry) -> PromptRouter:
    router = PromptRouter(default_route="default")

    router.register(
        PromptRoute(
            name="default",
            description="General assistant — clear, direct, neutral voice.",
            builder=CompositeBuilder(
                name="default",
                system_sections=(
                    _asset("frame.core"),
                    _asset("rule.no_meta"),
                    _asset("persona.plain"),
                ),
                user_sections=(
                    _user_input(),
                    _asset("ending.standard"),
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
                    _asset("frame.core"),
                    _asset("rule.brevity"),
                    _asset("persona.editor"),
                ),
                user_sections=(
                    _example_pool("concise_answers", count=2),
                    _user_input(label="Question"),
                    _asset("ending.standard"),
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
                    _asset("frame.creative"),
                    _asset("persona.expert"),
                ),
                user_sections=(
                    _nudge_pool("creative_lift"),
                    _user_input(label="Brief"),
                    _asset("ending.standard"),
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
                    _asset("frame.analyst"),
                    _asset("rule.format_markdown"),
                    _asset("rule.no_meta"),
                ),
                user_sections=(
                    _user_input(label="Topic"),
                    section(
                        "Structure your response with these sections: "
                        "**Summary**, **Key facts**, **Tradeoffs**, **Open questions**."
                    ),
                    _asset("ending.structured"),
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
                    _asset("frame.analyst"),
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
            name="json_extract",
            description="Extract structured JSON from a freeform input.",
            builder=CompositeBuilder(
                name="json_extract",
                system_sections=(
                    _asset("frame.analyst"),
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

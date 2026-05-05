"""Build a Promptlibretto registry entirely with Python dataclasses.

Run:
    python expy_regmodel.py

The example prints a hydrated prompt preview, then the registry JSON that can
be imported into Studio.
"""

from __future__ import annotations

import json

from promptlibretto import (
    ContextItem,
    Fragment,
    Group,
    OutputDirection,
    Persona,
    PromptEnding,
    Registry,
    RegistryState,
    Route,
    RuntimeInjection,
    Scale,
    Section,
    SectionState,
    Sentiment,
    StaticInjection,
    hydrate,
)


def build_registry() -> Registry:
    """Create a complete schema-v2 registry with typed Python classes."""

    # ── Groups ──────────────────────────────────────────────────────────
    # All snippet collections live here; items reference them by id.

    groups = Section(
        id="groups",
        required=False,
        items=[
            # Persona directive groups
            Group(
                id="curator_voice_directives",
                label="Curator Voice — Directives",
                items=[
                    "Explain one historical detail before acknowledging the weird part.",
                    "Use careful institutional language.",
                    "Offer reassurance that sounds slightly too rehearsed.",
                ],
            ),
            Group(
                id="haunted_docent_directives",
                label="Haunted Docent — Directives",
                items=[
                    "Treat supernatural activity like a known building maintenance issue.",
                    "Politely direct visitors away from the exhibit.",
                    "Make the warning sound like standard museum etiquette.",
                ],
            ),
            Group(
                id="overconfident_intern_directives",
                label="Overconfident Intern — Directives",
                items=[
                    "Use one museum term slightly wrong.",
                    "Over-explain the obvious.",
                    "Sound proud that you are handling the incident.",
                ],
            ),
            # Sentiment nudge groups
            Group(
                id="elegant_alarm_nudges",
                items=[
                    "Avoid saying danger directly.",
                    "Make the warning sound like a refined courtesy.",
                    "Use one phrase that belongs in a museum placard.",
                ],
            ),
            Group(
                id="academic_denial_nudges",
                items=[
                    "Call the strange event an interpretive feature.",
                    "Reference provenance or conservation.",
                    "Avoid admitting that the artifact moved.",
                ],
            ),
            Group(
                id="quiet_panic_nudges",
                items=[
                    "Keep the sentence short.",
                    "Mention staff without explaining why.",
                    "End with a practical instruction.",
                ],
            ),
            # Shared tone examples
            Group(
                id="normal_examples",
                pre_context="Tone references, if useful:",
                items=[
                    "Visitors are invited to continue breathing normally.",
                    "The museum asks that guests refrain from making eye contact with the reliquary.",
                    "This gallery is best enjoyed without sudden promises to ancient objects.",
                    "Please keep all personal reflections inside your own reflection.",
                ],
            ),
        ],
    )

    # ── Base context ─────────────────────────────────────────────────────

    base_context = Section(
        id="base_context",
        required=True,
        items=[
            ContextItem(
                id="tour_stop",
                text=(
                    "You are the official audio guide narrator for a prestigious "
                    "museum. You must sound calm, polished, and educational, even "
                    "when the exhibit appears to be doing something it should not do."
                ),
                template_vars=["gallery", "artifact", "visitor_behavior", "weird_detail"],
                template_defaults={
                    "gallery": "the nocturnal antiquities wing",
                    "artifact": "a bronze mask with no eye holes",
                    "visitor_behavior": "a visitor is whispering back to the exhibit",
                    "weird_detail": "the shadow is moving half a second late",
                },
                fragments=[
                    Fragment(id="frag_gallery",   condition="gallery",          text="Current gallery: {gallery}."),
                    Fragment(id="frag_artifact",  condition="artifact",         text="Featured artifact: {artifact}."),
                    Fragment(id="frag_behavior",  condition="visitor_behavior", text="Visitor situation: {visitor_behavior}."),
                    Fragment(id="frag_weird",     condition="weird_detail",     text="Unverified detail: {weird_detail}."),
                ],
            )
        ],
    )

    # ── Personas ─────────────────────────────────────────────────────────

    personas = Section(
        id="personas",
        required=True,
        items=[
            Persona(
                id="curator_voice",
                context=(
                    "You are a composed museum narrator. You refuse to admit panic, "
                    "but your word choices reveal you have noticed the problem."
                ),
                groups=["curator_voice_directives"],
            ),
            Persona(
                id="haunted_docent",
                context=(
                    "You are a museum docent who has seen this happen before and is "
                    "trying not to make the visitors run."
                ),
                groups=["haunted_docent_directives"],
            ),
            Persona(
                id="overconfident_intern",
                context=(
                    "You are the new intern recording emergency audio-guide updates. "
                    "You are underqualified, excited, and pretending this is fine."
                ),
                groups=["overconfident_intern_directives"],
            ),
        ],
    )

    # ── Sentiment ────────────────────────────────────────────────────────

    sentiment = Section(
        id="sentiment",
        required=True,
        items=[
            Sentiment(
                id="elegant_alarm",
                context="You are alarmed, but in a velvet-rope museum voice.",
                scale=Scale(
                    scale_descriptor="polished concern",
                    template="Composure: {value}/10 — {scale_descriptor}.",
                    default_value=7,
                    randomize=True,
                ),
                groups=["elegant_alarm_nudges"],
            ),
            Sentiment(
                id="academic_denial",
                context="You explain everything as scholarship, even when that is absurd.",
                scale=Scale(
                    scale_descriptor="scholarly denial",
                    template="Composure: {value}/10 — {scale_descriptor}.",
                    default_value=6,
                ),
                groups=["academic_denial_nudges"],
            ),
            Sentiment(
                id="quiet_panic",
                context="Your calm is cracking, but only around the edges.",
                scale=Scale(
                    scale_descriptor="barely contained panic",
                    template="Composure: {value}/10 — {scale_descriptor}.",
                    default_value=4,
                ),
                groups=["quiet_panic_nudges"],
            ),
        ],
    )

    # ── Static injections ────────────────────────────────────────────────

    static_injections = Section(
        id="static_injections",
        required=False,
        items=[
            StaticInjection(
                id="house_rules",
                memory_tag="unsafe_curiosity",
                text=(
                    "Museum policy: guests should not touch artifacts, repeat phrases "
                    "spoken by exhibits, enter roped areas, or accept gifts from displays."
                ),
            ),
            StaticInjection(
                id="incident_history",
                memory_tag="artifact_recurs",
                text=(
                    "Internal note: this artifact has previously caused cold spots, "
                    "incorrect reflections, missing audio tracks, and visitors reporting "
                    "that the exhibit described them first."
                ),
            ),
        ],
    )

    # ── Runtime injections ───────────────────────────────────────────────

    runtime_injections = Section(
        id="runtime_injections",
        required=False,
        items=[
            RuntimeInjection(
                id="staff_arrival",
                template_vars=["staff_name"],
                template_defaults={"staff_name": "Marisol"},
                include_sections=["base_context", "personas", "sentiment"],
                memory_tag="staff_called",
                text=(
                    "{staff_name} from visitor services has arrived. Sound relieved, "
                    "but keep the announcement suitable for a public museum audio guide."
                ),
            ),
            RuntimeInjection(
                id="artifact_addressed_visitor",
                include_sections=["base_context", "sentiment", "static_injections"],
                memory_tag="artifact_speaks",
                text=(
                    "The artifact has addressed a visitor directly. Instruct guests not "
                    "to answer questions from the exhibit."
                ),
            ),
        ],
    )

    # ── Memory recall ─────────────────────────────────────────────────────

    memory_recall = Section(
        id="memory_recall",
        required=False,
        items=[
            {
                "id": "recall",
                "text": "{memory_recall}",
                "template_vars": ["memory_recall"],
                "template_defaults": {"memory_recall": ""},
            }
        ],
    )

    # ── Output directions ─────────────────────────────────────────────────

    output_prompt_directions = Section(
        id="output_prompt_directions",
        required=True,
        items=[
            OutputDirection(
                id="audio_guide_rules",
                text=(
                    "Write one museum audio-guide line in polished prose. "
                    "Use 1-3 complete sentences. No headings, no bullet lists. "
                    "Do not say you are an AI. Be funny through calm institutional "
                    "understatement, not jokes."
                ),
            )
        ],
    )

    # ── Prompt endings ────────────────────────────────────────────────────

    prompt_endings = Section(
        id="prompt_endings",
        required=True,
        items=[
            PromptEnding(
                id="endings",
                items=[
                    "Audio guide:",
                    "Museum narration:",
                    "Visitor advisory:",
                ],
            )
        ],
    )

    # ── Default state ─────────────────────────────────────────────────────
    # What's selected when no explicit state is passed.

    default_state = RegistryState(sections={
        "base_context":             SectionState(selected="tour_stop"),
        "personas":                 SectionState(selected="curator_voice",
                                                 array_modes={"groups[curator_voice_directives]": "random:1"}),
        "sentiment":                SectionState(selected="elegant_alarm",
                                                 slider=7, slider_random=True,
                                                 array_modes={"groups[elegant_alarm_nudges]": "random:1"}),
        "static_injections":        SectionState(selected=["house_rules"]),
        "runtime_injections":       SectionState(selected=[]),
        "memory_recall":            SectionState(selected=["recall"]),
        "groups":                   SectionState(selected=["normal_examples"]),
        "output_prompt_directions": SectionState(selected="audio_guide_rules"),
        "prompt_endings":           SectionState(selected="endings",
                                                 array_modes={"items": "random:1"}),
    })

    return Registry(
        title="Haunted Museum Audio Guide",
        description=(
            "A complete Promptlibretto v2 registry built with Python classes. "
            "Generates calm museum narration for exhibits behaving incorrectly."
        ),
        assembly_order=[
            "output_prompt_directions",
            "base_context.text",
            "personas.context",
            "personas.groups",
            "sentiment.context",
            "sentiment.groups",
            "sentiment.scale",
            "injections",
            "memory_recall.text",
            "groups[normal_examples]",
            "prompt_endings",
        ],
        sections={
            "base_context":             base_context,
            "personas":                 personas,
            "sentiment":                sentiment,
            "static_injections":        static_injections,
            "runtime_injections":       runtime_injections,
            "memory_recall":            memory_recall,
            "output_prompt_directions": output_prompt_directions,
            "groups":                   groups,
            "prompt_endings":           prompt_endings,
        },
        routes={
            "short_advisory": Route(
                id="short_advisory",
                assembly_order=[
                    "output_prompt_directions",
                    "base_context.text",
                    "sentiment.context",
                    "injections",
                    "prompt_endings",
                ],
                generation={"max_tokens": 80, "temperature": 0.85},
                output_policy={"max_length": 280},
            ),
        },
        generation={
            "temperature": 0.95,
            "top_p": 0.9,
            "top_k": 40,
            "max_tokens": 160,
            "repeat_penalty": 1.12,
            "retries": 2,
        },
        output_policy={
            "min_length": 30,
            "max_length": 500,
            "collapse_whitespace": True,
            "forbidden_substrings": ["As an AI", "I cannot help", "I'm an AI"],
        },
        memory_rules=[
            {
                "tag": "unsafe_curiosity",
                "actions": [
                    {"type": "inject", "section": "static_injections", "item": "house_rules"},
                    {"type": "sentiment", "value": "elegant_alarm"},
                ],
            },
            {
                "tag": "artifact_recurs",
                "actions": [
                    {"type": "inject", "section": "static_injections", "item": "incident_history"},
                    {"type": "persona", "value": "haunted_docent"},
                    {"type": "sentiment", "value": "academic_denial"},
                ],
            },
            {
                "tag": "artifact_speaks",
                "actions": [
                    {"type": "inject", "section": "runtime_injections", "item": "artifact_addressed_visitor"},
                    {"type": "sentiment", "value": "quiet_panic"},
                ],
            },
            {
                "tag": "staff_called",
                "actions": [
                    {"type": "inject", "section": "runtime_injections", "item": "staff_arrival"},
                    {"type": "persona", "value": "curator_voice"},
                ],
            },
        ],
        memory_config={
            "classifier_url": "http://localhost:8080",
            "classifier_model": "Qwen3.5-9B-Q4_K_M.gguf",
            "embed_url": "http://localhost:11111",
            "embed_model": "nomic-embed-text",
            "top_k": 5,
            "history_window": 6,
            "prune_keep": 200,
            "personality_file": "haunted_museum_audio_guide_personality.json",
            "working_notes_enabled": True,
            "working_notes_every_n_turns": 2,
            "working_notes_max_tokens": 220,
            "system_summary_enabled": False,
        },
        default_state=default_state,
    )


def build_demo_state() -> RegistryState:
    """An explicit runtime state overriding the registry defaults."""
    return RegistryState(sections={
        "personas": SectionState(
            selected="haunted_docent",
            array_modes={"groups[haunted_docent_directives]": "index:0"},
        ),
        "sentiment": SectionState(
            selected="elegant_alarm",
            slider=8,
            array_modes={"groups[elegant_alarm_nudges]": "index:1"},
        ),
        "base_context": SectionState(
            selected="tour_stop",
            template_vars={
                "gallery":          "the closed Egyptian wing",
                "artifact":         "a mirror that reflects yesterday's visitors",
                "visitor_behavior": "someone asked the mirror for directions",
                "weird_detail":     "the reflection pointed toward the basement",
            },
        ),
        "memory_recall": SectionState(
            selected=["recall"],
            template_vars={"memory_recall": "Earlier, a guest said the mirror repeated their name."},
        ),
        "static_injections":        SectionState(selected=["house_rules", "incident_history"]),
        "runtime_injections":       SectionState(selected=[]),
        "output_prompt_directions": SectionState(selected="audio_guide_rules"),
        "prompt_endings":           SectionState(selected="endings", array_modes={"items": "index:0"}),
    })


def main() -> None:
    reg = build_registry()
    state = build_demo_state()

    print("=== Prompt preview ===")
    print(hydrate(reg, state, seed=7))
    print()
    print("=== Registry JSON ===")
    print(json.dumps(reg.to_dict(), indent=2))


if __name__ == "__main__":
    main()

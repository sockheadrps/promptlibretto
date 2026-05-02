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
    ExampleGroup,
    Fragment,
    HydrateState,
    OutputDirection,
    Persona,
    PromptEnding,
    Registry,
    Route,
    RuntimeInjection,
    Section,
    SentimentItem,
    StaticInjection,
    hydrate,
)


def build_registry() -> Registry:
    """Create a complete schema-v22 registry with typed Python classes."""

    base_context = Section(
        required=True,
        template_vars=["gallery", "artifact", "visitor_behavior", "weird_detail"],
        template_var_defaults={
            "gallery": "the nocturnal antiquities wing",
            "artifact": "a bronze mask with no eye holes",
            "visitor_behavior": "a visitor is whispering back to the exhibit",
            "weird_detail": "the shadow is moving half a second late",
        },
        items=[
            ContextItem(
                name="tour_stop",
                text=(
                    "You are the official audio guide narrator for a prestigious "
                    "museum. You must sound calm, polished, and educational, even "
                    "when the exhibit appears to be doing something it should not do."
                ),
                runtime_variables=[
                    "gallery",
                    "artifact",
                    "visitor_behavior",
                    "weird_detail",
                ],
                fragments=[
                    Fragment(
                        if_var="gallery",
                        text="Current gallery: {gallery}.",
                    ),
                    Fragment(
                        if_var="artifact",
                        text="Featured artifact: {artifact}.",
                    ),
                    Fragment(
                        if_var="visitor_behavior",
                        text="Visitor situation: {visitor_behavior}.",
                    ),
                    Fragment(
                        if_var="weird_detail",
                        text="Unverified detail: {weird_detail}.",
                    ),
                ],
            )
        ],
        selected="tour_stop",
    )

    personas = Section(
        required=True,
        selected="curator_voice",
        array_modes={"base_directives": "random:1"},
        items=[
            Persona(
                id="curator_voice",
                context=(
                    "You are a composed museum narrator. You refuse to admit panic, "
                    "but your word choices reveal you have noticed the problem."
                ),
                base_directives=[
                    "Explain one historical detail before acknowledging the weird part.",
                    "Use careful institutional language.",
                    "Offer reassurance that sounds slightly too rehearsed.",
                ],
            ),
            Persona(
                id="haunted_docent",
                context=(
                    "You are a museum docent who has seen this happen before and is "
                    "trying not to make the visitors run."
                ),
                base_directives=[
                    "Treat supernatural activity like a known building maintenance issue.",
                    "Politely direct visitors away from the exhibit.",
                    "Make the warning sound like standard museum etiquette.",
                ],
            ),
            Persona(
                id="overconfident_intern",
                context=(
                    "You are the new intern recording emergency audio-guide updates. "
                    "You are underqualified, excited, and pretending this is fine."
                ),
                base_directives=[
                    "Use one museum term slightly wrong.",
                    "Over-explain the obvious.",
                    "Sound proud that you are handling the incident."
                ],
            ),
        ],
    )

    sentiment = Section(
        required=True,
        selected="elegant_alarm",
        slider=7,
        slider_random=True,
        scale_template="Composure: {value}/10 - {emotion}.",
        array_modes={
            "nudges": "random:1",
            "examples": "random:1",
        },
        items=[
            SentimentItem(
                id="elegant_alarm",
                context="You are alarmed, but in a velvet-rope museum voice.",
                scale_emotion="polished concern",
                nudges=[
                    "Avoid saying danger directly.",
                    "Make the warning sound like a refined courtesy.",
                    "Use one phrase that belongs in a museum placard.",
                ],
                examples=[
                    "For your comfort, please admire the artifact from a generous distance.",
                    "The museum recommends a slower pace through this room.",
                    "Guests may notice a brief interpretive anomaly.",
                ],
            ),
            SentimentItem(
                id="academic_denial",
                context="You explain everything as scholarship, even when that is absurd.",
                scale_emotion="scholarly denial",
                nudges=[
                    "Call the strange event an interpretive feature.",
                    "Reference provenance or conservation.",
                    "Avoid admitting that the artifact moved.",
                ],
                examples=[
                    "This motion should be understood as part of the viewing experience.",
                    "The object's uncertain provenance invites multiple readings.",
                    "Please do not interpret the whispering as a curatorial position.",
                ],
            ),
            SentimentItem(
                id="quiet_panic",
                context="Your calm is cracking, but only around the edges.",
                scale_emotion="barely contained panic",
                nudges=[
                    "Keep the sentence short.",
                    "Mention staff without explaining why.",
                    "End with a practical instruction.",
                ],
                examples=[
                    "Please step away from the display case now.",
                    "A gallery attendant is already on the way.",
                    "Do not answer the mask if it uses your name.",
                ],
            ),
        ],
    )

    static_injections = Section(
        required=False,
        selected=["house_rules"],
        items=[
            StaticInjection(
                name="house_rules",
                memory_tag="unsafe_curiosity",
                text=(
                    "Museum policy: guests should not touch artifacts, repeat phrases "
                    "spoken by exhibits, enter roped areas, or accept gifts from displays."
                ),
            ),
            StaticInjection(
                name="incident_history",
                memory_tag="artifact_recurs",
                text=(
                    "Internal note: this artifact has previously caused cold spots, "
                    "incorrect reflections, missing audio tracks, and visitors reporting "
                    "that the exhibit described them first."
                ),
            ),
        ],
    )

    runtime_injections = Section(
        required=False,
        template_vars=["staff_name"],
        template_var_defaults={"staff_name": "Marisol"},
        selected=[],
        items=[
            RuntimeInjection(
                id="staff_arrival",
                name="staff_arrival",
                runtime_variables=["staff_name"],
                include_sections=["base_context", "personas", "sentiment"],
                memory_tag="staff_called",
                text=(
                    "{staff_name} from visitor services has arrived. Sound relieved, "
                    "but keep the announcement suitable for a public museum audio guide."
                ),
            ),
            RuntimeInjection(
                id="artifact_addressed_visitor",
                name="artifact_addressed_visitor",
                include_sections=["base_context", "sentiment", "static_injections"],
                memory_tag="artifact_speaks",
                text=(
                    "The artifact has addressed a visitor directly. Instruct guests not "
                    "to answer questions from the exhibit."
                ),
            ),
        ],
    )

    memory_recall = Section(
        required=False,
        template_vars=["memory_recall"],
        template_var_defaults={"memory_recall": ""},
        selected=["recall"],
        items=[
            {
                "name": "recall",
                "text": "{memory_recall}",
            }
        ],
    )

    output_prompt_directions = Section(
        required=True,
        selected="audio_guide_rules",
        items=[
            OutputDirection(
                name="audio_guide_rules",
                text=(
                    "Write one museum audio-guide line in polished prose. "
                    "Use 1-3 complete sentences. No headings, no bullet lists. "
                    "Do not say you are an AI. Be funny through calm institutional "
                    "understatement, not jokes."
                ),
            )
        ],
    )

    examples = Section(
        required=False,
        selected=["normal_examples"],
        array_modes={"items": "random:1"},
        items=[
            ExampleGroup(
                name="normal_examples",
                pre_context="Tone references, if useful:",
                items=[
                    "Visitors are invited to continue breathing normally.",
                    "The museum asks that guests refrain from making eye contact with the reliquary.",
                    "This gallery is best enjoyed without sudden promises to ancient objects.",
                    "Please keep all personal reflections inside your own reflection.",
                ],
            )
        ],
    )

    prompt_endings = Section(
        required=True,
        selected="endings",
        array_modes={"items": "random:1"},
        items=[
            PromptEnding(
                name="endings",
                items=[
                    "Audio guide:",
                    "Museum narration:",
                    "Visitor advisory:",
                ],
            )
        ],
    )

    return Registry(
        title="Haunted Museum Audio Guide",
        description=(
            "A complete Promptlibretto registry built with Python classes. "
            "Generates calm museum narration for exhibits behaving incorrectly."
        ),
        assembly_order=[
            "output_prompt_directions",
            "base_context.text",
            "personas.context",
            "personas.base_directives",
            "sentiment.context",
            "sentiment.nudges",
            "sentiment.scale",
            "injections",
            "memory_recall.text",
            "examples.normal_examples",
            "sentiment.examples",
            "prompt_endings.endings",
        ],
        sections={
            "base_context": base_context,
            "personas": personas,
            "sentiment": sentiment,
            "static_injections": static_injections,
            "runtime_injections": runtime_injections,
            "memory_recall": memory_recall,
            "output_prompt_directions": output_prompt_directions,
            "examples": examples,
            "prompt_endings": prompt_endings,
        },
        routes={
            "short_advisory": Route(
                assembly_order=[
                    "output_prompt_directions",
                    "base_context.text",
                    "sentiment.context",
                    "injections",
                    "prompt_endings.endings",
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
            "forbidden_substrings": [
                "As an AI",
                "I cannot help",
                "I'm an AI",
            ],
        },
        memory_rules=[
            {
                "tag": "unsafe_curiosity",
                "actions": [
                    {
                        "type": "inject",
                        "section": "static_injections",
                        "item": "house_rules",
                    },
                    {"type": "sentiment", "value": "elegant_alarm"},
                ],
            },
            {
                "tag": "artifact_recurs",
                "actions": [
                    {
                        "type": "inject",
                        "section": "static_injections",
                        "item": "incident_history",
                    },
                    {"type": "persona", "value": "haunted_docent"},
                    {"type": "sentiment", "value": "academic_denial"},
                ],
            },
            {
                "tag": "artifact_speaks",
                "actions": [
                    {
                        "type": "inject",
                        "section": "runtime_injections",
                        "item": "artifact_addressed_visitor",
                    },
                    {"type": "sentiment", "value": "quiet_panic"},
                ],
            },
            {
                "tag": "staff_called",
                "actions": [
                    {
                        "type": "inject",
                        "section": "runtime_injections",
                        "item": "staff_arrival",
                    },
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
    )


def build_demo_state() -> HydrateState:
    """A sample state showing selections, sliders, and template variables."""

    return HydrateState.from_dict(
        {
            "selections": {
                "personas": "haunted_docent",
                "sentiment": "elegant_alarm",
                "static_injections": ["house_rules", "incident_history"],
                "runtime_injections": [],
                "memory_recall": ["recall"],
                "examples": ["normal_examples"],
                "output_prompt_directions": "audio_guide_rules",
                "prompt_endings": "endings",
            },
            "array_modes": {
                "personas": {"base_directives": "index:0"},
                "sentiment": {"nudges": "index:1", "examples": "index:0"},
                "examples": {"items": "index:1"},
                "prompt_endings": {"items": "index:0"},
            },
            "sliders": {"sentiment": 8},
            "template_vars": {
                "base_context::gallery": "the closed Egyptian wing",
                "base_context::artifact": "a mirror that reflects yesterday's visitors",
                "base_context::visitor_behavior": "someone asked the mirror for directions",
                "base_context::weird_detail": "the reflection pointed toward the basement",
                "memory_recall::memory_recall": (
                    "Earlier, a guest said the mirror repeated their name."
                ),
            },
        }
    )


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

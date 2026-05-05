from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Any, Mapping, Optional, Union

from ..registry.engine import Engine, GenerationResult
from ..registry.state import RegistryState, SectionState
from ..providers.base import ProviderAdapter
from .classifier import Classifier, ClassifierResult
from .personality import PersonalityLayer
from .router import Router
from .store import MemoryChunk, MemoryStore, MemoryTurn
from .system_summary import SystemSummaryLayer
from .working_notes import WorkingNotesLayer


@dataclass
class MemoryGenerationResult(GenerationResult):
    retrieved_chunks: list[MemoryChunk] = field(default_factory=list)
    extracted_tags: list[str] = field(default_factory=list)
    applied_rules: list[str] = field(default_factory=list)
    final_state: Optional[RegistryState] = None
    classifier_stats: dict = field(default_factory=dict)


@dataclass
class PreparedMemoryState:
    """Output of MemoryEngine.prepare(): mutated state + diagnostics."""
    state: RegistryState
    chunks: list[MemoryChunk] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)
    applied: list[str] = field(default_factory=list)
    clf: Optional[ClassifierResult] = None


class MemoryEngine:
    """Wraps Engine with a full memory pipeline.

    On each call to ``run()``:
    1. Embed user input and retrieve similar past turns from the store.
    2. Run the classifier to extract matching memory tags.
    3. Mutate RegistryState via Router rules.
    4. Optionally merge PersonalityLayer into state.
    5. Call Engine.run() with the enriched state.
    6. Write the input+response turn pair back to the store.
    """

    def __init__(
        self,
        engine: Engine,
        store: MemoryStore,
        classifier: Classifier,
        router: Router,
        personality: Optional[PersonalityLayer] = None,
        session_id: Optional[str] = None,
        top_k: int = 5,
        history_window: int = 6,
        working_notes: Optional[WorkingNotesLayer] = None,
        notes_provider: Optional[ProviderAdapter] = None,
        notes_model: Optional[str] = None,
        notes_every_n_turns: int = 3,
        notes_max_tokens: int = 200,
        notes_about_me_prompt: Optional[str] = None,
        notes_about_other_prompt: Optional[str] = None,
        participant_name: str = "you",
        system_summary: Optional[SystemSummaryLayer] = None,
        system_summary_every_n_turns: int = 3,
        system_summary_max_tokens: int = 300,
        system_summary_skip_section_keys: Optional[list[str]] = None,
        use_classifier: bool = True,
    ) -> None:
        self._engine = engine
        self._store = store
        self._classifier = classifier
        self._router = router
        self._use_classifier = use_classifier
        self._personality = personality
        self.session_id = session_id or str(uuid.uuid4())
        self._top_k = top_k
        self._history_window = history_window
        self._session_turns: list[MemoryTurn] = []
        self._working_notes = working_notes
        self._notes_provider = notes_provider
        self._notes_model = notes_model
        self._notes_every_n = max(1, int(notes_every_n_turns))
        self._notes_max_tokens = int(notes_max_tokens)
        self._notes_about_me_prompt = notes_about_me_prompt
        self._notes_about_other_prompt = notes_about_other_prompt
        self._notes_last_update_at = 0  # session-turn count of last update
        self._last_persona_context: str = ""  # cached for in-character notes
        self._participant_name: str = participant_name
        self._last_other_name: str = ""  # cached from prepare()
        self._system_summary = system_summary
        self._system_summary_every_n = max(1, int(system_summary_every_n_turns))
        self._system_summary_max_tokens = int(system_summary_max_tokens)
        self._system_summary_skip = list(system_summary_skip_section_keys or [
            "output_prompt_directions",
            "base_context",
            "personas",
            "sentiment",
            "static_injections",
        ])
        self._system_summary_last_at = 0  # model-turn counter at last summary update
        self._system_summary_model_turns = 0  # counts ONLY model-turns we summarized for

    async def prepare(
        self,
        user_input: str,
        base_state: Union[RegistryState, Mapping[str, Any], None] = None,
        *,
        other_name: Optional[str] = None,
    ) -> PreparedMemoryState:
        """Run retrieve → classify → router → personality merge → tvar injection.

        Returns the mutated RegistryState plus diagnostics. Does NOT generate
        and does NOT write to the store. Callers (ensemble) own generation
        and call `record_turn()` separately.
        """
        if isinstance(base_state, Mapping):
            state = RegistryState.from_dict(dict(base_state))
        elif base_state is None:
            state = RegistryState()
        else:
            state = base_state

        chunks = await self._store.retrieve(user_input, top_k=self._top_k)
        known_tags = self._router.known_tags
        if self._use_classifier and known_tags:
            clf_result = await self._classifier.extract_tags(
                user_input, chunks, known_tags,
                tag_descriptions=self._router.tag_descriptions or None,
            )
        else:
            from .classifier import ClassifierResult
            clf_result = ClassifierResult(model=self._classifier._model)
        tags = clf_result.tags
        mutated = self._router.mutate(state, tags)
        applied: list[str] = getattr(mutated, "_applied_rules", [])

        if self._personality is not None:
            mutated = self._personality.merge_into_state(mutated)

        # If a system summary exists, it covers the older history — only keep
        # the last 2 turns as immediate context so the prompt stays compact.
        summary_text = self._system_summary.text.strip() if self._system_summary else ""
        recent_limit = 2 if summary_text else self._history_window
        history = self._store.recent_turns(self.session_id, limit=recent_limit)
        notes_text = self._working_notes.text if self._working_notes is not None else ""
        recall_text = _format_recall(
            history,
            chunks,
            current_session_id=self.session_id,
            working_notes=notes_text,
            system_summary=summary_text,
        )

        # "What I think of the other speaker" — second retrieval keyed by the
        # other participant's name. Formatted as a separate block.
        thoughts_about_other = ""
        thought_chunks: list[MemoryChunk] = []
        if other_name:
            query = f"my impressions opinions thoughts about {other_name}"
            thought_chunks = await self._store.retrieve(query, top_k=self._top_k)
            thoughts_about_other = _format_thoughts(
                thought_chunks, other_name, current_session_id=self.session_id
            )

        for sec_key, sec in self._engine.registry.sections.items():
            # Collect template_vars declared at the section level or on any item.
            all_vars: set[str] = set(sec.template_vars or [])
            for item in sec.items:
                all_vars.update(item.get("template_vars") or [])
            if not all_vars:
                continue
            if sec_key not in mutated.sections:
                mutated.sections[sec_key] = SectionState()
            sec_state = mutated.sections[sec_key]
            if "user_input" in all_vars:
                sec_state.template_vars["user_input"] = user_input
            if "memory_recall" in all_vars:
                sec_state.template_vars["memory_recall"] = recall_text
            if other_name and "other_name" in all_vars:
                sec_state.template_vars["other_name"] = other_name
            if "thoughts_about_other" in all_vars:
                sec_state.template_vars["thoughts_about_other"] = thoughts_about_other
            if "working_notes" in all_vars:
                sec_state.template_vars["working_notes"] = notes_text
            if "system_summary" in all_vars:
                sec_state.template_vars["system_summary"] = ""  # now embedded in recall_text
            if "rule_ending" in all_vars:
                sec_state.template_vars["rule_ending"] = getattr(mutated, "_rule_ending_text", "")

        # Cache a "who you are" context using the SELECTED persona for this
        # turn — used by the next working-notes update so notes stay in-voice.
        self._last_persona_context = _select_persona_context(
            self._engine.registry, mutated, self._personality
        )
        if other_name:
            self._last_other_name = other_name

        return PreparedMemoryState(
            state=mutated, chunks=chunks, tags=tags, applied=applied, clf=clf_result
        )

    async def record_turn(
        self,
        text: str,
        role: str,
        tags: Optional[list[str]] = None,
        metadata: Optional[dict] = None,
    ) -> MemoryTurn:
        """Append a single turn to this participant's store, oldest-first.

        After appending, if working notes are configured and enough turns
        have passed since the last update, run a side-call to refresh them.
        """
        turn = MemoryTurn(
            text=text,
            role=role,
            session_id=self.session_id,
            tags=list(tags or []),
            metadata=dict(metadata or {}),
        )
        await self._store.upsert(turn)
        self._session_turns.append(turn)

        if (
            self._working_notes is not None
            and self._notes_provider is not None
            and self._notes_model
        ):
            count = len(self._session_turns)
            if count - self._notes_last_update_at >= self._notes_every_n:
                roles_present = {t.role for t in self._session_turns}
                if "user" in roles_present and "assistant" in roles_present:
                    self._notes_last_update_at = count
                    try:
                        persona = self._build_persona_context()
                        await self._working_notes.update(
                            self._session_turns,
                            self._notes_provider,
                            self._notes_model,
                            max_tokens=self._notes_max_tokens,
                            persona=persona,
                            self_name=self._participant_name or "you",
                            other_name=self._last_other_name or "the other person",
                            about_me_prompt=self._notes_about_me_prompt,
                            about_other_prompt=self._notes_about_other_prompt,
                        )
                    except Exception:
                        # Notes are best-effort; never fail a turn over them.
                        pass

        return turn

    def _build_persona_context(self) -> str:
        """Return the cached persona context from the most recent prepare()."""
        return self._last_persona_context

    async def record_system_prompt(self, full_prompt: str) -> None:
        """Hook for ensemble/runtime to feed the actual assembled system
        prompt back. Triggers a compression side-call every N model turns.

        Output-directive sections are stripped from the input before
        compression — they need to stay precise and aren't worth compressing.
        """
        if self._system_summary is None or self._notes_provider is None or not self._notes_model:
            return
        if not full_prompt or not full_prompt.strip():
            return

        self._system_summary_model_turns += 1
        if self._system_summary_model_turns - self._system_summary_last_at < self._system_summary_every_n:
            return
        self._system_summary_last_at = self._system_summary_model_turns

        # Strip output-directive section text from the prompt before compressing.
        compressible = _strip_directive_sections(
            full_prompt, self._engine.registry, self._system_summary_skip
        )

        try:
            await self._system_summary.update(
                compressible,
                self._notes_provider,
                self._notes_model,
                max_tokens=self._system_summary_max_tokens,
                persona=self._last_persona_context or None,
            )
        except Exception:
            # Best-effort; never fail a turn.
            pass

    async def run(
        self,
        user_input: str,
        base_state: Union[RegistryState, Mapping[str, Any], None] = None,
        *,
        route: Optional[str] = None,
        seed: Optional[int] = None,
    ) -> MemoryGenerationResult:
        prepared = await self.prepare(user_input, base_state=base_state)
        mutated = prepared.state
        chunks = prepared.chunks
        tags = prepared.tags
        applied = prepared.applied
        clf_result = prepared.clf

        result = await self._engine.run(mutated, route=route, seed=seed)

        await self.record_system_prompt(result.prompt)

        await self.record_turn(user_input, role="user", tags=tags)
        await self.record_turn(
            result.text,
            role="assistant",
            tags=tags,
            metadata={"applied_rules": applied},
        )

        return MemoryGenerationResult(
            text=result.text,
            accepted=result.accepted,
            prompt=result.prompt,
            route=result.route,
            reason=result.reason,
            usage=result.usage,
            timing=result.timing,
            raw=result.raw,
            retrieved_chunks=chunks,
            extracted_tags=tags,
            applied_rules=applied,
            final_state=mutated,
            classifier_stats={
                "model":         clf_result.model,
                "ms":            clf_result.ms,
                "tokens":        clf_result.tokens,
                "raw_response":  clf_result.raw_response,
                "error":         clf_result.error,
                "known_tags":    clf_result.known_tags,
            },
        )

    async def end_session(
        self,
        provider_model: Optional[str] = None,
    ) -> bool:
        """Optionally amend the personality profile with session insights."""
        if self._personality is None or not self._session_turns:
            return False
        model = provider_model or "llama3.2:1b"
        return await self._personality.amend(
            self._session_turns,
            self._engine.provider,
            model=model,
            session_id=self.session_id,
        )


def _strip_directive_sections(prompt: str, reg, skip_keys: list[str]) -> str:
    """Remove text contributed by `skip_keys` sections from the assembled prompt.

    Best-effort: matches each section's first item text and removes it.
    The prompt is built by joining section outputs with double newlines, so
    we split, drop blocks containing the directive text, and rejoin.
    """
    if not skip_keys:
        return prompt

    directive_snippets: list[str] = []
    for key in skip_keys:
        sec = reg.sections.get(key)
        if sec is None or not sec.items:
            continue
        for item in sec.items:
            txt = (item.get("text") or "").strip()
            if txt:
                # Use first 60 chars as a fingerprint — long enough to be unique,
                # short enough to survive template-var substitution.
                directive_snippets.append(txt[:60])

    if not directive_snippets:
        return prompt

    blocks = prompt.split("\n\n")
    kept = [
        b for b in blocks
        if not any(snip and snip in b for snip in directive_snippets)
    ]
    return "\n\n".join(kept).strip()


def _select_persona_context(reg, state: RegistryState, personality) -> str:
    """Compose a 'who you are' string from the actively-selected persona +
    base context + personality. Used to write working notes in-voice.
    """
    parts: list[str] = []

    if personality is not None:
        text = personality.profile.assembled
        if text and text.strip():
            parts.append(text.strip())

    sel = state.get("personas").selected

    # Pull the persona section's currently-selected item context.
    personas_sec = reg.sections.get("personas")
    if personas_sec and personas_sec.items:
        chosen_id = sel if isinstance(sel, str) else (sel[0] if isinstance(sel, list) and sel else None)
        for item in personas_sec.items:
            if chosen_id and item.get("id") != chosen_id:
                continue
            txt = item.get("context") or item.get("text") or ""
            if txt and isinstance(txt, str):
                parts.append(txt.strip())
            break

    # Base context (scene setting) is short and adds situational flavor.
    base_sec = reg.sections.get("base_context")
    if base_sec and base_sec.items:
        for item in base_sec.items:
            txt = item.get("text") or item.get("context") or ""
            if txt and isinstance(txt, str):
                parts.append(txt.strip())
                break

    return "\n\n".join(p for p in parts if p)


def _format_recall(
    history: list[MemoryTurn],
    chunks: list[MemoryChunk],
    *,
    current_session_id: str,
    max_chunks: int = 3,
    working_notes: str = "",
    system_summary: str = "",
) -> str:
    """Render the participant's memory context block.

    Layout, in order:
      System summary:       compressed snapshot of earlier prompt context.
      Working notes:        running summary maintained periodically.
      Recent conversation:  last N turns from THIS session, oldest-first.
      Relevant past notes:  retrieved chunks from OTHER sessions (dedup'd).

    Returns "" when nothing is available, so the section renders empty.
    """
    sections: list[str] = []

    if system_summary and system_summary.strip():
        sections.append(system_summary.strip())

    if working_notes and working_notes.strip():
        sections.append("Working notes (your running summary):\n" + working_notes.strip())

    if history:
        lines = [_fmt_turn(t) for t in history]
        sections.append("Recent conversation:\n" + "\n".join(lines))

    # Filter cross-session chunks to those whose text isn't near-duplicate
    # of any recent turn (avoids "the assistant repeats itself" noise).
    recent_texts = {(t.text or "").strip()[:120] for t in (history or [])}
    cross_session = []
    for c in chunks:
        if not c.turn.session_id or c.turn.session_id == current_session_id:
            continue
        snippet = (c.turn.text or "").strip()[:120]
        if snippet in recent_texts:
            continue
        cross_session.append(c)
        if len(cross_session) >= max_chunks:
            break

    if cross_session:
        lines = [
            f"- [{c.turn.role}] {_truncate(c.turn.text, 220)}"
            for c in cross_session
        ]
        sections.append("Relevant past notes:\n" + "\n".join(lines))

    return "\n\n".join(sections)


def _fmt_turn(turn: MemoryTurn) -> str:
    role = "User" if turn.role == "user" else "Agent"
    return f"{role}: {_truncate(turn.text, 400)}"


def _format_thoughts(
    chunks: list[MemoryChunk],
    other_name: str,
    *,
    current_session_id: str,
    max_items: int = 4,
) -> str:
    """Render top retrieved chunks (across sessions) as 'what I've come to
    think about <other>'. Empty string when nothing is found."""
    if not chunks:
        return ""
    items = chunks[:max_items]
    if not items:
        return ""
    lines = [
        f"- [{c.turn.role}] {_truncate(c.turn.text, 220)}"
        for c in items
    ]
    return f"What you've come to think about {other_name}:\n" + "\n".join(lines)


def _truncate(text: str, limit: int) -> str:
    text = (text or "").strip()
    if len(text) <= limit:
        return text
    return text[: limit - 1].rstrip() + "…"

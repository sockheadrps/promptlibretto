from __future__ import annotations

import asyncio
import random
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Optional

from promptlibretto.providers.base import ProviderMessage, ProviderRequest
from promptlibretto.providers.ollama import OllamaProvider
from promptlibretto.registry.engine import Engine
from promptlibretto.registry.state import RegistryState

try:
    from promptlibretto.memory import MemoryEngine
except ImportError:  # memory deps optional
    MemoryEngine = None  # type: ignore[assignment]


@dataclass
class Participant:
    name: str
    engine: Optional[Engine]  # None for human-driven participants
    model: str
    ollama_url: str = "http://localhost:11434"
    chat_path: str = "/api/chat"
    payload_shape: str = "auto"
    state: Optional[RegistryState] = None
    human: bool = False  # if True, run loop pauses and awaits external input
    memory: Optional["MemoryEngine"] = None  # per-participant memory pipeline
    provider_override: Any = field(default=None)
    _provider: Optional[OllamaProvider] = field(default=None, init=False, repr=False)
    _hydrate_seed: Optional[int] = field(default=None, init=False, repr=False)

    def provider(self) -> Any:
        if self.provider_override is not None:
            return self.provider_override
        if self._provider is None:
            self._provider = OllamaProvider(
                base_url=self.ollama_url,
                chat_path=self.chat_path,
                payload_shape=self.payload_shape,
            )
        return self._provider


@dataclass
class Turn:
    speaker: str
    text: str


OnTurnFn = Callable[[str, str, int], Awaitable[None]]
OnChunkFn = Callable[[str, str], Awaitable[None]]
OnHumanFn = Callable[[str, str, int], Awaitable[str]]  # (speaker_name, last_input, turn_idx) -> response
OnPrepareFn = Callable[[str, int, dict], Awaitable[None]]  # (speaker_name, turn_idx, trace_dict)
OnStepFn = Callable[[int], Awaitable[None]]  # gate fired after each turn — implementation may block


class EnsembleEngine:
    """Two registry-driven models taking turns responding to each other.

    Each participant's registry hydrates into their system prompt. The
    conversation history is passed as user/assistant messages so each model
    sees the full exchange from its own perspective.
    """

    def __init__(
        self,
        a: Participant,
        b: Participant,
        max_turns: int = 8,
    ) -> None:
        self.a = a
        self.b = b
        self.max_turns = max_turns
        self.history: list[Turn] = []

    def _build_messages_from_state(
        self,
        speaker: Participant,
        new_input: str,
        state: Optional[RegistryState],
        *,
        scene_context: str = "",
        other_name: str = "the other participant",
    ) -> list[ProviderMessage]:
        if state is not None:
            system_prompt = speaker.engine.hydrate(state, seed=speaker._hydrate_seed)
        else:
            system_prompt = speaker.engine.hydrate(
                speaker.state, seed=speaker._hydrate_seed
            )
        if scene_context:
            system_prompt = (
                system_prompt.rstrip()
                + "\n\nConversation scene (shared context, not dialogue):\n"
                + scene_context.strip()
            )
        messages = [ProviderMessage(role="system", content=system_prompt)]
        for turn in self.history:
            role = "assistant" if turn.speaker == speaker.name else "user"
            messages.append(ProviderMessage(role=role, content=turn.text))
        if self.history:
            messages.append(ProviderMessage(role="user", content=new_input))
        else:
            messages.append(ProviderMessage(
                role="user",
                content=(
                    f"Begin the conversation as {speaker.name}. "
                    f"The scene above is context, not something {other_name} said. "
                    f"Speak only as {speaker.name}; do not write {other_name}'s response."
                ),
            ))
        return messages

    def _build_request(self, speaker: Participant, messages: list[ProviderMessage]) -> ProviderRequest:
        assert speaker.engine is not None, "engine required for non-human participants"
        cfg, _ = speaker.engine._cfg_policy_for(None)
        return ProviderRequest(
            model=speaker.model,
            messages=messages,
            temperature=cfg.temperature,
            max_tokens=cfg.max_tokens,
            top_p=cfg.top_p,
            top_k=cfg.top_k,
            repeat_penalty=cfg.repeat_penalty,
            timeout_ms=cfg.timeout_ms,
        )

    async def run(
        self,
        seed: str,
        on_chunk: Optional[OnChunkFn] = None,
        on_turn: Optional[OnTurnFn] = None,
        on_human: Optional[OnHumanFn] = None,
        on_prepare: Optional[OnPrepareFn] = None,
        on_step: Optional[OnStepFn] = None,
    ) -> list[Turn]:
        participants = [self.a, self.b]
        scene_context = seed
        current_input = seed
        seed_rng = random.SystemRandom()
        for p in participants:
            p._hydrate_seed = seed_rng.randrange(0, 2**32)

        # Record the seed in every participant's store as a "user"-role turn —
        # so each participant can later retrieve it from their own perspective.
        for p in participants:
            if p.memory is not None:
                await p.memory.record_turn(seed, role="user")

        for turn_idx in range(self.max_turns):
            speaker = participants[turn_idx % 2]
            other = participants[(turn_idx + 1) % 2]

            # Build the system prompt — through memory pipeline if enabled,
            # otherwise from the speaker's static state.
            mutated_state: Optional[RegistryState] = None
            prepared = None
            if speaker.memory is not None and not speaker.human:
                prepared = await speaker.memory.prepare(
                    current_input,
                    base_state=speaker.state,
                    other_name=other.name,
                )
                mutated_state = prepared.state

            if speaker.human:
                if on_human is None:
                    raise RuntimeError(
                        f"participant {speaker.name!r} is human but no on_human callback was provided"
                    )
                text = (await on_human(speaker.name, current_input, turn_idx)).strip()
            else:
                messages = self._build_messages_from_state(
                    speaker,
                    current_input,
                    mutated_state,
                    scene_context=scene_context,
                    other_name=other.name,
                )
                request = self._build_request(speaker, messages)
                provider = speaker.provider()

                # Feed the just-assembled system prompt back to memory so it
                # can keep a compressed summary up-to-date (best-effort).
                if speaker.memory is not None and messages:
                    try:
                        await speaker.memory.record_system_prompt(messages[0].content)
                    except Exception:
                        pass

                # Surface the internal-thoughts trace (memory diagnostics +
                # final system prompt) before generation begins.
                if on_prepare is not None:
                    system_prompt = messages[0].content if messages else ""
                    trace: dict = {
                        "system_prompt": system_prompt,
                        "user_input":    current_input,
                        "other_name":    other.name,
                        # Surface the actual generation params used for this turn
                        # so the UI can confirm overrides reached the request.
                        "generation": {
                            "model":          request.model,
                            "temperature":    request.temperature,
                            "top_p":          request.top_p,
                            "top_k":          request.top_k,
                            "max_tokens":     request.max_tokens,
                            "repeat_penalty": request.repeat_penalty,
                        },
                    }
                    if prepared is not None:
                        trace["tags"]          = list(prepared.tags)
                        trace["applied_rules"] = list(prepared.applied)
                        trace["chunks"] = [
                            {
                                "role":  c.turn.role,
                                "score": round(c.score, 4),
                                "text":  c.turn.text[:220],
                            }
                            for c in (prepared.chunks or [])[:5]
                        ]
                        if prepared.clf is not None:
                            trace["classifier"] = {
                                "model":  prepared.clf.model,
                                "ms":     prepared.clf.ms,
                                "tokens": prepared.clf.tokens,
                            }
                        # Surface resolved template var values so the UI can
                        # highlight where memory/rule content landed in the prompt.
                        for sec_key, sec_state in (prepared.state.sections or {}).items():
                            tv = getattr(sec_state, "template_vars", {}) or {}
                            for var_name, var_val in tv.items():
                                if var_val and isinstance(var_val, str) and var_val.strip():
                                    trace.setdefault("resolved_tvars", {})[f"{sec_key}::{var_name}"] = var_val
                        rule_ending = getattr(prepared.state, "_rule_ending_text", "")
                        if rule_ending:
                            trace.setdefault("resolved_tvars", {})["rule_ending"] = rule_ending
                    # Surface working notes (running summary) when present.
                    if speaker.memory is not None:
                        wn = getattr(speaker.memory, "_working_notes", None)
                        if wn is not None:
                            trace["working_notes"] = {
                                "text":         wn.text,
                                "last_updated": wn.notes.last_updated,
                                "update_count": wn.notes.update_count,
                            }
                        ss = getattr(speaker.memory, "_system_summary", None)
                        if ss is not None:
                            trace["system_summary"] = {
                                "text":         ss.text,
                                "last_updated": ss.summary.last_updated,
                                "update_count": ss.summary.update_count,
                                "source_chars": ss.summary.source_chars,
                            }
                    await on_prepare(speaker.name, turn_idx, trace)

                if on_chunk is not None:
                    text = await self._stream_turn(provider, request, speaker.name, on_chunk)
                else:
                    response = await provider.generate(request)
                    text = response.text.strip()

            self.history.append(Turn(speaker=speaker.name, text=text))

            # Record this turn into EVERY participant's store so each one
            # has its own subjective record of the full conversation.
            for p in participants:
                if p.memory is None:
                    continue
                role = "assistant" if p.name == speaker.name else "user"
                await p.memory.record_turn(text, role=role)

            if on_turn is not None:
                await on_turn(speaker.name, text, turn_idx)

            current_input = text

            # Step gate — when set, the implementation may block until the
            # caller signals to continue (used for manual step-through mode).
            if on_step is not None and turn_idx + 1 < self.max_turns:
                await on_step(turn_idx)

        return self.history

    @staticmethod
    async def _stream_turn(
        provider: OllamaProvider,
        request: ProviderRequest,
        name: str,
        on_chunk: OnChunkFn,
    ) -> str:
        buffer: list[str] = []
        async for chunk in provider.stream(request):
            if chunk.text:
                buffer.append(chunk.text)
                await on_chunk(name, chunk.text)
            if chunk.done:
                break
        return "".join(buffer).strip()

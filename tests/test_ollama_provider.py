from __future__ import annotations

from promptlibretto.providers.base import ProviderMessage, ProviderRequest
from promptlibretto.providers.ollama import OllamaProvider


class _FakeStreamResponse:
    def __init__(self, lines):
        self._lines = lines

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    def raise_for_status(self):
        return None

    async def aiter_lines(self):
        for line in self._lines:
            yield line


class _FakeClient:
    def __init__(self, lines):
        self.lines = lines
        self.payload = None

    def stream(self, _method, _url, *, json, timeout):
        self.payload = json
        return _FakeStreamResponse(self.lines)


async def test_openai_stream_requests_and_preserves_usage():
    client = _FakeClient([
        'data: {"choices":[{"delta":{"content":"Hello"}}]}',
        'data: {"choices":[{"delta":{"content":" world"}}]}',
        'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}',
        "data: [DONE]",
    ])
    provider = OllamaProvider(
        base_url="http://example.test",
        chat_path="/v1/chat/completions",
        client=client,
    )
    request = ProviderRequest(
        model="m",
        messages=[ProviderMessage(role="user", content="say hi")],
        temperature=0.7,
        max_tokens=20,
    )

    chunks = []
    async for chunk in provider.stream(request):
        chunks.append(chunk)

    assert client.payload["stream_options"] == {"include_usage": True}
    assert "".join(c.text for c in chunks if not c.done) == "Hello world"
    final = chunks[-1].response
    assert final.text == "Hello world"
    assert final.usage.prompt_tokens == 3
    assert final.usage.completion_tokens == 2
    assert final.usage.total_tokens == 5

from __future__ import annotations

from typing import Optional

import httpx


class OllamaEmbedder:
    """Calls an embedding endpoint to produce float vectors.

    Despite the class name, this works with both Ollama's `/api/embed` and
    OpenAI-compatible servers' `/v1/embeddings`. Pass `embed_path` and
    `payload_shape` to opt into the OpenAI shape; defaults match Ollama.
    """

    def __init__(
        self,
        base_url: str = "http://localhost:11434",
        model: str = "nomic-embed-text",
        embed_path: str = "/api/embed",
        payload_shape: str = "auto",  # "ollama" | "openai" | "auto"
        client: Optional[httpx.AsyncClient] = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self.model = model
        self._embed_path = embed_path if embed_path.startswith("/") else "/" + embed_path
        if payload_shape == "auto":
            payload_shape = "openai" if "/v1/" in self._embed_path else "ollama"
        if payload_shape not in ("ollama", "openai"):
            raise ValueError(f"unknown payload_shape: {payload_shape!r}")
        self._payload_shape = payload_shape
        self._owned = client is None
        self._client = client or httpx.AsyncClient()

    async def embed(self, text: str) -> list[float]:
        if self._payload_shape == "openai":
            payload = {"model": self.model, "input": text}
        else:
            payload = {"model": self.model, "input": text}
        url = f"{self._base_url}{self._embed_path}"
        try:
            resp = await self._client.post(url, json=payload, timeout=60.0)
            resp.raise_for_status()
        except httpx.HTTPStatusError as e:
            raise RuntimeError(
                f"embed call failed at {url} (status {e.response.status_code}). "
                f"Check memory_config.embed_url / embed_path / embed_payload_shape. "
                f"Default '/api/embed' assumes Ollama; for llama.cpp / LM Studio set "
                f"embed_path='/v1/embeddings'."
            ) from e
        except httpx.RequestError as e:
            raise RuntimeError(
                f"embed call failed at {url}: {type(e).__name__}: {e}. "
                f"Server unreachable? Check memory_config.embed_url."
            ) from e
        data = resp.json()
        # OpenAI: {"data": [{"embedding": [...]}]}
        if isinstance(data.get("data"), list) and data["data"]:
            emb = data["data"][0].get("embedding")
            if isinstance(emb, list) and emb:
                return emb
        # Ollama new: {"embeddings": [[...]]} or flat {"embeddings": [...]}
        if "embeddings" in data:
            embs = data["embeddings"]
            if isinstance(embs, list) and embs:
                first = embs[0]
                return first if isinstance(first, list) else embs
        # Ollama old: {"embedding": [...]}
        if "embedding" in data:
            emb = data["embedding"]
            if isinstance(emb, list) and emb:
                return emb
        raise ValueError(
            f"unexpected embed response shape from {url}: {list(data.keys())}. "
            f"Response: {str(data)[:200]}"
        )

    async def embed_batch(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        if len(texts) == 1:
            return [await self.embed(texts[0])]

        payload = {"model": self.model, "input": texts}
        url = f"{self._base_url}{self._embed_path}"
        try:
            resp = await self._client.post(url, json=payload, timeout=60.0)
            resp.raise_for_status()
        except (httpx.HTTPStatusError, httpx.RequestError):
            # Server may not support list input — fall back to sequential.
            return [await self.embed(t) for t in texts]

        data = resp.json()

        # OpenAI: {"data": [{"embedding": [...], "index": N}, ...]}
        if isinstance(data.get("data"), list) and data["data"]:
            try:
                ordered = sorted(data["data"], key=lambda x: x.get("index", 0))
                vectors = [item["embedding"] for item in ordered]
                if len(vectors) == len(texts):
                    return vectors
            except (KeyError, TypeError):
                pass

        # Ollama new: {"embeddings": [[...], [...], ...]}
        if "embeddings" in data:
            embs = data["embeddings"]
            if isinstance(embs, list) and embs and isinstance(embs[0], list):
                if len(embs) == len(texts):
                    return embs

        # Unexpected shape or count mismatch — fall back to sequential.
        return [await self.embed(t) for t in texts]

    async def aclose(self) -> None:
        if self._owned:
            await self._client.aclose()

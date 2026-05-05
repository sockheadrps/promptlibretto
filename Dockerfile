FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONPATH=/app

WORKDIR /app

COPY pyproject.toml README.md ./
COPY promptlibretto ./promptlibretto
COPY studio ./studio
COPY ensemble ./ensemble

RUN pip install --upgrade pip && pip install ".[studio,ollama,memory]" websockets

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD python -c "import urllib.request,sys; \
      urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=2); sys.exit(0)" \
      || exit 1

CMD ["promptlibretto-studio", "--host", "0.0.0.0", "--port", "8000"]

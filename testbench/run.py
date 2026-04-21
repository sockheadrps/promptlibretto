from __future__ import annotations

import os


def main() -> None:
    import uvicorn

    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8000"))
    uvicorn.run("testbench.main:app", host=host, port=port, reload=False)


if __name__ == "__main__":
    main()

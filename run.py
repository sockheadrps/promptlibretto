"""Convenience launcher: `python run.py` to start the test bench."""
import os
import uvicorn

if __name__ == "__main__":
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8000"))
    uvicorn.run("testbench.main:app", host=host, port=port, reload=False)

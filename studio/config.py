"""Shared runtime config derived from environment variables."""
from __future__ import annotations

import os

MULTI_TENANT: bool = os.getenv("MULTI_TENANT", "").lower() in ("1", "true", "yes")
USER_ID_COOKIE: str = "pl_user_id"

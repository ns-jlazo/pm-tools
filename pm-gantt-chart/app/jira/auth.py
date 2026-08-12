"""Env-var-based Jira credential loader.

Adapted from `examples/jira_auth.py` with the keychain fallback removed. Reads
`JIRA_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` (with `JIRA_API_KEY` as legacy alias).
"""

from __future__ import annotations

import os
from typing import Tuple


class JiraNotConfigured(RuntimeError):
    """Raised when Jira credentials are missing so routes can return 503."""


def get_jira_credentials() -> Tuple[str, str, str]:
    """Return (url, email, api_token). Raise `JiraNotConfigured` if any are missing."""
    url = (os.environ.get("JIRA_URL") or "").rstrip("/")
    email = os.environ.get("JIRA_EMAIL") or ""
    token = os.environ.get("JIRA_API_TOKEN") or os.environ.get("JIRA_API_KEY") or ""

    missing = [
        name
        for name, value in (("JIRA_URL", url), ("JIRA_EMAIL", email), ("JIRA_API_TOKEN", token))
        if not value
    ]
    if missing:
        raise JiraNotConfigured(
            "Missing Jira env vars: " + ", ".join(missing) + ". "
            "Set them in the process environment (see .env.example)."
        )
    return url, email, token


def is_configured() -> bool:
    try:
        get_jira_credentials()
    except JiraNotConfigured:
        return False
    return True

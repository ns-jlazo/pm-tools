"""Minimal `.env` loader.

The Jira integration reads its credentials from the process environment
(`app/jira/auth.py`), but `uvicorn app.main:app` inherits only the shell's
environment — so a `.env` sitting next to `requirements.txt` was silently
ignored and every Jira call returned 503. This module closes that gap without
adding a `python-dotenv` dependency.

Existing environment variables always win, so `JIRA_URL=... uvicorn ...` and
CI secrets still override the file.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Dict, Optional


ROOT_DIR = Path(__file__).resolve().parent.parent
DEFAULT_ENV_PATH = ROOT_DIR / ".env"


def parse_env_file(path: Path) -> Dict[str, str]:
    """Parse a `.env` file into a dict. Unparsable lines are skipped."""
    values: Dict[str, str] = {}
    try:
        raw = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return values

    for line in raw.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        if line.startswith("export "):
            line = line[len("export ") :].lstrip()
        name, _, value = line.partition("=")
        name = name.strip()
        if not name:
            continue
        value = value.strip()
        # Strip one layer of matching quotes; leave inner content untouched.
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        values[name] = value
    return values


def load_dotenv(path: Optional[Path] = None, override: bool = False) -> Dict[str, str]:
    """Load `path` (default `<project root>/.env`) into `os.environ`.

    Returns the names/values actually applied. Real environment variables are
    preserved unless `override=True`.
    """
    env_path = path or DEFAULT_ENV_PATH
    if not env_path.is_file():
        return {}

    applied: Dict[str, str] = {}
    for name, value in parse_env_file(env_path).items():
        if not override and os.environ.get(name):
            continue
        os.environ[name] = value
        applied[name] = value
    return applied

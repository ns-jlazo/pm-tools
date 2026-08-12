#!/usr/bin/env python3
"""Standalone Jira JQL search helper.

Uses the same client as the FastAPI backend so results are byte-identical to
what the UI would render. No auto_ops / keychain / Netskope dependencies.

Examples:
    python3 scripts/jira-search.py "project = OPS AND status = 'To Do'"
    python3 scripts/jira-search.py --limit 10 "text ~ 'gantt'"
    python3 scripts/jira-search.py --json "issuekey in (ABC-1, ABC-2)"
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def _bootstrap_path() -> None:
    """Allow running this script from anywhere without installing the package."""
    root = Path(__file__).resolve().parents[1]
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))


def main() -> int:
    _bootstrap_path()

    from app.env import load_dotenv

    load_dotenv()

    from app.jira.auth import JiraNotConfigured, get_jira_credentials
    from app.jira.client import JiraClient

    parser = argparse.ArgumentParser(description="Search Jira using JQL.")
    parser.add_argument("jql", help="JQL query string")
    parser.add_argument("--limit", type=int, default=25, help="Max results (default 25)")
    parser.add_argument("--json", action="store_true", help="Emit JSON array")
    args = parser.parse_args()

    try:
        url, email, token = get_jira_credentials()
    except JiraNotConfigured as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 2

    client = JiraClient(url=url, email=email, api_token=token)
    envelope = client.search_issues(jql=args.jql, max_results=args.limit)
    issues = envelope.get("issues") or []

    if args.json:
        payload = [
            {
                "key": issue.get("key"),
                "status": (issue.get("fields") or {}).get("status", {}).get("name"),
                "summary": (issue.get("fields") or {}).get("summary"),
            }
            for issue in issues
        ]
        print(json.dumps(payload, indent=2))
        return 0

    if not issues:
        print("No matching tickets found.")
        return 0

    print(f"Found {len(issues)} matching ticket(s):")
    for issue in issues:
        key = issue.get("key")
        fields = issue.get("fields") or {}
        status = (fields.get("status") or {}).get("name") or "?"
        summary = fields.get("summary") or ""
        print(f"{key} [{status}] {summary}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

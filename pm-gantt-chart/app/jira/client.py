"""Slim Jira REST v3 client.

Adapted from `examples/jira_client.py`, keeping the retry/timeout behavior and
the `/rest/api/3/search/jql` token-based pagination. Netskope-specific defaults
and the `auto_ops.lib.keychain` fallback have been removed — credentials must
be supplied by the caller (see `app.jira.auth.get_jira_credentials`).

This client is read-only: only `search_issues`, `search_all_issues`, and
`get_issue` are exposed. Write operations (comments, transitions) live in the
original example and are intentionally not ported.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Dict, Iterable, List, Optional

import requests
from requests.adapters import HTTPAdapter
from requests.auth import HTTPBasicAuth

try:
    from urllib3.util.retry import Retry
except ImportError:  # pragma: no cover - urllib3 ships with requests
    Retry = None  # type: ignore[assignment]


logger = logging.getLogger(__name__)


# Retry/backoff tuning mirrors the example: rides out brief Atlassian edge
# failures without stalling requests for minutes. GET-only so we never
# double-post anything (this client is read-only anyway).
_RETRY_TOTAL = int(os.environ.get("JIRA_RETRY_TOTAL", "4"))
_RETRY_BACKOFF = float(os.environ.get("JIRA_RETRY_BACKOFF", "1.5"))
_RETRY_STATUSES = (429, 500, 502, 503, 504)
_SEARCH_TIMEOUT = (10, 60)
_REQUEST_TIMEOUT = (10, 120)


def _ssl_verify() -> bool:
    return os.environ.get("JIRA_DISABLE_SSL_VERIFY", "0") != "1"


def _build_session() -> requests.Session:
    session = requests.Session()
    if Retry is None:
        return session
    retry_kwargs = dict(
        total=_RETRY_TOTAL,
        connect=_RETRY_TOTAL,
        read=_RETRY_TOTAL,
        status=_RETRY_TOTAL,
        backoff_factor=_RETRY_BACKOFF,
        status_forcelist=_RETRY_STATUSES,
        raise_on_status=False,
        respect_retry_after_header=True,
    )
    # urllib3 renamed method_whitelist → allowed_methods in 1.26.
    idempotent = frozenset(["GET", "HEAD", "OPTIONS"])
    try:
        retry = Retry(allowed_methods=idempotent, **retry_kwargs)
    except TypeError:
        retry = Retry(method_whitelist=idempotent, **retry_kwargs)
    adapter = HTTPAdapter(max_retries=retry)
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    return session


def adf_to_text(adf: Any) -> str:
    """Best-effort conversion of Atlassian Document Format to plain text."""
    if not adf:
        return ""
    if isinstance(adf, str):
        return adf
    if not isinstance(adf, dict):
        return str(adf)

    parts: List[str] = []

    def walk(node: Any) -> None:
        if isinstance(node, list):
            for child in node:
                walk(child)
            return
        if not isinstance(node, dict):
            return
        node_type = node.get("type")
        if node_type == "text":
            parts.append(node.get("text") or "")
            return
        if node_type == "hardBreak":
            parts.append("\n")
            return
        if node_type in {"paragraph", "heading", "listItem", "blockquote"}:
            walk(node.get("content"))
            parts.append("\n")
            return
        walk(node.get("content"))

    walk(adf.get("content"))
    return "".join(parts).strip()


class JiraClient:
    """Minimal read-only Jira Cloud REST v3 client."""

    def __init__(self, url: str, email: str, api_token: str) -> None:
        if not url or not email or not api_token:
            raise ValueError("JiraClient requires url, email, and api_token.")
        self.url = url.rstrip("/")
        self.auth = HTTPBasicAuth(email, api_token)
        self._session = _build_session()
        self._session.auth = self.auth
        self._session.headers.update(
            {"Accept": "application/json", "Content-Type": "application/json"}
        )

    # ------------------------------------------------------------------ helpers
    def _get(self, path: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        response = self._session.get(
            f"{self.url}{path}",
            params=params or {},
            verify=_ssl_verify(),
            timeout=_REQUEST_TIMEOUT,
        )
        if not response.ok:
            logger.error("Jira API %s failed: %s %s", path, response.status_code, response.text[:500])
        response.raise_for_status()
        return response.json()

    # ------------------------------------------------------------------- search
    def search_issues(
        self,
        jql: str,
        max_results: int = 50,
        fields: Optional[Iterable[str]] = None,
        next_page_token: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Single page of results from `/rest/api/3/search/jql`.

        Returns the raw JSON envelope: `{issues, nextPageToken, isLast}`.
        Callers should read `issues` and paginate via `nextPageToken`.
        """
        params: Dict[str, Any] = {
            "jql": jql,
            "maxResults": min(max(max_results, 1), 100),
            "fields": ",".join(fields) if fields else "*navigable,issuelinks",
        }
        if next_page_token:
            params["nextPageToken"] = next_page_token

        response = self._session.get(
            f"{self.url}/rest/api/3/search/jql",
            params=params,
            verify=_ssl_verify(),
            timeout=_SEARCH_TIMEOUT,
        )
        if not response.ok:
            logger.error(
                "Jira search failed: %s %s", response.status_code, response.text[:500]
            )
        response.raise_for_status()
        return response.json()

    def search_all_issues(
        self,
        jql: str,
        max_results: int = 500,
        fields: Optional[Iterable[str]] = None,
    ) -> List[Dict[str, Any]]:
        """Paginate `search_issues` until `max_results` or `isLast=True`."""
        collected: List[Dict[str, Any]] = []
        token: Optional[str] = None
        while len(collected) < max_results:
            page_size = min(100, max_results - len(collected))
            page = self.search_issues(
                jql, max_results=page_size, fields=fields, next_page_token=token
            )
            collected.extend(page.get("issues") or [])
            if page.get("isLast", True):
                break
            token = page.get("nextPageToken")
            if not token:
                break
        return collected[:max_results]

    def get_myself(self) -> Dict[str, Any]:
        """Return the authenticated account.

        Unlike search/issue reads — which Jira Cloud answers anonymously with
        empty results or a 404 when the token is bad — this endpoint returns a
        real 401, so it is the only reliable credential check.
        """
        return self._get("/rest/api/3/myself")

    def get_label_suggestions(self, prefix: str = "") -> Dict[str, Any]:
        """Label typeahead from Jira's JQL autocomplete.

        Returns `{"results": [{"value", "displayName"}, ...]}`. Suggestions are
        tenant-wide — Jira has no per-project label endpoint — so callers that
        need a project scope must filter or fall back to a scoped JQL search.
        """
        return self._get(
            "/rest/api/3/jql/autocompletedata/suggestions",
            params={"fieldName": "labels", "fieldValue": prefix},
        )

    def get_issue(self, key: str, fields: Optional[Iterable[str]] = None) -> Dict[str, Any]:
        params: Dict[str, Any] = {}
        if fields:
            params["fields"] = ",".join(fields)
        return self._get(f"/rest/api/3/issue/{key}", params=params)

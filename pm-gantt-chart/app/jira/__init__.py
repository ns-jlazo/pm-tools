"""Jira integration package (read-only sync + linking)."""

from .auth import JiraNotConfigured, get_jira_credentials

__all__ = ["JiraNotConfigured", "get_jira_credentials"]

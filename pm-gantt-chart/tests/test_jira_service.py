import json
import os
import re
import tempfile
import unittest
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List
from unittest import mock

import requests
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from fastapi import HTTPException

from app import models, schemas
from app.database import Base
from app.env import load_dotenv
from app.jira import routes as jira_routes
from app.jira import service as jira_service
from app.jira.auth import JiraNotConfigured


def _make_issue(key: str, status: str = "To Do", category: str = "new",
                summary: str = "Ticket", labels: Any = None, parent: Any = None,
                duedate: Any = "2026-08-31", extra_fields: Any = None) -> Dict[str, Any]:
    return {
        "key": key,
        "fields": {
            "summary": summary,
            "status": {"name": status, "statusCategory": {"key": category}},
            "issuetype": {"name": "Epic"},
            "assignee": {"displayName": "Jamie Fox", "emailAddress": "jamie@example.com"},
            "duedate": duedate,
            "parent": {"key": parent} if parent else None,
            "labels": list(labels or []),
            **(extra_fields or {}),
        },
    }


class _FakeClient:
    def __init__(self) -> None:
        self.url = "https://example.atlassian.net"
        self.issues: Dict[str, Dict[str, Any]] = {}
        self.search_calls: List[str] = []
        self.search_tokens: List[Any] = []
        self.search_limits: List[int] = []
        self.get_calls: List[str] = []
        self.label_calls: List[str] = []
        self.label_payload: Dict[str, Any] = {"results": []}
        self.label_error: Any = None

    def add(self, key: str, **kwargs: Any) -> None:
        self.issues[key] = _make_issue(key, **kwargs)

    def get_label_suggestions(self, prefix: str = "") -> Dict[str, Any]:
        self.label_calls.append(prefix)
        if self.label_error is not None:
            raise self.label_error
        return self.label_payload

    def search_all_issues(self, jql: str, max_results: int = 500,
                          fields: Any = None) -> List[Dict[str, Any]]:
        self.search_calls.append(jql)
        return self._matching(jql)[:max_results]

    def _matching(self, jql: str) -> List[Dict[str, Any]]:
        """Honor the two query shapes the service sends; anything else is everything."""
        issues = list(self.issues.values())
        keys = re.search(r"issuekey in \((.*?)\)", jql)
        if keys:
            wanted = set(re.findall(r'"([^"]+)"', keys.group(1)))
            return [i for i in issues if i["key"] in wanted]
        label = re.search(r'labels = "(.*)" ORDER', jql)
        if label:
            wanted_label = label.group(1).replace('\\"', '"')
            return [i for i in issues if wanted_label in i["fields"]["labels"]]
        return issues

    def search_issues(self, jql: str, max_results: int = 50, fields: Any = None,
                      next_page_token: Any = None) -> Dict[str, Any]:
        self.search_calls.append(jql)
        self.search_tokens.append(next_page_token)
        self.search_limits.append(max_results)
        everything = list(self.issues.values())
        start = int(next_page_token or 0)
        results = everything[start:start + max_results]
        more = start + max_results < len(everything)
        return {
            "issues": results,
            "isLast": not more,
            "nextPageToken": str(start + max_results) if more else None,
        }

    count_error: Any = None

    def count_issues(self, jql: str) -> int:
        if self.count_error is not None:
            raise self.count_error
        return len(self.issues)

    def get_issue(self, key: str, fields: Any = None) -> Dict[str, Any]:
        self.get_calls.append(key)
        if key not in self.issues:
            self.add(key)
        return self.issues[key]


class JiraServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine(
            "sqlite:///:memory:", connect_args={"check_same_thread": False}
        )
        Base.metadata.create_all(bind=self.engine)
        self.session_maker = sessionmaker(bind=self.engine)
        self.db: Session = self.session_maker()

        project = models.Project(name="P1", description="", color="#0f766e")
        self.db.add(project)
        self.db.flush()
        team = models.Team(project_id=project.id, name="Platform", color="#0f766e")
        self.db.add(team)
        self.db.flush()
        deliverable = models.Deliverable(
            project_id=project.id,
            title="T1",
            description="",
            team_id=team.id,
            planned_start=date(2026, 8, 1),
            planned_end=date(2026, 8, 5),
            status="planned",
            progress=0,
        )
        self.db.add(deliverable)
        self.db.flush()
        milestone = models.Milestone(
            deliverable_id=deliverable.id,
            title="M1",
            description="",
            team_id=team.id,
            target_date=date(2026, 8, 3),
            status="planned",
            progress=0,
        )
        self.db.add(milestone)
        self.db.commit()
        self.project_id = project.id
        self.team_id = team.id
        self.deliverable_id = deliverable.id
        self.milestone_id = milestone.id

        self.fake = _FakeClient()
        self._patcher = mock.patch.object(jira_service, "get_client", return_value=self.fake)
        self._patcher.start()

    def tearDown(self) -> None:
        self._patcher.stop()
        self.db.close()
        Base.metadata.drop_all(bind=self.engine)
        self.engine.dispose()

    def test_link_epic_upserts_issue_and_creates_link(self) -> None:
        self.fake.add("ABC-1", status="In Progress", category="indeterminate")
        payload = schemas.JiraLinkCreate(jira_key="ABC-1", team_id=self.team_id)
        link = jira_service.link_epic_to_project(self.db, self.project_id, payload)

        self.assertEqual(link.issue.key, "ABC-1")
        self.assertEqual(link.team_id, self.team_id)
        self.assertEqual(link.issue.status, "In Progress")
        self.assertEqual(link.issue.status_category, "indeterminate")

        stored_issue = self.db.query(models.JiraIssue).filter_by(jira_key="ABC-1").one()
        self.assertTrue(stored_issue.raw_json)
        self.assertEqual(stored_issue.assignee_email, "jamie@example.com")

    def test_link_epic_rejects_team_from_other_project(self) -> None:
        other_project = models.Project(name="P2", description="", color="#1d4ed8")
        self.db.add(other_project)
        self.db.flush()
        foreign_team = models.Team(project_id=other_project.id, name="Other", color="#1d4ed8")
        self.db.add(foreign_team)
        self.db.commit()

        payload = schemas.JiraLinkCreate(jira_key="ABC-2", team_id=foreign_team.id)
        with self.assertRaises(ValueError):
            jira_service.link_epic_to_project(self.db, self.project_id, payload)

    def test_ttl_triggers_refresh_on_list(self) -> None:
        self.fake.add("ABC-9", status="To Do", category="new")
        jira_service.link_epic_to_project(
            self.db, self.project_id, schemas.JiraLinkCreate(jira_key="ABC-9")
        )
        self.fake.search_calls.clear()

        issue = self.db.query(models.JiraIssue).filter_by(jira_key="ABC-9").one()
        issue.synced_at = datetime.utcnow() - timedelta(hours=1)
        self.db.commit()

        grouped = jira_service.list_project_links(self.db, self.project_id)
        self.assertFalse(grouped.stale)
        self.assertEqual(len(grouped.links), 1)
        self.assertTrue(self.fake.search_calls, "stale links must trigger a refresh")

    def test_ttl_skips_refresh_when_fresh(self) -> None:
        self.fake.add("ABC-3")
        jira_service.link_epic_to_project(
            self.db, self.project_id, schemas.JiraLinkCreate(jira_key="ABC-3")
        )
        self.fake.search_calls.clear()

        jira_service.list_project_links(self.db, self.project_id)
        self.assertEqual(self.fake.search_calls, [])

    def test_unlink_removes_link_but_keeps_issue_cache(self) -> None:
        self.fake.add("ABC-4")
        link = jira_service.link_epic_to_project(
            self.db, self.project_id, schemas.JiraLinkCreate(jira_key="ABC-4")
        )
        jira_service.unlink_project_link(self.db, self.project_id, link.id)
        self.assertEqual(
            self.db.query(models.ProjectJiraLink).count(), 0
        )
        self.assertEqual(
            self.db.query(models.JiraIssue).filter_by(jira_key="ABC-4").count(), 1
        )

    def test_deliverable_link_roundtrip(self) -> None:
        self.fake.add("STORY-1", status="Done", category="done")
        link = jira_service.link_issue_to_deliverable(
            self.db, self.deliverable_id, schemas.JiraLinkCreate(jira_key="STORY-1")
        )
        self.assertEqual(link.issue.key, "STORY-1")

        links = jira_service.list_deliverable_links(
            self.db, self.deliverable_id, refresh_stale=False
        )
        self.assertEqual(len(links), 1)

        jira_service.unlink_deliverable_link(self.db, self.deliverable_id, link.id)
        self.assertEqual(
            jira_service.list_deliverable_links(
                self.db, self.deliverable_id, refresh_stale=False
            ),
            [],
        )

    def test_bulk_link_links_new_keys_in_one_fetch(self) -> None:
        self.fake.add("SNA-1")
        self.fake.add("SNA-2")
        self.fake.search_calls.clear()

        result = jira_service.link_issues_to_deliverable(
            self.db, self.deliverable_id, ["SNA-1", "SNA-2", "SNA-1", "  "]
        )

        self.assertEqual(sorted(result.linked), ["SNA-1", "SNA-2"])
        self.assertEqual(result.skipped, [])
        self.assertEqual(result.not_found, [])
        # A whole label's worth of stories must cost one Jira search, not one each.
        self.assertEqual(len(self.fake.search_calls), 1)
        self.assertEqual(
            self.db.query(models.DeliverableJiraLink).count(), 2
        )

    def test_bulk_link_skips_already_linked_and_reports_missing(self) -> None:
        self.fake.add("SNA-1")
        self.fake.add("SNA-2")
        jira_service.link_issue_to_deliverable(
            self.db, self.deliverable_id, schemas.JiraLinkCreate(jira_key="SNA-1")
        )

        result = jira_service.link_issues_to_deliverable(
            self.db, self.deliverable_id, ["SNA-1", "SNA-2", "GHOST-9"]
        )

        self.assertEqual(result.linked, ["SNA-2"])
        self.assertEqual(result.skipped, ["SNA-1"])
        self.assertEqual(result.not_found, ["GHOST-9"])
        self.assertEqual(self.db.query(models.DeliverableJiraLink).count(), 2)

    def test_bulk_link_with_no_keys_touches_nothing(self) -> None:
        self.fake.search_calls.clear()

        result = jira_service.link_issues_to_deliverable(self.db, self.deliverable_id, [])

        self.assertEqual((result.linked, result.skipped, result.not_found), ([], [], []))
        self.assertEqual(self.fake.search_calls, [])

    def test_bulk_link_rejects_unknown_deliverable(self) -> None:
        with self.assertRaises(ValueError):
            jira_service.link_issues_to_deliverable(self.db, 9999, ["SNA-1"])

    def _link_milestone(self, milestone_id: int, key: str) -> Any:
        """Link one key, keeping the fake honest about which issue was asked for.

        A single-key link syncs with `max_results=1` and the fake answers any JQL
        with its first stored issue, so only the wanted key may be in flight.
        """
        self.fake.issues.clear()
        self.fake.add(key)
        return jira_service.link_issue_to_milestone(
            self.db, milestone_id, schemas.JiraLinkCreate(jira_key=key)
        )

    # --- milestones: same linking contract as a deliverable, different owner ---

    def test_milestone_link_roundtrip(self) -> None:
        self.fake.add("STORY-2", status="Done", category="done")
        link = jira_service.link_issue_to_milestone(
            self.db, self.milestone_id, schemas.JiraLinkCreate(jira_key="STORY-2")
        )
        self.assertEqual(link.issue.key, "STORY-2")
        self.assertEqual(link.milestone_id, self.milestone_id)

        links = jira_service.list_milestone_links(
            self.db, self.milestone_id, refresh_stale=False
        )
        self.assertEqual(len(links), 1)

        jira_service.unlink_milestone_link(self.db, self.milestone_id, link.id)
        self.assertEqual(
            jira_service.list_milestone_links(
                self.db, self.milestone_id, refresh_stale=False
            ),
            [],
        )
        # The cached issue is shared with the deliverable overlay, so it stays.
        self.assertEqual(
            self.db.query(models.JiraIssue).filter_by(jira_key="STORY-2").count(), 1
        )

    def test_milestone_bulk_link_dedupes_and_reports_missing(self) -> None:
        self.fake.add("SNA-1")
        self.fake.add("SNA-2")
        jira_service.link_issue_to_milestone(
            self.db, self.milestone_id, schemas.JiraLinkCreate(jira_key="SNA-1")
        )
        self.fake.search_calls.clear()

        result = jira_service.link_issues_to_milestone(
            self.db, self.milestone_id, ["SNA-1", "SNA-2", "SNA-2", "  ", "GHOST-9"]
        )

        self.assertEqual(result.linked, ["SNA-2"])
        self.assertEqual(result.skipped, ["SNA-1"])
        self.assertEqual(result.not_found, ["GHOST-9"])
        self.assertEqual(self.db.query(models.MilestoneJiraLink).count(), 2)
        # A whole label's worth of stories still costs one Jira search.
        self.assertEqual(len(self.fake.search_calls), 1)

    def test_milestone_bulk_link_rejects_unknown_milestone(self) -> None:
        with self.assertRaises(ValueError):
            jira_service.link_issues_to_milestone(self.db, 9999, ["SNA-1"])

    def test_project_milestone_links_group_by_milestone(self) -> None:
        second = models.Milestone(
            deliverable_id=self.deliverable_id,
            title="M2",
            description="",
            team_id=self.team_id,
            target_date=date(2026, 8, 4),
            status="planned",
            progress=0,
        )
        self.db.add(second)
        self.db.commit()

        self._link_milestone(self.milestone_id, "SNA-1")
        self._link_milestone(second.id, "SNA-2")

        grouped = jira_service.list_project_milestone_links(
            self.db, self.project_id, refresh_stale=False
        )

        self.assertEqual(grouped.project_id, self.project_id)
        self.assertEqual(
            {
                milestone_id: [link.issue.key for link in links]
                for milestone_id, links in grouped.links_by_milestone.items()
            },
            {self.milestone_id: ["SNA-1"], second.id: ["SNA-2"]},
        )

    def test_project_milestone_links_exclude_other_projects(self) -> None:
        # The milestone reaches its project through its parent deliverable, so a
        # wrong join here would leak another workspace's stories into the chart.
        other = models.Project(name="P2", description="", color="#1d4ed8")
        self.db.add(other)
        self.db.flush()
        other_team = models.Team(project_id=other.id, name="Other", color="#1d4ed8")
        self.db.add(other_team)
        self.db.flush()
        other_deliverable = models.Deliverable(
            project_id=other.id,
            title="T2",
            description="",
            team_id=other_team.id,
            planned_start=date(2026, 8, 1),
            planned_end=date(2026, 8, 5),
            status="planned",
            progress=0,
        )
        self.db.add(other_deliverable)
        self.db.flush()
        other_milestone = models.Milestone(
            deliverable_id=other_deliverable.id,
            title="M-other",
            description="",
            team_id=other_team.id,
            target_date=date(2026, 8, 3),
            status="planned",
            progress=0,
        )
        self.db.add(other_milestone)
        self.db.commit()

        self._link_milestone(self.milestone_id, "SNA-1")
        self._link_milestone(other_milestone.id, "SNA-2")

        grouped = jira_service.list_project_milestone_links(
            self.db, self.project_id, refresh_stale=False
        )

        self.assertEqual(list(grouped.links_by_milestone), [self.milestone_id])


class JiraSearchPaginationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.fake = _FakeClient()
        for i in range(25):
            self.fake.add("SNA-{}".format(i + 1))
        self._patch = mock.patch.object(jira_service, "get_client", lambda: self.fake)
        self._patch.start()

    def tearDown(self) -> None:
        self._patch.stop()

    def test_default_page_is_ten_and_exposes_token(self) -> None:
        page = jira_service.search("project = SNA")
        self.assertEqual(len(page.issues), 10)
        self.assertEqual(self.fake.search_limits, [10])
        self.assertFalse(page.is_last)
        self.assertEqual(page.next_page_token, "10")

    def test_token_is_forwarded_and_last_page_flagged(self) -> None:
        page = jira_service.search("project = SNA", next_page_token="20")
        self.assertEqual(self.fake.search_tokens, ["20"])
        self.assertEqual([i.key for i in page.issues][0], "SNA-21")
        self.assertTrue(page.is_last)
        self.assertIsNone(page.next_page_token)

    def test_total_comes_from_the_count_on_the_first_page_only(self) -> None:
        self.assertEqual(jira_service.search("project = SNA").total, 25)
        self.assertIsNone(jira_service.search("project = SNA", next_page_token="10").total)

    def test_count_failure_does_not_break_the_search(self) -> None:
        self.fake.count_error = RuntimeError("boom")
        page = jira_service.search("project = SNA")
        self.assertIsNone(page.total)
        self.assertEqual(len(page.issues), 10)


class JiraLabelTests(unittest.TestCase):
    """Labels tag a project feature, so the search must stay project-scoped."""

    def setUp(self) -> None:
        self.fake = _FakeClient()
        self._patcher = mock.patch.object(
            jira_service, "get_client", return_value=self.fake
        )
        self._patcher.start()
        self.addCleanup(self._patcher.stop)
        # Keep a developer's real .env out of the scoping assertions.
        self._env = mock.patch.dict(os.environ, {}, clear=False)
        self._env.start()
        self.addCleanup(self._env.stop)
        os.environ.pop("JIRA_LABEL_PROJECT_KEY", None)

    def test_label_project_key_precedence(self) -> None:
        self.assertEqual(jira_service.label_project_key(), "SNA")
        os.environ["JIRA_LABEL_PROJECT_KEY"] = "PLAT"
        self.assertEqual(jira_service.label_project_key(), "PLAT")
        self.assertEqual(jira_service.label_project_key("  "), "PLAT")
        self.assertEqual(jira_service.label_project_key(" OPS "), "OPS")

    def test_search_by_label_scopes_and_escapes_the_jql(self) -> None:
        self.fake.add("SNA-1", labels=['pay "v2"'])

        response = jira_service.search_by_label('pay "v2"')

        self.assertEqual(response.project_key, "SNA")
        self.assertEqual(response.label, 'pay "v2"')
        self.assertEqual([issue.key for issue in response.issues], ["SNA-1"])
        self.assertFalse(response.truncated)
        self.assertEqual(
            self.fake.search_calls,
            ['project = "SNA" AND labels = "pay \\"v2\\"" ORDER BY updated DESC'],
        )

    def test_search_by_label_honors_the_project_override_and_cap(self) -> None:
        self.fake.add("OPS-1", labels=["net"])
        self.fake.add("OPS-2", labels=["net"])

        response = jira_service.search_by_label("net", project_key="OPS", limit=2)

        self.assertEqual(response.project_key, "OPS")
        self.assertIn('project = "OPS"', self.fake.search_calls[0])
        # The cap was hit, so the UI has to warn there may be more behind it.
        self.assertTrue(response.truncated)

    def test_search_by_label_requires_a_label(self) -> None:
        with self.assertRaises(ValueError):
            jira_service.search_by_label("   ")

    def test_suggest_labels_filters_autocomplete_results(self) -> None:
        self.fake.label_payload = {
            "results": [
                {"value": "payments-v2"},
                {"value": "payments-v2"},
                {"value": "networking"},
                {"value": ""},
            ]
        }

        suggestions = jira_service.suggest_labels(query="pay")

        self.assertEqual(suggestions.labels, ["payments-v2"])
        self.assertEqual(suggestions.source, "suggestions")
        self.assertEqual(suggestions.project_key, "SNA")
        self.assertEqual(self.fake.label_calls, ["pay"])

    def test_suggest_labels_unquotes_jql_ready_values(self) -> None:
        # Jira hands back values ready to paste into JQL, so anything needing
        # quotes arrives wrapped. Passing that through searched for a label
        # whose name contained the quote characters, which matches nothing.
        self.fake.label_payload = {
            "results": [
                {"value": '"#pay-upsize"'},
                {"value": '"\\"pay-review\\""'},
                {"value": "payments-v2"},
            ]
        }

        suggestions = jira_service.suggest_labels(query="pay")

        self.assertEqual(
            suggestions.labels, ["#pay-upsize", '"pay-review"', "payments-v2"]
        )

    def test_search_by_label_strips_jql_quoting_from_the_label(self) -> None:
        self.fake.add("SNA-1", labels=["#pay-upsize"])

        response = jira_service.search_by_label('"#pay-upsize"')

        self.assertEqual(response.label, "#pay-upsize")
        self.assertEqual(
            self.fake.search_calls,
            ['project = "SNA" AND labels = "#pay-upsize" ORDER BY updated DESC'],
        )

    def test_suggest_labels_falls_back_to_project_issues(self) -> None:
        response = mock.Mock(status_code=404)
        self.fake.label_error = requests.HTTPError(response=response)
        self.fake.add("SNA-1", labels=["payments-v2", "networking"])
        self.fake.add("SNA-2", labels=["payments-billing"])

        suggestions = jira_service.suggest_labels(query="pay")

        self.assertEqual(suggestions.labels, ["payments-billing", "payments-v2"])
        self.assertEqual(suggestions.source, "issues")
        self.assertEqual(suggestions.project_key, "SNA")
        self.assertIn(
            'project = "SNA" AND labels IS NOT EMPTY', self.fake.search_calls[0]
        )


class JiraErrorMappingTests(unittest.TestCase):
    """Every Jira failure has to reach the UI as something a PM can act on."""

    @staticmethod
    def _raise(exc: Exception) -> Any:
        def call() -> Any:
            raise exc

        return call

    def _status_and_detail(self, exc: Exception) -> Any:
        with self.assertRaises(HTTPException) as caught:
            jira_routes._handle_jira_call(self._raise(exc))
        return caught.exception.status_code, caught.exception.detail

    @staticmethod
    def _http_error(status: int, payload: Any = None, text: str = "") -> requests.HTTPError:
        response = mock.Mock(status_code=status, text=text)
        if payload is None:
            response.json.side_effect = ValueError("no json")
        else:
            response.json.return_value = payload
        return requests.HTTPError(f"{status} Client Error", response=response)

    def test_rejected_query_reports_jiras_own_reason(self) -> None:
        # A 400 is the caller's problem, and only Jira knows why.
        status, detail = self._status_and_detail(
            self._http_error(400, {"errorMessages": ["Field 'labels' is invalid."]})
        )

        self.assertEqual(status, 400)
        self.assertIn("Field 'labels' is invalid.", detail)

    def test_field_errors_are_included(self) -> None:
        status, detail = self._status_and_detail(
            self._http_error(400, {"errorMessages": [], "errors": {"jql": "bad syntax"}})
        )

        self.assertEqual(status, 400)
        self.assertIn("jql: bad syntax", detail)

    def test_server_side_jira_failure_is_a_bad_gateway(self) -> None:
        status, detail = self._status_and_detail(
            self._http_error(500, {"errorMessages": ["Internal Jira error"]})
        )

        self.assertEqual(status, 502)
        self.assertIn("Internal Jira error", detail)

    def test_non_json_error_body_still_says_something(self) -> None:
        status, detail = self._status_and_detail(
            self._http_error(503, text="<html>Gateway timeout</html>")
        )

        self.assertEqual(status, 502)
        self.assertIn("Gateway timeout", detail)

    def test_connection_failures_do_not_escape_as_a_500(self) -> None:
        # ConnectionError/Timeout are not HTTPError, so they used to fall through
        # as an opaque 500 that the UI showed as "Request failed".
        status, detail = self._status_and_detail(
            requests.ConnectionError("Failed to resolve netskope.atlassian.net")
        )

        self.assertEqual(status, 502)
        self.assertIn("Could not reach Jira", detail)

    def test_timeout_is_reported_as_unreachable(self) -> None:
        status, detail = self._status_and_detail(requests.Timeout("read timed out"))

        self.assertEqual(status, 502)
        self.assertIn("Could not reach Jira", detail)

    def test_missing_config_is_service_unavailable(self) -> None:
        status, _ = self._status_and_detail(JiraNotConfigured("JIRA_URL is not set."))

        self.assertEqual(status, 503)

    def test_bad_credentials_name_the_env_vars(self) -> None:
        status, detail = self._status_and_detail(self._http_error(401))

        self.assertEqual(status, 502)
        self.assertIn("JIRA_API_TOKEN", detail)


class JiraAuthTests(unittest.TestCase):
    def test_missing_env_raises(self) -> None:
        with mock.patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(JiraNotConfigured):
                jira_service.get_client()

    def test_env_creds_build_client(self) -> None:
        with mock.patch.dict(
            os.environ,
            {
                "JIRA_URL": "https://ex.atlassian.net",
                "JIRA_EMAIL": "a@b.com",
                "JIRA_API_TOKEN": "tok",
            },
            clear=True,
        ):
            client = jira_service.get_client()
            self.assertEqual(client.url, "https://ex.atlassian.net")


class DotenvTests(unittest.TestCase):
    """`.env` has to reach os.environ or every Jira route 503s."""

    def _write(self, body: str) -> Path:
        path = Path(self.tmp.name) / ".env"
        path.write_text(body, encoding="utf-8")
        return path

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def test_loads_values_and_strips_quotes(self) -> None:
        path = self._write(
            "# comment\n"
            "\n"
            "JIRA_URL=https://ex.atlassian.net\n"
            'JIRA_EMAIL="a@b.com"\n'
            "export JIRA_API_TOKEN='tok'\n"
            "not a pair\n"
        )
        with mock.patch.dict(os.environ, {}, clear=True):
            applied = load_dotenv(path)
            self.assertEqual(os.environ["JIRA_URL"], "https://ex.atlassian.net")
            self.assertEqual(os.environ["JIRA_EMAIL"], "a@b.com")
            self.assertEqual(os.environ["JIRA_API_TOKEN"], "tok")
            self.assertNotIn("not a pair", applied)

    def test_real_environment_wins(self) -> None:
        path = self._write("JIRA_EMAIL=file@b.com\n")
        with mock.patch.dict(os.environ, {"JIRA_EMAIL": "shell@b.com"}, clear=True):
            load_dotenv(path)
            self.assertEqual(os.environ["JIRA_EMAIL"], "shell@b.com")
            load_dotenv(path, override=True)
            self.assertEqual(os.environ["JIRA_EMAIL"], "file@b.com")

    def test_missing_file_is_a_no_op(self) -> None:
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(load_dotenv(Path(self.tmp.name) / "absent"), {})


class JiraHealthTests(unittest.TestCase):
    """Bad tokens are invisible on search/issue reads, so health must probe."""

    ENV = {
        "JIRA_URL": "https://ex.atlassian.net",
        "JIRA_EMAIL": "a@b.com",
        "JIRA_API_TOKEN": "tok",
    }

    def test_not_configured(self) -> None:
        with mock.patch.dict(os.environ, {}, clear=True):
            health = jira_service.check_health()
        self.assertFalse(health.configured)
        self.assertFalse(health.authenticated)

    def test_authenticated(self) -> None:
        client = mock.Mock()
        client.get_myself.return_value = {"displayName": "Jamie Fox"}
        with mock.patch.dict(os.environ, self.ENV, clear=True), mock.patch.object(
            jira_service, "get_client", return_value=client
        ):
            health = jira_service.check_health()
        self.assertTrue(health.authenticated)
        self.assertEqual(health.account, "Jamie Fox")

    def test_rejected_credentials(self) -> None:
        response = mock.Mock(status_code=401)
        client = mock.Mock()
        client.get_myself.side_effect = requests.HTTPError(response=response)
        with mock.patch.dict(os.environ, self.ENV, clear=True), mock.patch.object(
            jira_service, "get_client", return_value=client
        ):
            health = jira_service.check_health()
        self.assertTrue(health.configured)
        self.assertFalse(health.authenticated)
        self.assertIn("JIRA_API_TOKEN", health.detail)


class LabelSearchEnrichmentTests(unittest.TestCase):
    """Epic-based dating, the date window, and `linked_in` on label search."""

    # Borrow the DB + fake-client fixture without inheriting (and re-running)
    # every JiraServiceTests case.
    def setUp(self) -> None:
        JiraServiceTests.setUp(self)
        self.addCleanup(lambda: JiraServiceTests.tearDown(self))
        env = mock.patch.dict(os.environ, {}, clear=False)
        env.start()
        self.addCleanup(env.stop)
        os.environ.pop("JIRA_EPIC_START_FIELD", None)
        jira_service._label_sync_cache.clear()
        self.addCleanup(jira_service._label_sync_cache.clear)

    def _epic(self, key: str, start: Any, due: Any) -> None:
        self.fake.add(
            key, summary=f"Epic {key}", duedate=due,
            extra_fields={"customfield_10015": start},
        )

    def _story(self, key: str, parent: Any = None, duedate: Any = None) -> None:
        self.fake.add(key, labels=["feat-x"], parent=parent, duedate=duedate)

    def _search(self, **kwargs: Any) -> schemas.JiraLabelSearchResponse:
        return jira_service.search_by_label(
            "feat-x", db=self.db, project_id=self.project_id, **kwargs
        )

    def test_epic_dates_place_the_story_and_filter_the_window(self) -> None:
        os.environ["JIRA_EPIC_START_FIELD"] = "customfield_10015"
        self._epic("E-1", "2026-07-01", "2026-09-30")  # Q3
        self._epic("E-2", "2026-10-01", "2026-12-31")  # Q4
        self._story("S-1", parent="E-1")
        self._story("S-2", parent="E-2")

        response = self._search(date_from=date(2026, 7, 1), date_to=date(2026, 9, 30))

        self.assertEqual([i.key for i in response.issues], ["S-1"])
        hit = response.issues[0]
        self.assertEqual(hit.epic_key, "E-1")
        self.assertEqual(hit.epic_summary, "Epic E-1")
        self.assertEqual(hit.effective_start, date(2026, 7, 1))
        self.assertEqual(hit.effective_end, date(2026, 9, 30))
        self.assertEqual(hit.labels, ["feat-x"])

    def test_epic_without_start_field_uses_its_due_date(self) -> None:
        self._epic("E-1", "2026-07-01", "2026-09-30")
        self._story("S-1", parent="E-1")

        hit = self._search().issues[0]

        self.assertEqual((hit.effective_start, hit.effective_end),
                         (date(2026, 9, 30), date(2026, 9, 30)))

    def test_story_due_date_is_the_fallback(self) -> None:
        self._story("S-1", duedate="2026-11-15")

        in_window = self._search(date_from=date(2026, 10, 1), date_to=date(2026, 12, 31))
        out_of_window = self._search(date_from=date(2026, 1, 1), date_to=date(2026, 3, 31))

        self.assertEqual([i.key for i in in_window.issues], ["S-1"])
        self.assertEqual(out_of_window.issues, [])

    def test_undated_stories_are_kept_and_flagged(self) -> None:
        self._story("S-1", duedate=None)

        response = self._search(date_from=date(2026, 7, 1), date_to=date(2026, 9, 30))

        self.assertEqual([i.key for i in response.issues], ["S-1"])
        self.assertTrue(response.issues[0].undated)

    def test_inverted_window_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            self._search(date_from=date(2026, 9, 1), date_to=date(2026, 7, 1))

    def test_linked_in_names_the_deliverables_that_hold_a_story(self) -> None:
        self._story("S-1", duedate="2026-08-01")
        self._story("S-2", duedate="2026-08-01")
        jira_service.link_issues_to_deliverable(self.db, self.deliverable_id, ["S-1"])

        by_key = {i.key: i for i in self._search().issues}

        self.assertEqual(
            [(l.deliverable_id, l.title) for l in by_key["S-1"].linked_in],
            [(self.deliverable_id, "T1")],
        )
        self.assertEqual(by_key["S-2"].linked_in, [])

    def _label_the_deliverable(self) -> None:
        deliverable = self.db.get(models.Deliverable, self.deliverable_id)
        deliverable.jira_label = "feat-x"
        self.db.commit()

    def test_label_sync_reports_new_keys_without_linking(self) -> None:
        self._label_the_deliverable()
        self._story("S-1", duedate="2026-08-01")
        self._story("S-2", duedate="2026-08-01")
        jira_service.link_issues_to_deliverable(self.db, self.deliverable_id, ["S-1"])

        result = jira_service.sync_labels(self.db, self.project_id, force=True)

        (item,) = result.results
        self.assertEqual((item.label, item.total, item.new_keys, item.new_count),
                         ("feat-x", 2, ["S-2"], 1))
        links = jira_service.list_deliverable_links(
            self.db, self.deliverable_id, refresh_stale=False
        )
        self.assertEqual([l.issue.key for l in links], ["S-1"])  # nothing auto-linked

    def test_label_sync_ignores_unlabelled_deliverables(self) -> None:
        self.assertEqual(jira_service.sync_labels(self.db, self.project_id).results, [])

    def test_label_sync_is_throttled_but_tracks_new_links(self) -> None:
        self._label_the_deliverable()
        self._story("S-1", duedate="2026-08-01")
        jira_service.sync_labels(self.db, self.project_id, force=True)
        searches = len(self.fake.search_calls)

        jira_service.link_issues_to_deliverable(self.db, self.deliverable_id, ["S-1"])
        searches_after_link = len(self.fake.search_calls)
        result = jira_service.sync_labels(self.db, self.project_id)

        self.assertEqual(len(self.fake.search_calls), searches_after_link)  # served from cache
        self.assertGreater(searches_after_link, searches - 1)
        (item,) = result.results
        self.assertTrue(item.cached)
        self.assertEqual(item.new_count, 0)  # linking cleared the badge

    def test_label_sync_force_and_changed_label_bypass_the_throttle(self) -> None:
        self._label_the_deliverable()
        self._story("S-1", duedate="2026-08-01")
        jira_service.sync_labels(self.db, self.project_id, force=True)
        before = len(self.fake.search_calls)

        jira_service.sync_labels(self.db, self.project_id, force=True)
        self.assertGreater(len(self.fake.search_calls), before)

        before = len(self.fake.search_calls)
        self.db.get(models.Deliverable, self.deliverable_id).jira_label_to = date(2026, 12, 31)
        self.db.commit()
        jira_service.sync_labels(self.db, self.project_id)
        self.assertGreater(len(self.fake.search_calls), before)

    def test_label_sync_fails_softly(self) -> None:
        self._label_the_deliverable()
        with mock.patch.object(
            jira_service, "get_client", side_effect=JiraNotConfigured("no creds")
        ):
            result = jira_service.sync_labels(self.db, self.project_id, force=True)
        self.assertEqual(result.error, "no creds")

        with mock.patch.object(
            jira_service, "search_by_label", side_effect=requests.ConnectionError("down")
        ):
            result = jira_service.sync_labels(self.db, self.project_id, force=True)
        self.assertIsNone(result.error)
        self.assertIsNotNone(result.results[0].error)


if __name__ == "__main__":
    unittest.main()

import json
import os
import unittest
from datetime import date, datetime, timedelta
from typing import Any, Dict, List
from unittest import mock

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app import models, schemas
from app.database import Base
from app.jira import service as jira_service
from app.jira.auth import JiraNotConfigured


def _make_issue(key: str, status: str = "To Do", category: str = "new",
                summary: str = "Ticket") -> Dict[str, Any]:
    return {
        "key": key,
        "fields": {
            "summary": summary,
            "status": {"name": status, "statusCategory": {"key": category}},
            "issuetype": {"name": "Epic"},
            "assignee": {"displayName": "Jamie Fox", "emailAddress": "jamie@example.com"},
            "duedate": "2026-08-31",
            "parent": None,
        },
    }


class _FakeClient:
    def __init__(self) -> None:
        self.url = "https://example.atlassian.net"
        self.issues: Dict[str, Dict[str, Any]] = {}
        self.search_calls: List[str] = []
        self.get_calls: List[str] = []

    def add(self, key: str, **kwargs: Any) -> None:
        self.issues[key] = _make_issue(key, **kwargs)

    def search_all_issues(self, jql: str, max_results: int = 500,
                          fields: Any = None) -> List[Dict[str, Any]]:
        self.search_calls.append(jql)
        return list(self.issues.values())[:max_results]

    def search_issues(self, jql: str, max_results: int = 50, fields: Any = None,
                      next_page_token: Any = None) -> Dict[str, Any]:
        self.search_calls.append(jql)
        results = list(self.issues.values())[:max_results]
        return {"issues": results, "total": len(results), "isLast": True, "nextPageToken": None}

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
        task = models.Task(
            project_id=project.id,
            title="T1",
            description="",
            team_id=team.id,
            planned_start=date(2026, 8, 1),
            planned_end=date(2026, 8, 5),
            status="planned",
            progress=0,
        )
        self.db.add(task)
        self.db.commit()
        self.project_id = project.id
        self.team_id = team.id
        self.task_id = task.id

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

    def test_task_link_roundtrip(self) -> None:
        self.fake.add("STORY-1", status="Done", category="done")
        link = jira_service.link_issue_to_task(
            self.db, self.task_id, schemas.JiraLinkCreate(jira_key="STORY-1")
        )
        self.assertEqual(link.issue.key, "STORY-1")

        links = jira_service.list_task_links(self.db, self.task_id, refresh_stale=False)
        self.assertEqual(len(links), 1)

        jira_service.unlink_task_link(self.db, self.task_id, link.id)
        self.assertEqual(
            jira_service.list_task_links(self.db, self.task_id, refresh_stale=False), []
        )


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


if __name__ == "__main__":
    unittest.main()

from datetime import date, datetime
import unittest

from app import models, schemas, services
from app.database import Base
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker


class RiskCalculationTests(unittest.TestCase):
    def test_flags_direct_delay_and_dependency_slip(self) -> None:
        project = models.Project(id=1, name="Alpha", description="", color="#0f766e")
        team = models.Team(id=1, project_id=1, name="Platform", color="#0f766e")
        team.project = project
        upstream = models.Task(
            id=1,
            project_id=1,
            title="Upstream",
            description="",
            team_id=1,
            planned_start=date(2026, 7, 1),
            planned_end=date(2026, 7, 4),
            current_start=date(2026, 7, 1),
            current_end=date(2026, 7, 7),
            status="in_progress",
            progress=80,
        )
        upstream.team = team
        downstream = models.Task(
            id=2,
            project_id=1,
            title="Downstream",
            description="",
            team_id=1,
            planned_start=date(2026, 7, 5),
            planned_end=date(2026, 7, 8),
            current_start=date(2026, 7, 5),
            current_end=date(2026, 7, 10),
            status="planned",
            progress=0,
        )
        downstream.team = team
        dependency = models.TaskDependency(upstream_task_id=1, downstream_task_id=2)
        dependency.upstream_task = upstream
        downstream.incoming_links = [dependency]

        risk = services.calculate_risk(downstream)

        self.assertTrue(risk.delayed)
        self.assertTrue(risk.at_risk)
        self.assertEqual(risk.risk_level, "high")
        self.assertEqual(risk.delay_days, 2)
        self.assertEqual(risk.dependency_slip_days, 2)


class ProjectIsolationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
        Base.metadata.create_all(bind=self.engine)
        self.session_maker = sessionmaker(bind=self.engine)

    def tearDown(self) -> None:
        Base.metadata.drop_all(bind=self.engine)
        self.engine.dispose()

    def test_rejects_cross_project_dependency(self) -> None:
        db: Session = self.session_maker()
        try:
            p1 = models.Project(name="P1", description="", color="#0f766e")
            p2 = models.Project(name="P2", description="", color="#1d4ed8")
            db.add_all([p1, p2])
            db.flush()

            team1 = models.Team(project_id=p1.id, name="A", color="#0f766e")
            team2 = models.Team(project_id=p2.id, name="B", color="#1d4ed8")
            db.add_all([team1, team2])
            db.flush()

            task1 = models.Task(
                project_id=p1.id,
                title="Task P1",
                description="",
                team_id=team1.id,
                planned_start=date(2026, 7, 1),
                planned_end=date(2026, 7, 2),
                current_start=date(2026, 7, 1),
                current_end=date(2026, 7, 2),
                status="planned",
                progress=0,
            )
            task2 = models.Task(
                project_id=p2.id,
                title="Task P2",
                description="",
                team_id=team2.id,
                planned_start=date(2026, 7, 3),
                planned_end=date(2026, 7, 4),
                current_start=date(2026, 7, 3),
                current_end=date(2026, 7, 4),
                status="planned",
                progress=0,
            )
            db.add_all([task1, task2])
            db.flush()

            with self.assertRaises(ValueError):
                services.replace_dependencies(db, task2, [task1.id])
        finally:
            db.close()


class ProjectMutationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
        Base.metadata.create_all(bind=self.engine)
        self.session_maker = sessionmaker(bind=self.engine)
        self.db: Session = self.session_maker()

    def tearDown(self) -> None:
        self.db.close()
        Base.metadata.drop_all(bind=self.engine)
        self.engine.dispose()

    def _project_with_work(self, name: str) -> models.Project:
        project = models.Project(name=name, description="Original copy.", color="#0f766e")
        self.db.add(project)
        self.db.flush()

        team = models.Team(project_id=project.id, name=f"{name} Team", color="#0f766e")
        self.db.add(team)
        self.db.flush()

        upstream = models.Task(
            project_id=project.id,
            title=f"{name} Upstream",
            description="",
            team_id=team.id,
            planned_start=date(2026, 7, 1),
            planned_end=date(2026, 7, 2),
            status="planned",
            progress=0,
        )
        downstream = models.Task(
            project_id=project.id,
            title=f"{name} Downstream",
            description="",
            team_id=team.id,
            planned_start=date(2026, 7, 3),
            planned_end=date(2026, 7, 4),
            status="planned",
            progress=0,
        )
        self.db.add_all([upstream, downstream])
        self.db.flush()
        self.db.add(
            models.TaskDependency(
                upstream_task_id=upstream.id, downstream_task_id=downstream.id
            )
        )

        issue = models.JiraIssue(
            jira_key=f"{name[:3].upper()}-1",
            jira_url="https://example.atlassian.net/browse/X-1",
            synced_at=datetime(2026, 8, 1, 12, 0, 0),
        )
        self.db.add(issue)
        self.db.flush()
        self.db.add(
            models.ProjectJiraLink(
                project_id=project.id,
                team_id=team.id,
                jira_issue_id=issue.id,
                linked_at=datetime(2026, 8, 1, 12, 0, 0),
            )
        )
        self.db.commit()
        return project

    def test_update_renames_recolors_and_clears_description(self) -> None:
        project = self._project_with_work("Alpha")

        services.update_project(
            self.db,
            project,
            schemas.ProjectUpdate(name="Alpha Renamed", color="#1d4ed8", description=""),
        )

        self.assertEqual(project.name, "Alpha Renamed")
        self.assertEqual(project.color, "#1d4ed8")
        self.assertEqual(project.description, "")

    def test_update_leaves_unset_fields_alone(self) -> None:
        project = self._project_with_work("Alpha")

        services.update_project(self.db, project, schemas.ProjectUpdate(color="#1d4ed8"))

        self.assertEqual(project.name, "Alpha")
        self.assertEqual(project.description, "Original copy.")

    def test_update_rejects_duplicate_name(self) -> None:
        self._project_with_work("Alpha")
        beta = self._project_with_work("Beta")

        with self.assertRaises(ValueError):
            services.update_project(self.db, beta, schemas.ProjectUpdate(name="Alpha"))

    def test_delete_removes_children_and_jira_links_only_for_that_project(self) -> None:
        alpha = self._project_with_work("Alpha")
        beta = self._project_with_work("Beta")
        alpha_id = alpha.id
        beta_id = beta.id

        services.delete_project(self.db, alpha)

        self.assertIsNone(self.db.get(models.Project, alpha_id))
        for model in (models.Team, models.Task, models.ProjectJiraLink):
            remaining = self.db.scalars(
                select(model).where(model.project_id == alpha_id)
            ).all()
            self.assertEqual(list(remaining), [], f"{model.__name__} rows survived")
        surviving_dependencies = list(self.db.scalars(select(models.TaskDependency)).all())
        self.assertEqual(len(surviving_dependencies), 1)

        self.assertIsNotNone(self.db.get(models.Project, beta_id))
        self.assertEqual(len(services.list_tasks(self.db, beta_id)), 2)
        self.assertEqual(len(services.list_teams(self.db, beta_id)), 1)
        # The cached Jira issue itself is shared, so it must outlive the link.
        self.assertEqual(len(list(self.db.scalars(select(models.JiraIssue)).all())), 2)


if __name__ == "__main__":
    unittest.main()
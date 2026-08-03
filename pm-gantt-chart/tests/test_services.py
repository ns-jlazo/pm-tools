from datetime import date
import unittest

from app import models, services
from app.database import Base
from sqlalchemy import create_engine
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


if __name__ == "__main__":
    unittest.main()
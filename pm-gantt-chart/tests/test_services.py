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
        upstream = models.Deliverable(
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
        downstream = models.Deliverable(
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
        dependency = models.DeliverableDependency(upstream_deliverable_id=1, downstream_deliverable_id=2)
        dependency.upstream_deliverable = upstream
        downstream.incoming_links = [dependency]

        risk = services.calculate_risk(downstream)

        self.assertTrue(risk.delayed)
        self.assertTrue(risk.at_risk)
        self.assertEqual(risk.risk_level, "high")
        self.assertEqual(risk.delay_days, 2)
        self.assertEqual(risk.dependency_slip_days, 2)


class MilestoneRiskRollupTests(unittest.TestCase):
    """Risk rolls up from milestones to the parent; progress deliberately does not."""

    def _deliverable(self) -> models.Deliverable:
        deliverable = models.Deliverable(
            id=1,
            project_id=1,
            title="API Contracts",
            description="",
            team_id=1,
            planned_start=date(2026, 7, 1),
            planned_end=date(2026, 7, 10),
            current_start=date(2026, 7, 1),
            current_end=date(2026, 7, 10),
            status="in_progress",
            progress=40,
        )
        return deliverable

    @staticmethod
    def _milestone(title: str, target: date, actual: date = None) -> models.Milestone:
        return models.Milestone(
            id=1,
            deliverable_id=1,
            title=title,
            description="",
            team_id=1,
            target_date=target,
            actual_date=actual,
            status="planned",
            progress=0,
        )

    def test_open_milestone_never_reads_as_slipped(self) -> None:
        deliverable = self._deliverable()
        # Target already in the past, but nothing landed yet: no actual date means
        # there is nothing to measure a slip against.
        deliverable.milestones = [self._milestone("Schema frozen", date(2026, 7, 2))]

        risk = services.calculate_risk(deliverable)

        self.assertFalse(risk.at_risk)
        self.assertEqual(risk.risk_level, "none")
        self.assertEqual(risk.milestone_slip_days, 0)
        self.assertEqual(risk.risk_reasons, [])

    def test_small_slip_makes_the_parent_medium_risk(self) -> None:
        deliverable = self._deliverable()
        deliverable.milestones = [
            self._milestone("Schema frozen", date(2026, 7, 2), date(2026, 7, 4))
        ]

        risk = services.calculate_risk(deliverable)

        self.assertTrue(risk.at_risk)
        self.assertFalse(risk.delayed)
        self.assertEqual(risk.risk_level, "medium")
        self.assertEqual(risk.milestone_slip_days, 2)
        self.assertEqual(
            risk.risk_reasons, ["Milestone Schema frozen slipped by 2 day(s)"]
        )
        # The parent keeps its own progress: only risk rolls up.
        self.assertEqual(deliverable.progress, 40)

    def test_three_day_slip_raises_the_parent_to_high(self) -> None:
        deliverable = self._deliverable()
        deliverable.milestones = [
            self._milestone("Schema frozen", date(2026, 7, 2), date(2026, 7, 5))
        ]

        risk = services.calculate_risk(deliverable)

        self.assertEqual(risk.risk_level, "high")
        self.assertEqual(risk.milestone_slip_days, 3)

    def test_worst_slip_wins_and_every_reason_is_reported(self) -> None:
        deliverable = self._deliverable()
        deliverable.milestones = [
            self._milestone("Schema frozen", date(2026, 7, 2), date(2026, 7, 3)),
            self._milestone("Client generated", date(2026, 7, 4), date(2026, 7, 9)),
        ]

        risk = services.calculate_risk(deliverable)

        self.assertEqual(risk.milestone_slip_days, 5)
        self.assertEqual(
            risk.risk_reasons,
            [
                "Milestone Schema frozen slipped by 1 day(s)",
                "Milestone Client generated slipped by 5 day(s)",
            ],
        )

    def test_milestone_risk_is_reported_on_its_own(self) -> None:
        clean = services.calculate_milestone_risk(
            self._milestone("Schema frozen", date(2026, 7, 2), date(2026, 7, 2))
        )
        slipped = services.calculate_milestone_risk(
            self._milestone("Schema frozen", date(2026, 7, 2), date(2026, 7, 6))
        )

        self.assertEqual((clean.slipped, clean.slip_days, clean.risk_level),
                         (False, 0, "none"))
        self.assertEqual((slipped.slipped, slipped.slip_days, slipped.risk_level),
                         (True, 4, "high"))


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

            deliverable1 = models.Deliverable(
                project_id=p1.id,
                title="Deliverable P1",
                description="",
                team_id=team1.id,
                planned_start=date(2026, 7, 1),
                planned_end=date(2026, 7, 2),
                current_start=date(2026, 7, 1),
                current_end=date(2026, 7, 2),
                status="planned",
                progress=0,
            )
            deliverable2 = models.Deliverable(
                project_id=p2.id,
                title="Deliverable P2",
                description="",
                team_id=team2.id,
                planned_start=date(2026, 7, 3),
                planned_end=date(2026, 7, 4),
                current_start=date(2026, 7, 3),
                current_end=date(2026, 7, 4),
                status="planned",
                progress=0,
            )
            db.add_all([deliverable1, deliverable2])
            db.flush()

            with self.assertRaises(ValueError):
                services.replace_dependencies(db, deliverable2, [deliverable1.id])
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

        upstream = models.Deliverable(
            project_id=project.id,
            title=f"{name} Upstream",
            description="",
            team_id=team.id,
            planned_start=date(2026, 7, 1),
            planned_end=date(2026, 7, 2),
            status="planned",
            progress=0,
        )
        downstream = models.Deliverable(
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
            models.DeliverableDependency(
                upstream_deliverable_id=upstream.id, downstream_deliverable_id=downstream.id
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

    def test_update_sets_and_clears_a_release_date(self) -> None:
        project = self._project_with_work("Alpha")
        release = services.create_release(
            self.db, project.id, schemas.ReleaseCreate(name="1.0")
        )

        services.update_release(
            self.db, release, schemas.ReleaseUpdate(release_date=date(2026, 9, 1))
        )
        self.assertEqual(release.release_date, date(2026, 9, 1))

        # An explicit null clears the date; an omitted field leaves it alone.
        services.update_release(self.db, release, schemas.ReleaseUpdate(name="1.0.1"))
        self.assertEqual(release.release_date, date(2026, 9, 1))
        services.update_release(self.db, release, schemas.ReleaseUpdate(release_date=None))
        self.assertIsNone(release.release_date)

    def test_release_status_defaults_to_planned_and_can_change(self) -> None:
        project = self._project_with_work("Alpha")
        release = services.create_release(
            self.db, project.id, schemas.ReleaseCreate(name="1.0")
        )
        self.assertEqual(release.status, "planned")

        for status in ("on_track", "at_risk", "completed", "planned"):
            services.update_release(
                self.db, release, schemas.ReleaseUpdate(status=status)
            )
            self.assertEqual(release.status, status)

        # An omitted status leaves it alone.
        services.update_release(self.db, release, schemas.ReleaseUpdate(name="1.0.1"))
        self.assertEqual(release.status, "planned")

    def test_release_status_rejects_unknown_values(self) -> None:
        from pydantic import ValidationError

        with self.assertRaises(ValidationError):
            schemas.ReleaseCreate(name="1.0", status="active")
        with self.assertRaises(ValidationError):
            schemas.ReleaseUpdate(status="inactive")

    def test_release_names_are_unique_per_project(self) -> None:
        alpha = self._project_with_work("Alpha")
        beta = self._project_with_work("Beta")
        services.create_release(self.db, alpha.id, schemas.ReleaseCreate(name="1.0"))

        services.create_release(self.db, beta.id, schemas.ReleaseCreate(name="1.0"))
        with self.assertRaises(ValueError):
            services.create_release(self.db, alpha.id, schemas.ReleaseCreate(name="1.0"))

    def test_deliverables_and_key_dates_are_scoped_to_their_release(self) -> None:
        project = self._project_with_work("Alpha")
        first = services.create_release(self.db, project.id, schemas.ReleaseCreate(name="1.0"))
        second = services.create_release(self.db, project.id, schemas.ReleaseCreate(name="2.0"))
        team = services.list_teams(self.db, project.id)[0]
        services.create_deliverable(
            self.db,
            project.id,
            schemas.DeliverableCreate(
                title="Only in 2.0",
                team_id=team.id,
                planned_start=date(2026, 8, 1),
                planned_end=date(2026, 8, 2),
                release_id=second.id,
            ),
        )
        services.create_key_date(
            self.db,
            project.id,
            schemas.ProjectKeyDateCreate(
                name="Freeze", event_date=date(2026, 8, 1), release_id=second.id
            ),
        )

        in_first = services.dashboard_payload(self.db, project.id, first.id)
        in_second = services.dashboard_payload(self.db, project.id, second.id)

        self.assertEqual([d.title for d in in_first.deliverables], [])
        self.assertEqual(in_first.key_dates, [])
        self.assertEqual([d.title for d in in_second.deliverables], ["Only in 2.0"])
        self.assertEqual([k.name for k in in_second.key_dates], ["Freeze"])

    def test_rejects_a_release_from_another_project(self) -> None:
        alpha = self._project_with_work("Alpha")
        beta = self._project_with_work("Beta")
        foreign = services.create_release(self.db, beta.id, schemas.ReleaseCreate(name="1.0"))

        with self.assertRaises(ValueError):
            services.resolve_release_id(self.db, alpha.id, foreign.id)

    def test_create_project_seeds_a_first_release(self) -> None:
        project = services.create_project(
            self.db,
            schemas.ProjectCreate(
                name="Gamma", release_name="GA", release_date=date(2026, 12, 1)
            ),
        )

        releases = services.list_releases(self.db, project.id)
        self.assertEqual([(r.name, r.release_date) for r in releases], [("GA", date(2026, 12, 1))])

    def test_status_can_be_set_inactive(self) -> None:
        project = self._project_with_work("Alpha")

        services.update_project(self.db, project, schemas.ProjectUpdate(status="inactive"))

        self.assertEqual(project.status, "inactive")
        with self.assertRaises(ValueError):
            schemas.ProjectUpdate(status="archived")

    def test_promoting_an_example_can_clear_its_sample_data(self) -> None:
        project = self._project_with_work("Alpha")
        project.is_example = True
        self.db.commit()

        services.update_project(
            self.db,
            project,
            schemas.ProjectUpdate(is_example=False, clear_sample_data=True),
        )

        self.assertFalse(project.is_example)
        self.assertEqual(services.list_deliverables(self.db, project.id), [])
        self.assertEqual(len(services.list_teams(self.db, project.id)), 1)

    def test_promoting_an_example_keeps_data_by_default(self) -> None:
        project = self._project_with_work("Alpha")
        project.is_example = True
        self.db.commit()

        services.update_project(self.db, project, schemas.ProjectUpdate(is_example=False))

        self.assertEqual(len(services.list_deliverables(self.db, project.id)), 2)

    def test_clear_sample_data_is_ignored_for_non_example_workspaces(self) -> None:
        project = self._project_with_work("Alpha")

        services.update_project(
            self.db, project, schemas.ProjectUpdate(color="#1d4ed8", clear_sample_data=True)
        )

        self.assertEqual(len(services.list_deliverables(self.db, project.id)), 2)

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
        for model in (models.Team, models.Deliverable, models.ProjectJiraLink):
            remaining = self.db.scalars(
                select(model).where(model.project_id == alpha_id)
            ).all()
            self.assertEqual(list(remaining), [], f"{model.__name__} rows survived")
        surviving_dependencies = list(self.db.scalars(select(models.DeliverableDependency)).all())
        self.assertEqual(len(surviving_dependencies), 1)

        self.assertIsNotNone(self.db.get(models.Project, beta_id))
        self.assertEqual(len(services.list_deliverables(self.db, beta_id)), 2)
        self.assertEqual(len(services.list_teams(self.db, beta_id)), 1)
        # The cached Jira issue itself is shared, so it must outlive the link.
        self.assertEqual(len(list(self.db.scalars(select(models.JiraIssue)).all())), 2)


class MilestoneCrudTests(unittest.TestCase):
    """A milestone belongs to a deliverable but may be owned by any project team."""

    def setUp(self) -> None:
        self.engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
        Base.metadata.create_all(bind=self.engine)
        self.session_maker = sessionmaker(bind=self.engine)
        self.db: Session = self.session_maker()

        self.project = models.Project(name="Alpha", description="", color="#0f766e")
        self.other_project = models.Project(name="Beta", description="", color="#1d4ed8")
        self.db.add_all([self.project, self.other_project])
        self.db.flush()

        self.team = models.Team(project_id=self.project.id, name="Platform", color="#0f766e")
        self.sibling_team = models.Team(
            project_id=self.project.id, name="Mobile", color="#7c3aed"
        )
        self.foreign_team = models.Team(
            project_id=self.other_project.id, name="Other", color="#1d4ed8"
        )
        self.db.add_all([self.team, self.sibling_team, self.foreign_team])
        self.db.flush()

        self.deliverable = models.Deliverable(
            project_id=self.project.id,
            title="API Contracts",
            description="",
            team_id=self.team.id,
            planned_start=date(2026, 7, 1),
            planned_end=date(2026, 7, 10),
            status="in_progress",
            progress=40,
        )
        self.db.add(self.deliverable)
        self.db.commit()

    def tearDown(self) -> None:
        self.db.close()
        Base.metadata.drop_all(bind=self.engine)
        self.engine.dispose()

    def _create(self, **overrides) -> models.Milestone:
        payload = {
            "title": "Schema frozen",
            "team_id": self.team.id,
            "target_date": date(2026, 7, 4),
        }
        payload.update(overrides)
        return services.create_milestone(
            self.db, self.deliverable, schemas.MilestoneCreate(**payload)
        )

    def test_create_accepts_any_team_on_the_same_project(self) -> None:
        # Splitting a deliverable across teams is the whole point of milestones.
        milestone = self._create(team_id=self.sibling_team.id)

        self.assertEqual(milestone.deliverable_id, self.deliverable.id)
        self.assertEqual(milestone.team_id, self.sibling_team.id)
        self.assertIsNone(milestone.actual_date)

    def test_create_rejects_a_team_from_another_project(self) -> None:
        with self.assertRaises(ValueError):
            self._create(team_id=self.foreign_team.id)

    def test_update_rejects_a_team_from_another_project(self) -> None:
        milestone = self._create()

        with self.assertRaises(ValueError):
            services.update_milestone(
                self.db, milestone, schemas.MilestoneUpdate(team_id=self.foreign_team.id)
            )

    def test_update_sets_and_clears_the_actual_date(self) -> None:
        milestone = self._create()

        services.update_milestone(
            self.db, milestone, schemas.MilestoneUpdate(actual_date=date(2026, 7, 8))
        )
        self.assertEqual(milestone.actual_date, date(2026, 7, 8))

        # Reopening a milestone marked complete by mistake sends an explicit null.
        services.update_milestone(self.db, milestone, schemas.MilestoneUpdate(actual_date=None))
        self.assertIsNone(milestone.actual_date)

    def test_update_leaves_omitted_fields_alone(self) -> None:
        milestone = self._create(description="Agreed with mobile.")

        services.update_milestone(self.db, milestone, schemas.MilestoneUpdate(status="blocked"))

        self.assertEqual(milestone.status, "blocked")
        self.assertEqual(milestone.description, "Agreed with mobile.")
        self.assertEqual(milestone.target_date, date(2026, 7, 4))

    def test_progress_is_never_accepted_from_clients(self) -> None:
        milestone = self._create(progress=25)
        self.assertEqual(milestone.progress, 0)

        services.update_milestone(self.db, milestone, schemas.MilestoneUpdate(progress=60))
        self.assertEqual(milestone.progress, 0)

    def test_progress_is_the_share_of_linked_stories_that_are_done(self) -> None:
        milestone = self._create()
        self.assertEqual(services.compute_milestone_progress(self.db, milestone.id), 0)

        rows = [
            ("SNA-1", "Story", "Done"),
            ("SNA-2", "Story", "In Progress"),
            ("SNA-3", "Epic", "Done"),  # epics never count
        ]
        for key, issue_type, category in rows:
            issue = models.JiraIssue(
                jira_key=key,
                jira_url=f"https://example.atlassian.net/browse/{key}",
                issue_type=issue_type,
                status_category=category,
                synced_at=datetime(2026, 8, 1, 12, 0, 0),
            )
            self.db.add(issue)
            self.db.flush()
            self.db.add(
                models.MilestoneJiraLink(
                    milestone_id=milestone.id,
                    jira_issue_id=issue.id,
                    linked_at=datetime(2026, 8, 1, 12, 0, 0),
                )
            )
        self.db.commit()

        services.recalc_milestone_progress(self.db, milestone.id)
        self.db.commit()
        self.assertEqual(milestone.progress, 50)

    def test_deliverables_carry_their_milestones_sorted_by_target_date(self) -> None:
        self._create(title="Client generated", target_date=date(2026, 7, 8))
        self._create(title="Schema frozen", target_date=date(2026, 7, 4))

        rows = services.list_deliverables(self.db, self.project.id)
        serialized = services.serialize_deliverable(rows[0])

        self.assertEqual(
            [milestone.title for milestone in serialized.milestones],
            ["Schema frozen", "Client generated"],
        )
        self.assertEqual(serialized.milestones[0].team_name, "Platform")
        self.assertEqual(serialized.milestones[0].project_id, self.project.id)

    def test_deleting_the_parent_takes_its_milestones_and_jira_links(self) -> None:
        milestone = self._create()
        issue = models.JiraIssue(
            jira_key="SNA-1",
            jira_url="https://example.atlassian.net/browse/SNA-1",
            synced_at=datetime(2026, 8, 1, 12, 0, 0),
        )
        self.db.add(issue)
        self.db.flush()
        self.db.add(
            models.MilestoneJiraLink(
                milestone_id=milestone.id,
                jira_issue_id=issue.id,
                linked_at=datetime(2026, 8, 1, 12, 0, 0),
            )
        )
        self.db.commit()

        self.db.delete(self.deliverable)
        self.db.commit()

        self.assertEqual(list(self.db.scalars(select(models.Milestone)).all()), [])
        self.assertEqual(list(self.db.scalars(select(models.MilestoneJiraLink)).all()), [])
        # The cached issue is shared, so it must outlive the link.
        self.assertEqual(len(list(self.db.scalars(select(models.JiraIssue)).all())), 1)

    def test_delete_team_is_blocked_by_a_milestone_it_owns(self) -> None:
        self._create(team_id=self.sibling_team.id)

        with self.assertRaises(services.TeamInUseError) as caught:
            services.delete_team(self.db, self.project.id, self.sibling_team)

        self.assertIn("milestone", str(caught.exception))

    def test_delete_milestone_frees_the_team(self) -> None:
        milestone = self._create(team_id=self.sibling_team.id)
        team_id = self.sibling_team.id

        services.delete_milestone(self.db, milestone)
        services.delete_team(self.db, self.project.id, self.sibling_team)

        self.assertIsNone(self.db.get(models.Team, team_id))


class ExampleWorkspaceFlagTests(unittest.TestCase):
    """The landing page splits sections on `is_example`, so it has to round-trip."""

    def setUp(self) -> None:
        self.engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
        Base.metadata.create_all(bind=self.engine)
        self.session_maker = sessionmaker(bind=self.engine)
        self.db: Session = self.session_maker()

    def tearDown(self) -> None:
        self.db.close()
        Base.metadata.drop_all(bind=self.engine)
        self.engine.dispose()

    def test_create_honors_the_flag_and_defaults_to_real(self) -> None:
        example = services.create_project(
            self.db, schemas.ProjectCreate(name="Demo", description="", is_example=True)
        )
        real = services.create_project(
            self.db, schemas.ProjectCreate(name="Customer Work", description="")
        )

        self.assertTrue(example.is_example)
        self.assertFalse(real.is_example)

    def test_update_can_demote_without_clobbering_other_fields(self) -> None:
        project = services.create_project(
            self.db,
            schemas.ProjectCreate(
                name="Demo", description="Guidance copy.", color="#1d4ed8", is_example=True
            ),
        )

        services.update_project(self.db, project, schemas.ProjectUpdate(is_example=False))

        self.assertFalse(project.is_example)
        self.assertEqual(project.name, "Demo")
        self.assertEqual(project.description, "Guidance copy.")
        self.assertEqual(project.color, "#1d4ed8")

    def test_update_leaves_the_flag_alone_when_omitted(self) -> None:
        project = services.create_project(
            self.db, schemas.ProjectCreate(name="Demo", description="", is_example=True)
        )

        services.update_project(self.db, project, schemas.ProjectUpdate(name="Demo v2"))

        self.assertTrue(project.is_example)

    def test_project_cards_surface_the_flag(self) -> None:
        services.create_project(
            self.db, schemas.ProjectCreate(name="Demo", description="", is_example=True)
        )
        services.create_project(
            self.db, schemas.ProjectCreate(name="Customer Work", description="")
        )

        cards = {card.name: card.is_example for card in services.project_cards(self.db)}

        self.assertEqual(cards, {"Demo": True, "Customer Work": False})

    def test_new_projects_get_a_utc_created_at(self) -> None:
        services.create_project(
            self.db, schemas.ProjectCreate(name="Fresh", description="")
        )

        card = next(c for c in services.project_cards(self.db) if c.name == "Fresh")

        self.assertIsNotNone(card.created_at)
        self.assertEqual(card.created_at.utcoffset().total_seconds(), 0)


class DeliverableJiraLabelTests(unittest.TestCase):
    """The label and its date window round-trip through create and update."""

    def setUp(self) -> None:
        self.engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
        Base.metadata.create_all(bind=self.engine)
        self.db: Session = sessionmaker(bind=self.engine)()
        self.project = models.Project(name="Alpha", description="", color="#0f766e")
        self.db.add(self.project)
        self.db.flush()
        self.team = models.Team(project_id=self.project.id, name="Platform", color="#0f766e")
        self.db.add(self.team)
        self.db.commit()

    def tearDown(self) -> None:
        self.db.close()
        Base.metadata.drop_all(bind=self.engine)
        self.engine.dispose()

    def _payload(self, **extra) -> schemas.DeliverableCreate:
        return schemas.DeliverableCreate(
            title="Login",
            team_id=self.team.id,
            planned_start=date(2026, 7, 1),
            planned_end=date(2026, 7, 10),
            **extra,
        )

    def test_label_round_trips_and_is_trimmed(self) -> None:
        created = services.create_deliverable(
            self.db,
            self.project.id,
            self._payload(
                jira_label="  feat-login ",
                jira_label_project_key="PM",
                jira_label_from=date(2026, 7, 1),
                jira_label_to=date(2026, 9, 30),
            ),
        )

        read = services.serialize_deliverable(created)
        self.assertEqual(read.jira_label, "feat-login")
        self.assertEqual(read.jira_label_project_key, "PM")
        self.assertEqual(read.jira_label_from, date(2026, 7, 1))
        self.assertEqual(read.jira_label_to, date(2026, 9, 30))

    def test_blank_label_becomes_null_on_update(self) -> None:
        created = services.create_deliverable(
            self.db, self.project.id, self._payload(jira_label="feat-login")
        )

        updated = services.update_deliverable(
            self.db,
            self.project.id,
            created,
            schemas.DeliverableUpdate(jira_label="   "),
        )

        self.assertIsNone(updated.jira_label)

    def test_inverted_range_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            services.create_deliverable(
                self.db,
                self.project.id,
                self._payload(
                    jira_label_from=date(2026, 9, 30), jira_label_to=date(2026, 7, 1)
                ),
            )

    def test_update_checks_range_against_stored_bound(self) -> None:
        created = services.create_deliverable(
            self.db,
            self.project.id,
            self._payload(jira_label_from=date(2026, 7, 1), jira_label_to=date(2026, 9, 30)),
        )

        with self.assertRaises(ValueError):
            services.update_deliverable(
                self.db,
                self.project.id,
                created,
                schemas.DeliverableUpdate(jira_label_to=date(2026, 6, 1)),
            )


if __name__ == "__main__":
    unittest.main()
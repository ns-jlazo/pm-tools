"""Coverage for the in-place startup schema migrations."""

import unittest

from sqlalchemy import create_engine, inspect, text

from app.main import (
    _migrate_deliverable_rename,
    _migrate_example_flag,
    _migrate_release_date,
)


# The v2 schema as it shipped before the deliverable rename, trimmed to the
# tables the migration touches.
_LEGACY_DDL = [
    """
    CREATE TABLE projects (
        id INTEGER NOT NULL PRIMARY KEY,
        name VARCHAR(160) NOT NULL,
        description TEXT NOT NULL,
        color VARCHAR(20) NOT NULL
    )
    """,
    """
    CREATE TABLE teams (
        id INTEGER NOT NULL PRIMARY KEY,
        project_id INTEGER NOT NULL,
        name VARCHAR(120) NOT NULL,
        color VARCHAR(20) NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects (id)
    )
    """,
    """
    CREATE TABLE tasks (
        id INTEGER NOT NULL PRIMARY KEY,
        project_id INTEGER NOT NULL,
        title VARCHAR(200) NOT NULL,
        description TEXT NOT NULL,
        team_id INTEGER NOT NULL,
        planned_start DATE NOT NULL,
        planned_end DATE NOT NULL,
        current_start DATE,
        current_end DATE,
        status VARCHAR(30) NOT NULL,
        progress INTEGER NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects (id),
        FOREIGN KEY(team_id) REFERENCES teams (id)
    )
    """,
    "CREATE INDEX ix_tasks_id ON tasks (id)",
    """
    CREATE TABLE task_dependencies (
        upstream_task_id INTEGER NOT NULL,
        downstream_task_id INTEGER NOT NULL,
        PRIMARY KEY (upstream_task_id, downstream_task_id),
        FOREIGN KEY(upstream_task_id) REFERENCES tasks (id) ON DELETE CASCADE,
        FOREIGN KEY(downstream_task_id) REFERENCES tasks (id) ON DELETE CASCADE
    )
    """,
    """
    CREATE TABLE task_contributor_teams (
        task_id INTEGER NOT NULL,
        team_id INTEGER NOT NULL,
        PRIMARY KEY (task_id, team_id),
        FOREIGN KEY(task_id) REFERENCES tasks (id) ON DELETE CASCADE,
        FOREIGN KEY(team_id) REFERENCES teams (id) ON DELETE CASCADE
    )
    """,
    """
    CREATE TABLE task_jira_links (
        id INTEGER NOT NULL PRIMARY KEY,
        task_id INTEGER NOT NULL,
        jira_issue_id INTEGER NOT NULL,
        linked_at DATETIME NOT NULL,
        CONSTRAINT uq_task_jira_link UNIQUE (task_id, jira_issue_id),
        FOREIGN KEY(task_id) REFERENCES tasks (id) ON DELETE CASCADE
    )
    """,
]

_LEGACY_ROWS = [
    "INSERT INTO projects VALUES (1, 'Alpha', '', '#0f766e')",
    "INSERT INTO teams VALUES (1, 1, 'Platform', '#0f766e')",
    "INSERT INTO tasks VALUES "
    "(7, 1, 'Checkout', '', 1, '2026-07-01', '2026-07-04', NULL, NULL, 'planned', 0)",
    "INSERT INTO tasks VALUES "
    "(8, 1, 'Fulfillment', '', 1, '2026-07-05', '2026-07-08', NULL, NULL, 'planned', 0)",
    "INSERT INTO task_dependencies VALUES (7, 8)",
    "INSERT INTO task_contributor_teams VALUES (8, 1)",
    "INSERT INTO task_jira_links VALUES (3, 7, 42, '2026-08-01 12:00:00')",
]


class DeliverableRenameMigrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine(
            "sqlite:///:memory:", connect_args={"check_same_thread": False}
        )

    def tearDown(self) -> None:
        self.engine.dispose()

    def _build_legacy(self) -> None:
        with self.engine.begin() as connection:
            for statement in _LEGACY_DDL + _LEGACY_ROWS:
                connection.execute(text(statement))

    def _columns(self, table: str) -> set:
        return {column["name"] for column in inspect(self.engine).get_columns(table)}

    def test_renames_tables_columns_and_keeps_rows(self) -> None:
        self._build_legacy()

        _migrate_deliverable_rename(self.engine)

        tables = set(inspect(self.engine).get_table_names())
        self.assertIn("deliverables", tables)
        self.assertIn("deliverable_dependencies", tables)
        self.assertIn("deliverable_contributor_teams", tables)
        self.assertIn("deliverable_jira_links", tables)
        for legacy in ("tasks", "task_dependencies", "task_contributor_teams", "task_jira_links"):
            self.assertNotIn(legacy, tables)

        self.assertEqual(
            self._columns("deliverable_dependencies"),
            {"upstream_deliverable_id", "downstream_deliverable_id"},
        )
        self.assertIn("deliverable_id", self._columns("deliverable_contributor_teams"))
        self.assertIn("deliverable_id", self._columns("deliverable_jira_links"))

        with self.engine.begin() as connection:
            titles = list(
                connection.execute(
                    text("SELECT title FROM deliverables ORDER BY id")
                ).scalars()
            )
            dependency = connection.execute(
                text(
                    "SELECT upstream_deliverable_id, downstream_deliverable_id "
                    "FROM deliverable_dependencies"
                )
            ).one()
            jira_link = connection.execute(
                text("SELECT deliverable_id, jira_issue_id FROM deliverable_jira_links")
            ).one()
            # Renaming `tasks` must rewrite the child tables' FK targets.
            child_ddl = connection.execute(
                text("SELECT sql FROM sqlite_master WHERE name = 'deliverable_jira_links'")
            ).scalar_one()

        self.assertEqual(titles, ["Checkout", "Fulfillment"])
        self.assertEqual(tuple(dependency), (7, 8))
        self.assertEqual(tuple(jira_link), (7, 42))
        # SQLite quotes the table it rewrites: `REFERENCES "deliverables"`.
        self.assertIn('REFERENCES "deliverables"', child_ddl)
        self.assertNotIn("tasks", child_ddl)

    def test_drops_the_stale_task_index(self) -> None:
        self._build_legacy()

        _migrate_deliverable_rename(self.engine)

        with self.engine.begin() as connection:
            indexes = list(
                connection.execute(
                    text("SELECT name FROM sqlite_master WHERE type = 'index'")
                ).scalars()
            )
        self.assertNotIn("ix_tasks_id", indexes)

    def test_is_idempotent(self) -> None:
        self._build_legacy()

        _migrate_deliverable_rename(self.engine)
        _migrate_deliverable_rename(self.engine)  # must not raise

        with self.engine.begin() as connection:
            count = connection.execute(text("SELECT count(*) FROM deliverables")).scalar_one()
        self.assertEqual(count, 2)

    def test_no_ops_on_a_fresh_database(self) -> None:
        with self.engine.begin() as connection:
            connection.execute(text(_LEGACY_DDL[0]))  # projects only

        _migrate_deliverable_rename(self.engine)

        self.assertEqual(set(inspect(self.engine).get_table_names()), {"projects"})


class ExampleFlagMigrationTests(unittest.TestCase):
    """`projects.is_example` is added in place; create_all never adds columns."""

    def setUp(self) -> None:
        self.engine = create_engine(
            "sqlite:///:memory:", connect_args={"check_same_thread": False}
        )

    def tearDown(self) -> None:
        self.engine.dispose()

    def _build_projects(self, *names: str) -> None:
        with self.engine.begin() as connection:
            connection.execute(text(_LEGACY_DDL[0]))  # projects without is_example
            for index, name in enumerate(names, start=1):
                connection.execute(
                    text(
                        "INSERT INTO projects VALUES "
                        "(:id, :name, '', '#0f766e')"
                    ),
                    {"id": index, "name": name},
                )

    def _flags(self) -> dict:
        with self.engine.begin() as connection:
            rows = connection.execute(
                text("SELECT name, is_example FROM projects ORDER BY id")
            ).all()
        return {name: flag for name, flag in rows}

    def test_adds_column_and_flags_only_the_named_workspaces(self) -> None:
        self._build_projects(
            "Atlas API Expansion",
            "Phoenix Retail Refresh",
            "V2 Smoke Project",
            "Real Customer Work",
        )

        _migrate_example_flag(self.engine)

        columns = {c["name"] for c in inspect(self.engine).get_columns("projects")}
        self.assertIn("is_example", columns)
        self.assertEqual(
            self._flags(),
            {
                "Atlas API Expansion": 1,
                "Phoenix Retail Refresh": 1,
                "V2 Smoke Project": 1,
                "Real Customer Work": 0,
            },
        )

    def test_second_run_is_a_no_op(self) -> None:
        self._build_projects("Atlas API Expansion", "Real Customer Work")

        _migrate_example_flag(self.engine)
        _migrate_example_flag(self.engine)  # must not raise

        self.assertEqual(
            self._flags(), {"Atlas API Expansion": 1, "Real Customer Work": 0}
        )

    def test_does_not_re_promote_a_demoted_workspace(self) -> None:
        self._build_projects("Atlas API Expansion")

        _migrate_example_flag(self.engine)
        # The user demotes it in the Edit-workspace drawer.
        with self.engine.begin() as connection:
            connection.execute(text("UPDATE projects SET is_example = 0"))

        _migrate_example_flag(self.engine)

        self.assertEqual(self._flags(), {"Atlas API Expansion": 0})

    def test_no_ops_when_projects_table_is_absent(self) -> None:
        _migrate_example_flag(self.engine)  # must not raise

        self.assertEqual(set(inspect(self.engine).get_table_names()), set())


class ReleaseDateMigrationTests(unittest.TestCase):
    """`projects.release_date` is added in place, for the same reason as is_example."""

    def setUp(self) -> None:
        self.engine = create_engine(
            "sqlite:///:memory:", connect_args={"check_same_thread": False}
        )

    def tearDown(self) -> None:
        self.engine.dispose()

    def _build_projects(self) -> None:
        with self.engine.begin() as connection:
            connection.execute(text(_LEGACY_DDL[0]))  # projects without release_date
            connection.execute(
                text("INSERT INTO projects VALUES (1, 'Alpha', '', '#0f766e')")
            )

    def _columns(self) -> set:
        return {column["name"] for column in inspect(self.engine).get_columns("projects")}

    def test_adds_a_nullable_column_and_keeps_the_rows(self) -> None:
        self._build_projects()

        _migrate_release_date(self.engine)

        self.assertIn("release_date", self._columns())
        with self.engine.begin() as connection:
            row = connection.execute(
                text("SELECT name, release_date FROM projects")
            ).one()
        # Nullable, so existing workspaces have nothing to backfill.
        self.assertEqual(tuple(row), ("Alpha", None))

    def test_second_run_is_a_no_op(self) -> None:
        self._build_projects()

        _migrate_release_date(self.engine)
        with self.engine.begin() as connection:
            connection.execute(text("UPDATE projects SET release_date = '2026-09-01'"))

        _migrate_release_date(self.engine)  # must not raise or reset the value

        with self.engine.begin() as connection:
            stored = connection.execute(text("SELECT release_date FROM projects")).scalar_one()
        self.assertEqual(stored, "2026-09-01")

    def test_no_ops_when_projects_table_is_absent(self) -> None:
        _migrate_release_date(self.engine)  # must not raise

        self.assertEqual(set(inspect(self.engine).get_table_names()), set())

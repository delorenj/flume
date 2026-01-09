# Flume/Yi Database

PostgreSQL database schema for the 33GOD agentic pipeline.

## Connection

```
Host: 192.168.1.12
Port: 5432
Database: 33god
User: delorenj
```

## Files

- `schema.sql` - Complete database schema (source of truth)
- `migrations/` - Incremental migration files

## Schema Overview

### Core Tables

| Table | Description |
|-------|-------------|
| `projects` | Flume-managed projects with Plane integration |
| `teams` | Yi-managed teams with shared knowledge bases |
| `employees` | Agent nodes with skills, state, and memory |
| `tasks` | Work items synced with Plane issues |
| `bloodbank_events` | Event sourcing log for all state changes |
| `agent_state_history` | Full observability of agent state transitions |

### Supporting Tables

| Table | Description |
|-------|-------------|
| `memory_shards` | Agent memory pointers (Qdrant, Letta, etc.) |
| `task_contributors` | Many-to-many task participation |
| `sessions` | Jelmore-managed Zellij execution sessions |
| `artifacts` | Decision records, briefs, checkpoints |
| `daily_standups` | Async status reports |
| `peer_reviews` | Performance evaluations |

### Enums

- `agent_state` - Agent lifecycle states (initializing → terminated)
- `task_state` - Task workflow states (draft → done/failed/cancelled)
- `employee_role` - Hierarchy levels (contributor, manager, director)
- `agent_type` - Framework types (letta, agno, claude, smolagents, custom)
- `task_priority` - Priority levels (critical, high, medium, low)

## Migrations

Migrations use a simple version-based approach:

```sql
-- Check current version
SELECT * FROM schema_migrations ORDER BY applied_at DESC;

-- Apply a migration
psql -h 192.168.1.12 -U delorenj -d 33god -f migrations/V001__initial_schema.sql
```

### Migration Naming Convention

```
V{version}__{description}.sql
```

Examples:
- `V001__initial_schema.sql`
- `V002__add_agent_metrics.sql`
- `V003__add_task_tags_index.sql`

## Fresh Install

```bash
# Create database (if needed)
createdb -h 192.168.1.12 -U delorenj 33god

# Apply full schema
psql -h 192.168.1.12 -U delorenj -d 33god -f schema.sql
```

## Type Alignment

The schema is aligned with TypeScript types in:
- `packages/flume-core/src/db/postgres-client.ts`

Key record types:
- `EmployeeRecord` → `employees` table
- `TaskRecord` → `tasks` table
- `TeamRecord` → `teams` table
- `ProjectRecord` → `projects` table
- `BloodbankEventRecord` → `bloodbank_events` table

# Flume Obsidian Integration - Quick Reference

**Quick reference card for daily use**

---

## Keyboard Shortcuts

| Action | Shortcut | Description |
|--------|----------|-------------|
| **Open Task in Terminal** | `Ctrl+Shift+T` | Fire task assignment & launch agent |
| **Check Progress** | `Ctrl+Shift+P` | Query task status from monitor |
| **Mark Complete** | `Ctrl+Shift+C` | Complete/fail task & emit event |

*Note: Use `Cmd` instead of `Ctrl` on macOS*

---

## Quick Task Creation

### Minimal TASK.md

```markdown
---
type: task
title: Fix login bug
agent_type: claude-code
priority: high
working_dir: /path/to/project
---

# Fix login bug

User reports login redirect fails after authentication.
Check auth middleware and redirect logic in auth.js.

## Requirements
- [ ] Reproduce the issue
- [ ] Fix redirect logic
- [ ] Add test case
```

### Then:
1. Press `Ctrl+Shift+T` to launch agent
2. Terminal opens automatically
3. Agent starts working with full context

---

## Task Status Values

| Status | Emoji | Meaning |
|--------|-------|---------|
| `pending` | ⏳ | Created but not assigned |
| `assigned` | 📋 | Assigned to agent, waiting for session |
| `started` | ▶️ | Session created, agent launching |
| `in_progress` | ⚙️ | Agent actively working |
| `paused` | ⏸️ | Temporarily paused |
| `completed` | ✅ | Successfully finished |
| `failed` | ❌ | Task failed with errors |
| `stale` | ⚠️ | No heartbeat (may be stuck) |

---

## Priority Levels

| Priority | Emoji | When to Use |
|----------|-------|-------------|
| `low` | 🟢 | Nice-to-have improvements |
| `medium` | 🟡 | Standard feature work |
| `high` | 🟠 | Important bugs or features |
| `critical` | 🔴 | Production issues, blockers |

---

## Common Workflows

### Workflow 1: New Feature Task

```markdown
1. Create TASK.md with requirements
2. Press Ctrl+Shift+T
3. Select agent (e.g., claude-code)
4. Select priority (e.g., medium)
5. Terminal launches with agent
6. Monitor progress: Ctrl+Shift+P
7. When done: Ctrl+Shift+C
```

### Workflow 2: Bug Fix

```markdown
1. Create TASK.md with bug description
2. Set priority to "high"
3. Press Ctrl+Shift+T
4. Agent investigates and fixes
5. Review changes in IDE
6. Mark complete: Ctrl+Shift+C
```

### Workflow 3: Quick Task

```markdown
1. Create minimal TASK.md
2. Press Ctrl+Shift+T → select defaults
3. Agent works
4. Press Ctrl+Shift+C when satisfied
```

---

## Session Commands

### Attach to Running Session

```bash
# Zellij (recommended)
zellij attach flume-{task_id}

# Tmux
tmux attach-session -t flume-{task_id}
```

### List Active Sessions

```bash
# Zellij
zellij list-sessions | grep flume

# Tmux
tmux list-sessions | grep flume
```

### Detach from Session

```bash
# Zellij: Press Ctrl+O, then D
# Tmux: Press Ctrl+B, then D
```

---

## Manual Event Publishing

If QuickAdd macro fails, use CLI directly:

```bash
# Assign task
bb task-assign \
  --task-id TASK-001 \
  --title "Fix bug" \
  --description "Login redirect issue" \
  --agent claude-code \
  --priority high \
  --working-dir /path/to/project

# Mark complete
bb task-complete \
  --task-id TASK-001 \
  --status completed \
  --summary "Fixed redirect logic in auth.js"
```

---

## Monitoring

### Check Status via API

```bash
# Get task status
curl http://localhost:8001/tasks/{task_id}

# List all active tasks
curl http://localhost:8001/tasks/active

# Get metrics
curl http://localhost:8001/metrics
```

### Open Dashboard

```bash
# Linux
xdg-open http://localhost:3000

# macOS
open http://localhost:3000

# Windows (WSL)
explorer.exe http://localhost:3000
```

---

## Troubleshooting Quick Fixes

### "bb not found"

```bash
export PATH="$PATH:/path/to/bloodbank"
```

### "RabbitMQ connection failed"

```bash
sudo systemctl start rabbitmq-server
```

### "Session not found"

```bash
# Check session manager is running
docker ps | grep task-session-manager

# Or restart it
docker-compose restart task-session-manager
```

### "Terminal didn't launch"

```bash
# Test bridge script manually
flume-obsidian-bridge.sh /path/to/TASK.md --agent claude-code
```

---

## File Locations

| Item | Path |
|------|------|
| Bridge Script | `~/.local/bin/flume-obsidian-bridge.sh` |
| QuickAdd Macros | `{vault}/Scripts/Flume/*.js` |
| TASK Template | `{vault}/Templates/TASK.md` |
| Active Tasks | `{vault}/Tasks/Active/` |
| Archived Tasks | `{vault}/Tasks/Archive/` |
| Config File | `~/.config/flume/config.yaml` |

---

## Task Frontmatter Cheat Sheet

### Required

```yaml
---
type: task
title: Brief task description
---
```

### Recommended

```yaml
---
type: task
title: Brief task description
agent_type: claude-code
priority: medium
working_dir: /path/to/project
---
```

### Complete

```yaml
---
type: task
task_id: task_1729593600_abc123
title: Brief task description
agent_type: claude-code
priority: high
status: assigned
working_dir: /path/to/project
created_at: 2025-10-22T10:00:00Z
assigned_at: 2025-10-22T10:05:00Z
event_id: evt_abc123
---
```

---

## Agent Types

| Agent | Binary | Best For |
|-------|--------|----------|
| `claude-code` | `claude` | General coding tasks, refactoring |
| `gemini-cli` | `gemini` | Research, analysis, documentation |
| `openai-cli` | `openai` | Code generation, debugging |
| `local-llm` | Custom | Privacy-sensitive tasks |

---

## Environment Variables

```bash
# In ~/.bashrc or ~/.zshrc
export FLUME_RABBITMQ_URL="amqp://localhost:5672/"
export FLUME_MONITOR_API_URL="http://localhost:8001"
export FLUME_DASHBOARD_URL="http://localhost:3000"
export FLUME_SESSION_MANAGER="zellij"
export FLUME_DEFAULT_AGENT="claude-code"
```

---

## Tips & Best Practices

1. **Always specify `working_dir`** - Ensures agent works in correct location
2. **Use descriptive titles** - Helps with tracking and searching
3. **Check progress regularly** - Catch issues early with `Ctrl+Shift+P`
4. **Archive completed tasks** - Keep vault organized
5. **Use priority levels** - Helps with task scheduling and planning
6. **Include acceptance criteria** - Makes completion checking easier
7. **Document blockers** - Update TASK.md with issues as they arise

---

## Support

- **Full Guide:** `docs/OBSIDIAN_INTEGRATION_GUIDE.md`
- **CLI Requirements:** `CLI_SHELL_INTEGRATION_REQUIREMENTS.md`
- **GitHub Issues:** [Report bugs]
- **Dashboard:** http://localhost:3000

---

**Version 1.0.0** | Last Updated: 2025-10-22

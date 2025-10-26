# Flume Obsidian Integration Guide

**Complete guide to integrating Flume Task Lifecycle System with Obsidian**

**Version:** 1.0.0
**Last Updated:** 2025-10-22

---

## Table of Contents

1. [Overview](#overview)
2. [Prerequisites](#prerequisites)
3. [Installation](#installation)
4. [QuickAdd Macro Setup](#quickadd-macro-setup)
5. [TASK.md Template](#taskmd-template)
6. [Workflow Guide](#workflow-guide)
7. [Troubleshooting](#troubleshooting)
8. [Advanced Configuration](#advanced-configuration)

---

## Overview

The Flume Obsidian integration enables seamless task management and AI agent orchestration directly from your Obsidian notes. It bridges the gap between your knowledge management system and the terminal-based AI agents (Claude Code, Gemini, etc.).

### Key Features

- **Task Assignment from Obsidian:** Create and assign tasks to AI agents without leaving your notes
- **Terminal Integration:** Automatically launch terminal sessions with agents attached
- **Real-time Progress Tracking:** Check task status and progress directly in Obsidian
- **Task Lifecycle Management:** Mark tasks complete, track durations, and archive completed work
- **Event-Driven Architecture:** All actions emit events to the monitoring system

### Architecture Flow

```
Obsidian Note (TASK.md)
    ↓
QuickAdd Macro
    ↓
flume-obsidian-bridge.sh
    ↓
RabbitMQ Event (task.lifecycle.assigned)
    ↓
Task Session Manager (Go)
    ↓
Terminal Session (Zellij/Tmux) + AI Agent
    ↓
Real-time Dashboard & Monitoring
```

---

## Prerequisites

### Required Software

1. **Obsidian:** Version 1.0.0 or higher
2. **QuickAdd Plugin:** Install from Community Plugins
3. **Node.js:** Version 18+ (required for script execution)
4. **Flume Components:**
   - Bloodbank CLI (`bb`) - for event publishing
   - Task Session Manager - for session orchestration
   - Task Monitor Service - for status queries
   - RabbitMQ - message broker

5. **Terminal Multiplexer:**
   - **Zellij** (recommended) or **Tmux**
   - Install via package manager: `brew install zellij` or `apt install zellij`

6. **AI Agent CLI:**
   - Claude Code (`claude`)
   - Gemini CLI (`gemini`)
   - Or other supported agents

### Verify Installation

```bash
# Check Bloodbank CLI
bb --version

# Check Zellij
zellij --version

# Check AI agent (Claude Code example)
claude --version

# Check RabbitMQ is running
curl http://localhost:15672  # Should show RabbitMQ management interface
```

---

## Installation

### Step 1: Install flume-obsidian-bridge.sh

Copy the bridge script to a location in your PATH:

```bash
# Option 1: User-local installation
cp flume-obsidian-bridge.sh ~/.local/bin/
chmod +x ~/.local/bin/flume-obsidian-bridge.sh

# Option 2: System-wide installation (requires sudo)
sudo cp flume-obsidian-bridge.sh /usr/local/bin/
sudo chmod +x /usr/local/bin/flume-obsidian-bridge.sh

# Option 3: Keep in project directory
# Update QuickAdd macros to use absolute path
```

Verify installation:

```bash
flume-obsidian-bridge.sh --help
```

### Step 2: Install QuickAdd Plugin in Obsidian

1. Open Obsidian Settings
2. Navigate to **Community Plugins**
3. Click **Browse** and search for "QuickAdd"
4. Click **Install**, then **Enable**

### Step 3: Copy QuickAdd Macro Scripts

Place the macro JavaScript files in your Obsidian vault (recommended location: `Scripts/` folder):

```bash
# Create Scripts folder in your vault
mkdir -p /path/to/your/vault/Scripts/Flume

# Copy macro scripts
cp obsidian-quickadd-open-task-in-terminal.js /path/to/your/vault/Scripts/Flume/
cp obsidian-quickadd-check-task-progress.js /path/to/your/vault/Scripts/Flume/
cp obsidian-quickadd-mark-task-complete.js /path/to/your/vault/Scripts/Flume/
```

### Step 4: Copy TASK.md Template

```bash
# Create Templates folder if it doesn't exist
mkdir -p /path/to/your/vault/Templates

# Copy template
cp templates/TASK.md.template /path/to/your/vault/Templates/TASK.md
```

---

## QuickAdd Macro Setup

### Macro 1: Open Task in Terminal

**Purpose:** Fire task assignment event and launch agent in terminal

1. Open **QuickAdd Settings** in Obsidian
2. Click **Manage Macros**
3. Click **New Macro** and name it "Open Task in Terminal"
4. Click **Configure** on the macro
5. Click **Add choice** → **User Script**
6. Select `Scripts/Flume/obsidian-quickadd-open-task-in-terminal.js`
7. Click **Add to QuickAdd**
8. Back in main QuickAdd settings, click **⚡** to assign a hotkey (e.g., `Ctrl+Shift+T`)

**Recommended Hotkey:** `Ctrl+Shift+T` (Cmd+Shift+T on macOS)

### Macro 2: Check Task Progress

**Purpose:** Query monitoring API and display task status

1. In **Manage Macros**, click **New Macro**
2. Name it "Check Task Progress"
3. Add User Script: `Scripts/Flume/obsidian-quickadd-check-task-progress.js`
4. Assign hotkey (e.g., `Ctrl+Shift+P`)

**Recommended Hotkey:** `Ctrl+Shift+P` (Cmd+Shift+P on macOS)

### Macro 3: Mark Task Complete

**Purpose:** Mark task as completed/failed and emit completion event

1. In **Manage Macros**, click **New Macro**
2. Name it "Mark Task Complete"
3. Add User Script: `Scripts/Flume/obsidian-quickadd-mark-task-complete.js`
4. Assign hotkey (e.g., `Ctrl+Shift+C`)

**Recommended Hotkey:** `Ctrl+Shift+C` (Cmd+Shift+C on macOS)

### Summary of Hotkeys

| Macro | Hotkey | Action |
|-------|--------|--------|
| Open Task in Terminal | `Ctrl+Shift+T` | Fire assignment, launch terminal |
| Check Task Progress | `Ctrl+Shift+P` | Query status, update note |
| Mark Task Complete | `Ctrl+Shift+C` | Emit completion, archive |

---

## TASK.md Template

### Creating a New Task

**Option 1: Use Template**

1. Create a new note in your vault
2. Use Obsidian's template insertion (Ctrl+T or Cmd+T)
3. Select `Templates/TASK.md`
4. Fill in the required fields

**Option 2: Manual Creation**

Create a note with the following frontmatter:

```yaml
---
type: task
task_id: TASK-001
title: Implement user authentication
agent_type: claude-code
priority: high
status: pending
working_dir: /path/to/project
created_at: 2025-10-22T10:00:00Z
---

# Task: Implement user authentication

## Objective
Add JWT-based authentication to the API

## Requirements
- [ ] Create authentication endpoints
- [ ] Implement JWT token generation
- [ ] Add middleware for protected routes
```

### Required Frontmatter Fields

| Field | Required | Description | Example |
|-------|----------|-------------|---------|
| `type` | Yes | Must be "task" | `task` |
| `task_id` | Auto-generated | Unique task identifier | `task_1729593600_abc123` |
| `title` | Yes | Brief task description | `Fix login bug` |
| `agent_type` | No | AI agent to use | `claude-code` (default) |
| `priority` | No | Task priority | `low`, `medium`, `high`, `critical` |
| `status` | Auto-set | Current status | `pending`, `assigned`, `completed` |
| `working_dir` | No | Project directory | `/home/user/projects/app` |

### Optional Frontmatter Fields

- `event_id` - Assigned when event is fired
- `assigned_at` - Timestamp of assignment
- `started_at` - When agent started working
- `completed_at` - Completion timestamp
- `agent_id` - Specific agent instance
- `duration_seconds` - Task duration
- `completion_summary` - Summary of work done

---

## Workflow Guide

### Standard Task Workflow

#### 1. Create Task

```markdown
---
type: task
title: Refactor database queries
agent_type: claude-code
priority: medium
working_dir: /home/user/projects/backend
---

# Task: Refactor database queries

## Objective
Optimize slow database queries in user service

## Requirements
- [ ] Identify slow queries
- [ ] Add proper indexes
- [ ] Implement query caching
```

#### 2. Open Task in Terminal

1. Open the TASK.md note in Obsidian
2. Press **Ctrl+Shift+T** (or your assigned hotkey)
3. **Agent Selection Dialog** appears (if not specified in frontmatter)
   - Select `claude-code`
4. **Priority Selection Dialog** appears (if not specified)
   - Select `medium`
5. **Confirmation Dialog** shows task summary
   - Review and click **Yes**

**What Happens Next:**

- Event `task.lifecycle.assigned` is published to RabbitMQ
- Task Session Manager creates a new Zellij/Tmux session
- Terminal window launches automatically
- Claude Code agent starts in the session with task context
- Frontmatter is updated with `task_id`, `event_id`, `assigned_at`

#### 3. Monitor Progress

While the agent is working:

1. Press **Ctrl+Shift+P** to check progress
2. View real-time status in the Obsidian notice:
   ```
   ⚙️ Task Status: IN_PROGRESS
   🤖 Agent: claude-code
   📊 Progress: 45%
   📝 Activity: Refactoring database queries
   ⏱️ Running for: 5m 23s
   💓 Last heartbeat: 15s ago
   ```

3. Frontmatter is automatically updated with latest status

#### 4. Review Agent's Work

Attach to the session manually if needed:

```bash
# Zellij
zellij attach flume-task_1729593600_abc123

# Tmux
tmux attach-session -t flume-task_1729593600_abc123
```

#### 5. Mark Task Complete

When satisfied with the work:

1. Press **Ctrl+Shift+C**
2. **Completion Summary Dialog** appears
   - Enter: "Optimized 5 slow queries, added indexes, implemented Redis caching"
3. **Completion Type Selection:**
   - Choose `✅ Completed Successfully`
4. **Confirmation Dialog**
   - Review and click **Yes**

**What Happens Next:**

- Event `task.lifecycle.completed` is published
- Frontmatter updated with completion metadata
- Completion summary appended to note
- Archive prompt appears (optional)
- Agent session cleaned up automatically

### Quick Task Workflow (Rapid Assignment)

For quick tasks without detailed planning:

1. Create minimal TASK.md:

```markdown
---
type: task
---

# Fix login redirect bug

User reports being redirected to wrong page after login.
Check authentication middleware and redirect logic.
```

2. Press **Ctrl+Shift+T**
3. Select agent and priority
4. Agent starts immediately

---

## Troubleshooting

### Common Issues

#### 1. "bb CLI not found"

**Problem:** Bridge script can't find Bloodbank CLI

**Solution:**

```bash
# Check if bb is in PATH
which bb

# If not, add to PATH
export PATH="$PATH:/path/to/bloodbank/installation"

# Or create symlink
sudo ln -s /path/to/bb /usr/local/bin/bb
```

#### 2. "Failed to publish task event"

**Problem:** RabbitMQ connection failed

**Solution:**

```bash
# Check RabbitMQ is running
sudo systemctl status rabbitmq-server

# Start if needed
sudo systemctl start rabbitmq-server

# Check connectivity
curl http://localhost:15672
```

#### 3. "Could not retrieve task status"

**Problem:** Task Monitor Service not responding

**Solution:**

```bash
# Check if monitor service is running
curl http://localhost:8001/health

# Start monitor service
cd task-monitor
python main.py

# Or with Docker
docker-compose up task-monitor
```

#### 4. Terminal doesn't launch

**Problem:** Terminal emulator not detected

**Solution:**

```bash
# Install terminal emulator (Linux)
sudo apt install gnome-terminal

# Or use Alacritty
sudo apt install alacritty

# macOS - install iTerm2
brew install --cask iterm2
```

#### 5. Session not found when attaching

**Problem:** Session Manager didn't create session

**Solution:**

```bash
# Check Session Manager logs
docker logs task-session-manager

# Manually list sessions
zellij list-sessions

# Check RabbitMQ queue
curl -u guest:guest http://localhost:15672/api/queues/%2F/task_lifecycle_queue
```

### Debug Mode

Enable verbose logging in bridge script:

```bash
# Edit flume-obsidian-bridge.sh
# Add at top of file:
set -x  # Enable debug output

# Run manually to see detailed logs
flume-obsidian-bridge.sh /path/to/TASK.md --agent claude-code --priority high
```

### Log Locations

- **Bridge Script Output:** Console/terminal where Obsidian was launched
- **Session Manager Logs:** `docker logs task-session-manager`
- **Monitor Service Logs:** `docker logs task-monitor`
- **RabbitMQ Logs:** `/var/log/rabbitmq/`
- **Agent Session Logs:** `/var/log/flume/sessions/{task_id}/session.log`

---

## Advanced Configuration

### Environment Variables

Set in `~/.bashrc`, `~/.zshrc`, or Obsidian's environment:

```bash
# RabbitMQ connection
export FLUME_RABBITMQ_URL="amqp://guest:guest@localhost:5672/"

# Task Monitor API
export FLUME_MONITOR_API_URL="http://localhost:8001"

# Task Dashboard
export FLUME_DASHBOARD_URL="http://localhost:3000"

# Session Manager
export FLUME_SESSION_MANAGER="zellij"  # or "tmux"

# Default agent
export FLUME_DEFAULT_AGENT="claude-code"
```

### Configuration File

Create `~/.config/flume/config.yaml`:

```yaml
# Flume Obsidian Integration Configuration

rabbitmq:
  url: "amqp://guest:guest@localhost:5672/"
  exchange: "task_events"

monitor:
  api_url: "http://localhost:8001"
  timeout_seconds: 5

dashboard:
  url: "http://localhost:3000"

session:
  manager: "zellij"  # or "tmux"
  default_agent: "claude-code"
  working_dir_base: "~/projects"

obsidian:
  vault_path: "~/Documents/Obsidian"
  templates_folder: "Templates"
  archive_folder: "Archive"
  scripts_folder: "Scripts/Flume"
```

### Custom Agent Configuration

Add custom agents in config:

```yaml
agents:
  custom-agent:
    binary: "my-agent"
    context_flag: "--task"
    supports_markdown: true
    default_args: ["--verbose", "--interactive"]
```

### QuickAdd Macro Customization

Edit macro scripts to change behavior:

**Example: Auto-select agent based on project**

```javascript
// In obsidian-quickadd-open-task-in-terminal.js
// Around line 50, replace agent selection with:

let agentType;
const projectPath = frontmatterData.working_dir || activeFile.parent.path;

if (projectPath.includes('python')) {
  agentType = 'claude-code';
} else if (projectPath.includes('javascript')) {
  agentType = 'gemini-cli';
} else {
  // Show selection dialog
  agentType = await QuickAdd.suggester(...);
}
```

### Terminal Emulator Preferences

Customize terminal detection order in `flume-obsidian-bridge.sh`:

```bash
# Around line 300, modify detect_terminal function:
detect_terminal() {
    local platform="$1"

    case "$platform" in
        linux)
            # Change order to prefer alacritty
            for term in alacritty kitty gnome-terminal konsole xterm; do
                if command -v "$term" &> /dev/null; then
                    echo "$term"
                    return
                fi
            done
            ;;
    esac
}
```

---

## Best Practices

### Task Organization

**Folder Structure:**

```
Obsidian Vault/
├── Tasks/
│   ├── Active/
│   │   ├── TASK-001_auth-implementation.md
│   │   └── TASK-002_database-migration.md
│   ├── Backlog/
│   │   └── future-tasks.md
│   └── Archive/
│       ├── Completed Tasks/
│       │   └── 2025-10-22_TASK-001.md
│       └── Failed Tasks/
│           └── 2025-10-21_TASK-003.md
├── Templates/
│   └── TASK.md
└── Scripts/
    └── Flume/
        ├── obsidian-quickadd-open-task-in-terminal.js
        ├── obsidian-quickadd-check-task-progress.js
        └── obsidian-quickadd-mark-task-complete.js
```

### Task Naming Convention

- **Format:** `TASK-{ID}_{brief-description}.md`
- **Example:** `TASK-001_implement-auth.md`
- Use meaningful descriptions
- Keep filenames short (< 50 chars)

### Frontmatter Hygiene

Always include:
- `type: task`
- `title` (descriptive)
- `working_dir` (absolute path)
- `priority` (helps with scheduling)

### Progress Tracking

Check progress regularly:
- Active tasks: Every 30 minutes
- Long-running tasks: Every hour
- Critical tasks: Every 15 minutes

### Session Management

Clean up completed sessions:

```bash
# List all flume sessions
zellij list-sessions | grep flume

# Kill completed sessions manually if needed
zellij kill-session flume-task_123456
```

---

## Integration with Other Tools

### Git Integration

Tasks can trigger git operations:

```markdown
---
type: task
git_branch: feature/new-auth
git_auto_commit: true
---
```

### Trello/Jira Sync

Link tasks to external project management:

```markdown
---
type: task
trello_card: https://trello.com/c/abc123
jira_ticket: PROJ-123
---
```

### Slack Notifications

Get notified on task completion:

```bash
# In completion event handler
curl -X POST https://hooks.slack.com/services/YOUR/WEBHOOK/URL \
  -d '{"text": "Task TASK-001 completed!"}'
```

---

## Security Considerations

### Sensitive Information

**Never include in TASK.md:**
- API keys or credentials
- Passwords or tokens
- Private URLs or endpoints

**Use environment variables instead:**

```markdown
## Context

Database: Use credentials from $DB_CREDENTIALS_FILE
API Key: Stored in ~/.config/app/api_key
```

### File Permissions

Ensure proper permissions:

```bash
# Bridge script should be executable but not writable by others
chmod 755 flume-obsidian-bridge.sh

# TASK.md files should be private
chmod 600 ~/Documents/Obsidian/Tasks/**/*.md
```

### Network Security

- Use TLS for RabbitMQ connections in production
- Restrict monitoring API to localhost or VPN
- Use authentication for dashboard access

---

## FAQ

**Q: Can I use multiple agents on the same task?**

A: Not simultaneously, but you can reassign a task to a different agent by updating the frontmatter and running "Open Task in Terminal" again.

**Q: What happens if my computer restarts?**

A: Sessions are not automatically restored. Check the monitoring dashboard to see which tasks were interrupted, then manually recreate sessions or reassign tasks.

**Q: Can I run this on Windows?**

A: Yes, with WSL (Windows Subsystem for Linux). Install Obsidian on Windows, and ensure the bridge script runs in WSL with proper path mapping.

**Q: How do I share tasks with team members?**

A: Share the TASK.md files via git or Obsidian Sync. Each team member can assign tasks to their local agents independently.

**Q: Can I customize the event schema?**

A: Yes, but you'll need to update the Python event schemas, Go session manager, and monitoring service to match. See the main Flume documentation.

---

## Support and Resources

### Documentation

- [Main Flume Documentation](../README.md)
- [CLI Shell Integration Requirements](../CLI_SHELL_INTEGRATION_REQUIREMENTS.md)
- [Implementation Report](../IMPLEMENTATION_REPORT.md)
- [QuickAdd Plugin Documentation](https://github.com/chhoumann/quickadd)

### Community

- GitHub Issues: [Report bugs or request features]
- Discord: [Community discussion]
- Documentation Wiki: [Extended guides and examples]

### Getting Help

1. Check this guide's [Troubleshooting](#troubleshooting) section
2. Review logs for error messages
3. Search GitHub issues for similar problems
4. Create a new issue with reproduction steps

---

## Changelog

### Version 1.0.0 (2025-10-22)

- Initial release
- Three QuickAdd macros (Open, Check Progress, Mark Complete)
- Bridge script with platform detection
- TASK.md template with comprehensive fields
- Full integration with Flume Task Lifecycle System

---

**End of Obsidian Integration Guide**

For questions or contributions, please refer to the main project repository.

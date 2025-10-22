# QuickAdd Task Assignment Macros - Setup Guide

## Overview

Two production-ready QuickAdd macros for firing task assignment events from Obsidian to the bloodbank CLI system.

## Files

1. **obsidian-quickadd-assign-task.js** - Full-featured task assignment with agent/priority selection
2. **obsidian-quickadd-quick-task-fire.js** - Rapid task dispatch using TASK.md from project folder

## Installation

### Prerequisites

- Obsidian installed
- QuickAdd plugin installed and enabled
- bloodbank CLI (`bb`) installed and available in PATH

### Step 1: Add Macro Scripts to Obsidian

1. Copy both JavaScript files to your Obsidian vault (recommended: `.obsidian/scripts/` folder)
2. Open Obsidian Settings → QuickAdd

### Step 2: Configure "Assign Task to Agent" Macro

1. Click "Manage Macros"
2. Create new macro: "Assign Task to Agent"
3. Click "Configure" on the new macro
4. Add "User Script" step
5. Select `obsidian-quickadd-assign-task.js`
6. Save the macro
7. Go back to main QuickAdd settings
8. Add new "Macro" choice
9. Select "Assign Task to Agent"
10. Enable it (toggle on)
11. (Optional) Assign hotkey: Click lightning bolt icon → set hotkey (e.g., `Ctrl+Shift+A`)

### Step 3: Configure "Quick Task Fire" Macro

1. Click "Manage Macros"
2. Create new macro: "Quick Task Fire"
3. Click "Configure" on the new macro
4. Add "User Script" step
5. Select `obsidian-quickadd-quick-task-fire.js`
6. Save the macro
7. Go back to main QuickAdd settings
8. Add new "Macro" choice
9. Select "Quick Task Fire"
10. Enable it (toggle on)
11. (Optional) Assign hotkey: Click lightning bolt icon → set hotkey (e.g., `Ctrl+Shift+F`)

## Usage

### Macro 1: Assign Task to Agent

**Use Case:** Assign a detailed task note to an agent with custom settings

**Steps:**

1. Open a note with task details
2. Ensure note has frontmatter (or macro will create it):
   ```yaml
   ---
   task_id: task_12345
   title: Implement user authentication
   ---
   ```
3. Write task description in note body
4. Run macro (via command palette or hotkey)
5. Select agent from menu (claude-code, gemini-cli, etc.)
6. Select priority (low, medium, high, critical)
7. Confirm task assignment
8. ✅ Note frontmatter updated with `event_id`, `assigned_to`, `assigned_at`, `status`

**Example Note Before:**
```markdown
---
title: Fix login bug
---

The login form is not validating email addresses correctly.
Users can submit invalid emails and cause database errors.

Steps to reproduce:
1. Navigate to /login
2. Enter "notanemail" in email field
3. Submit form
```

**Example Note After:**
```markdown
---
title: Fix login bug
task_id: task_1729612345678
event_id: evt_1729612345789
assigned_to: claude-code
priority: high
assigned_at: 2025-10-22T14:32:15.678Z
status: assigned
---

The login form is not validating email addresses correctly.
Users can submit invalid emails and cause database errors.

Steps to reproduce:
1. Navigate to /login
2. Enter "notanemail" in email field
3. Submit form
```

### Macro 2: Quick Task Fire

**Use Case:** Rapidly fire tasks from project folders with TASK.md

**Steps:**

1. Create `TASK.md` in your project folder:
   ```markdown
   # Refactor Authentication Module

   ## Objective
   Modernize the auth system to use async/await patterns

   ## Requirements
   - Replace callback-based auth with promises
   - Add proper error boundaries
   - Update all 15 consumer files

   ## Context
   Current auth.js uses legacy callback patterns causing race conditions
   ```

2. Open any note in that project folder
3. Run "Quick Task Fire" macro
4. Enter task title when prompted
5. Confirm task details
6. ✅ Task fired with default settings (claude-code agent, medium priority)
7. ✅ Tracking note created automatically in same folder

**Generated Tracking Note:**
```markdown
---
task_id: task_1729612456789
event_id: evt_1729612456890
title: Refactor auth module
assigned_to: claude-code
priority: medium
status: assigned
assigned_at: 2025-10-22T14:35:56.789Z
project_path: projects/myapp/auth
type: task-tracking
---

# Refactor auth module

**Status:** 🟡 Assigned
**Agent:** claude-code
**Priority:** medium
**Event ID:** `evt_1729612456890`
**Task ID:** `task_1729612456789`

---

## Task Description

[Full TASK.md content inserted here]

---

## Timeline

- **2025-10-22T14:35:56.789Z** - Task assigned to claude-code

## Commands

```bash
# Check task status
bb task-status --event-id evt_1729612456890

# Cancel task
bb task-cancel --event-id evt_1729612456890
```
```

## CLI Command Format

Both macros execute commands in this format:

```bash
bb task-assign \
  --task-id 'task_1729612345678' \
  --title 'Fix authentication bug' \
  --description 'The login form validation...' \
  --agent 'claude-code' \
  --priority 'high' \
  --project-path 'projects/myapp/auth'
```

## Customization

### Change Default Agent (Quick Task Fire)

Edit `obsidian-quickadd-quick-task-fire.js` line ~75:

```javascript
const agent = "gemini-cli"; // Change from "claude-code"
```

### Change Default Priority

Edit `obsidian-quickadd-quick-task-fire.js` line ~76:

```javascript
const priority = "high"; // Change from "medium"
```

### Add More Agent Types

Edit `obsidian-quickadd-assign-task.js` line ~50:

```javascript
const agents = [
  "claude-code",
  "gemini-cli",
  "my-custom-agent", // Add your agent here
  // ...
];
```

### Modify TASK.md Template

Edit `createTaskMdTemplate()` function in `obsidian-quickadd-quick-task-fire.js` (line ~140)

## Troubleshooting

### "No active note found"
- Ensure you have a note open and in focus
- The macro needs an active file to determine project context

### "TASK.md not found"
- Quick Task Fire looks for TASK.md in the same folder as your active note
- Use the offered prompt to create a TASK.md template
- Or manually create TASK.md in your project folder

### "Task assignment failed"
- Check that `bb` CLI is installed: Run `bb --version` in terminal
- Verify bloodbank CLI is in your PATH
- Check Obsidian's Developer Console (Ctrl+Shift+I) for error details

### Shell execution errors
- Ensure Node.js `child_process` module is available (should be built-in)
- On Windows, you may need to adjust command formatting for PowerShell/CMD

### Event ID not extracted
- Macros expect `bb task-assign` to output event_id in JSON or text format
- Check CLI output format and adjust `extractEventId()` function if needed

## Project Structure Example

```
MyVault/
├── .obsidian/
│   └── scripts/
│       ├── obsidian-quickadd-assign-task.js
│       └── obsidian-quickadd-quick-task-fire.js
├── projects/
│   ├── auth-system/
│   │   ├── TASK.md                    ← Task description
│   │   ├── notes.md
│   │   └── task_123_refactor.md       ← Generated tracking note
│   └── api-integration/
│       ├── TASK.md
│       └── implementation-plan.md
```

## Features

### Macro 1: Assign Task to Agent

- ✅ Frontmatter parsing and updating
- ✅ Agent selection menu (6 default agents)
- ✅ Priority selection menu (4 levels)
- ✅ Confirmation dialog with preview
- ✅ Shell-safe string escaping
- ✅ Event ID extraction from CLI output
- ✅ Automatic timestamp generation
- ✅ Status tracking in frontmatter
- ✅ Error handling with user notifications

### Macro 2: Quick Task Fire

- ✅ Auto-detection of project context
- ✅ TASK.md reading from current folder
- ✅ Automatic task_id generation
- ✅ TASK.md template creation helper
- ✅ Tracking note generation
- ✅ Default agent/priority settings
- ✅ File path sanitization
- ✅ Auto-open generated tracking note
- ✅ Embedded CLI commands for task management

## Next Steps

1. Test both macros with sample notes
2. Customize agent types and defaults to match your setup
3. Create TASK.md templates in your project folders
4. Bind hotkeys for quick access
5. Integrate with your existing bloodbank CLI workflow

## Support

Check these if issues occur:
- Obsidian Developer Console: `Ctrl+Shift+I` or `Cmd+Option+I`
- QuickAdd plugin GitHub: https://github.com/chhoumann/quickadd
- bloodbank CLI documentation: Check your CLI docs for output format

---

**Ready to use!** Both macros are production-ready with comprehensive error handling and user feedback.

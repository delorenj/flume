/**
 * QuickAdd Macro: Quick Task Fire
 *
 * Rapid task creation and assignment from current project context.
 * Reads TASK.md from current folder and fires task with minimal input.
 *
 * Usage: Add as a QuickAdd Macro and bind to hotkey for quick task dispatch
 */

module.exports = async (params) => {
  const { quickAddApi: QuickAdd, app, obsidian } = params;

  try {
    // Get the active file to determine project context
    const activeFile = app.workspace.getActiveFile();
    if (!activeFile) {
      new obsidian.Notice("❌ No active note found");
      return;
    }

    // Get current folder
    const currentFolder = activeFile.parent;
    const projectPath = currentFolder.path;

    // Look for TASK.md in current folder
    const taskMdPath = `${projectPath}/TASK.md`;
    const taskMdFile = app.vault.getAbstractFileByPath(taskMdPath);

    if (!taskMdFile) {
      new obsidian.Notice(`❌ TASK.md not found in ${projectPath}`);

      // Offer to create TASK.md
      const createTaskMd = await QuickAdd.yesNoPrompt(
        "TASK.md not found",
        "Would you like to create a TASK.md template in this folder?"
      );

      if (createTaskMd) {
        await createTaskMdTemplate(app, currentFolder);
        new obsidian.Notice("✅ TASK.md created. Please edit it and run this macro again.");
      }
      return;
    }

    // Read TASK.md content as description
    const taskDescription = await app.vault.read(taskMdFile);

    if (!taskDescription.trim()) {
      new obsidian.Notice("❌ TASK.md is empty. Please add task description.");
      return;
    }

    // Prompt for task title
    const taskTitle = await QuickAdd.inputPrompt("Task Title", "Enter a brief task title:");

    if (!taskTitle) {
      new obsidian.Notice("❌ Task title required");
      return;
    }

    // Generate task_id
    const taskId = `task_${Date.now()}`;

    // Default settings
    const agent = "claude-code";
    const priority = "medium";

    // Show confirmation with preview
    const confirm = await QuickAdd.yesNoPrompt(
      `Fire task "${taskTitle}"?`,
      `Agent: ${agent}\nPriority: ${priority}\nProject: ${projectPath}\n\nDescription preview:\n${taskDescription.substring(0, 200)}...`
    );

    if (!confirm) {
      new obsidian.Notice("❌ Task cancelled");
      return;
    }

    // Build CLI command
    const command = buildTaskAssignCommand({
      taskId,
      title: taskTitle,
      description: taskDescription,
      agent,
      priority,
      projectPath
    });

    new obsidian.Notice("🚀 Firing task...");

    // Execute bb CLI command
    const result = await executeCommand(command);

    if (result.error) {
      new obsidian.Notice(`❌ Task fire failed: ${result.error}`);
      console.error("Task fire error:", result.error);
      return;
    }

    // Parse event_id from output
    const eventId = extractEventId(result.stdout) || `evt_${Date.now()}`;
    const timestamp = new Date().toISOString();

    // Create tracking note
    const trackingNoteName = `${taskId}_${sanitizeFilename(taskTitle)}`;
    const trackingNotePath = `${projectPath}/${trackingNoteName}.md`;

    const trackingNoteContent = buildTrackingNote({
      taskId,
      eventId,
      title: taskTitle,
      description: taskDescription,
      agent,
      priority,
      projectPath,
      timestamp
    });

    // Create the tracking note
    await app.vault.create(trackingNotePath, trackingNoteContent);

    // Open the new tracking note
    const newFile = app.vault.getAbstractFileByPath(trackingNotePath);
    await app.workspace.getLeaf().openFile(newFile);

    new obsidian.Notice(`✅ Task fired! Event: ${eventId}`);

  } catch (error) {
    new obsidian.Notice(`❌ Error: ${error.message}`);
    console.error("Quick task fire macro error:", error);
  }
};

/**
 * Create TASK.md template
 */
async function createTaskMdTemplate(app, folder) {
  const template = `# Task Description

## Objective
[Describe the main goal of this task]

## Requirements
- [ ] Requirement 1
- [ ] Requirement 2
- [ ] Requirement 3

## Context
[Provide relevant context, constraints, or background information]

## Acceptance Criteria
- [ ] Criterion 1
- [ ] Criterion 2

## Notes
[Any additional notes or considerations]
`;

  const taskMdPath = `${folder.path}/TASK.md`;
  await app.vault.create(taskMdPath, template);

  // Open the newly created TASK.md
  const newFile = app.vault.getAbstractFileByPath(taskMdPath);
  await app.workspace.getLeaf().openFile(newFile);
}

/**
 * Build tracking note content
 */
function buildTrackingNote({ taskId, eventId, title, description, agent, priority, projectPath, timestamp }) {
  return `---
task_id: ${taskId}
event_id: ${eventId}
title: ${title}
assigned_to: ${agent}
priority: ${priority}
status: assigned
assigned_at: ${timestamp}
project_path: ${projectPath}
type: task-tracking
---

# ${title}

**Status:** 🟡 Assigned
**Agent:** ${agent}
**Priority:** ${priority}
**Event ID:** \`${eventId}\`
**Task ID:** \`${taskId}\`

---

## Task Description

${description}

---

## Timeline

- **${timestamp}** - Task assigned to ${agent}

## Notes

[Add execution notes, updates, or observations here]

## Results

[Agent will update this section with results]

---

## Commands

\`\`\`bash
# Check task status
bb task-status --event-id ${eventId}

# Cancel task
bb task-cancel --event-id ${eventId}

# View logs
bb task-logs --event-id ${eventId}
\`\`\`
`;
}

/**
 * Build bb task-assign command
 */
function buildTaskAssignCommand({ taskId, title, description, agent, priority, projectPath }) {
  const escapeShell = (str) => {
    return str.replace(/'/g, "'\\''");
  };

  return `bb task-assign \
    --task-id '${escapeShell(taskId)}' \
    --title '${escapeShell(title)}' \
    --description '${escapeShell(description)}' \
    --agent '${escapeShell(agent)}' \
    --priority '${escapeShell(priority)}' \
    --project-path '${escapeShell(projectPath)}'`;
}

/**
 * Execute shell command
 */
async function executeCommand(command) {
  return new Promise((resolve) => {
    try {
      const { exec } = require('child_process');

      exec(command, { maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
          resolve({ error: error.message, stdout: '', stderr });
        } else {
          resolve({ stdout, stderr, error: null });
        }
      });
    } catch (err) {
      resolve({ error: err.message, stdout: '', stderr: '' });
    }
  });
}

/**
 * Extract event_id from CLI output
 */
function extractEventId(output) {
  try {
    const json = JSON.parse(output);
    return json.event_id || json.eventId || json.id;
  } catch (e) {
    const match = output.match(/event[_-]?id[:\s]+([a-zA-Z0-9_-]+)/i);
    return match ? match[1] : null;
  }
}

/**
 * Sanitize filename
 */
function sanitizeFilename(str) {
  return str
    .replace(/[^a-z0-9]/gi, '_')
    .replace(/_+/g, '_')
    .toLowerCase()
    .substring(0, 50);
}

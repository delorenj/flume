/**
 * QuickAdd Macro: Mark Task Complete
 *
 * Marks a task as completed, updates frontmatter, emits completion event,
 * and optionally archives the task note.
 *
 * Features:
 * - Completion confirmation with summary input
 * - Emit task.lifecycle.completed event
 * - Update note with completion metadata
 * - Optional task archiving
 * - Session cleanup notification
 *
 * Usage: Add as a QuickAdd Macro and bind to hotkey
 */

module.exports = async (params) => {
  const { quickAddApi: QuickAdd, app, obsidian } = params;

  try {
    // Get the active file
    const activeFile = app.workspace.getActiveFile();
    if (!activeFile) {
      new obsidian.Notice("❌ No active note found");
      return;
    }

    // Read file content and parse frontmatter
    const fileContent = await app.vault.read(activeFile);
    const frontmatterData = parseFrontmatter(fileContent);

    // Check if this is a task note
    const taskId = frontmatterData.task_id || frontmatterData.taskId;
    const eventId = frontmatterData.event_id || frontmatterData.eventId;

    if (!taskId) {
      new obsidian.Notice("❌ No task_id found in frontmatter");
      return;
    }

    // Check current status
    const currentStatus = frontmatterData.status;

    if (currentStatus === "completed") {
      new obsidian.Notice("✅ Task is already marked as completed");
      return;
    }

    // Ask for completion summary
    const summary = await QuickAdd.inputPrompt(
      "Task Completion Summary",
      "Provide a brief summary of what was accomplished:",
      ""
    );

    // Ask if task was successful or failed
    const completionType = await QuickAdd.suggester(
      ["✅ Completed Successfully", "❌ Failed", "⏸️ Paused/Cancelled"],
      ["completed", "failed", "paused"]
    );

    if (!completionType) {
      new obsidian.Notice("❌ Operation cancelled");
      return;
    }

    let errorDetails = null;

    // If failed, ask for error details
    if (completionType === "failed") {
      errorDetails = await QuickAdd.inputPrompt(
        "Failure Details",
        "What went wrong?",
        ""
      );
    }

    // Confirmation
    const statusText = completionType === "completed" ? "complete" :
                       completionType === "failed" ? "failed" :
                       "paused";

    const confirm = await QuickAdd.yesNoPrompt(
      `Mark task as ${statusText}?`,
      `Task: ${taskId}\nStatus: ${statusText}\n${summary ? `Summary: ${summary}` : ''}\n\nThis will:\n• Update task status\n• Emit ${completionType} event\n• Update note metadata`
    );

    if (!confirm) {
      new obsidian.Notice("❌ Operation cancelled");
      return;
    }

    new obsidian.Notice(`📝 Marking task as ${statusText}...`);

    // Emit completion event
    const emitResult = await emitCompletionEvent({
      taskId,
      eventId,
      status: completionType,
      summary,
      errorDetails,
      workingDir: frontmatterData.working_dir || frontmatterData.project_path
    });

    if (!emitResult.success) {
      new obsidian.Notice(`⚠️ Warning: Could not emit event - ${emitResult.error}`);
      // Continue anyway to update the note
    }

    // Update frontmatter
    const timestamp = new Date().toISOString();
    const updatedFrontmatter = {
      ...frontmatterData,
      status: completionType,
      completed_at: timestamp,
      completion_summary: summary || "No summary provided"
    };

    if (errorDetails) {
      updatedFrontmatter.error_message = errorDetails;
    }

    // Calculate duration if possible
    if (frontmatterData.started_at || frontmatterData.assigned_at) {
      const startTime = new Date(frontmatterData.started_at || frontmatterData.assigned_at);
      const endTime = new Date(timestamp);
      const durationSeconds = Math.floor((endTime - startTime) / 1000);
      updatedFrontmatter.duration_seconds = durationSeconds;
      updatedFrontmatter.duration_formatted = formatDuration(durationSeconds);
    }

    // Build updated content
    const bodyContent = extractBody(fileContent);
    const completionNote = buildCompletionNote(completionType, summary, errorDetails, timestamp);
    const updatedBody = `${bodyContent}\n\n${completionNote}`;
    const updatedContent = buildFileWithFrontmatter(updatedFrontmatter, updatedBody);

    // Update file
    await app.vault.modify(activeFile, updatedContent);

    // Success notification
    const statusEmoji = completionType === "completed" ? "✅" :
                        completionType === "failed" ? "❌" : "⏸️";

    new obsidian.Notice(`${statusEmoji} Task marked as ${statusText}!`);

    // Ask about archiving
    if (completionType === "completed" || completionType === "failed") {
      const shouldArchive = await QuickAdd.yesNoPrompt(
        "Archive task?",
        `Would you like to move this task note to the archive folder?`
      );

      if (shouldArchive) {
        await archiveTaskNote(app, activeFile, completionType);
      }
    }

    // Notify about session cleanup
    if (emitResult.success) {
      new obsidian.Notice("💡 Agent session will be cleaned up automatically", 5000);
    }

  } catch (error) {
    new obsidian.Notice(`❌ Error: ${error.message}`);
    console.error("Mark task complete macro error:", error);
  }
};

/**
 * Parse YAML frontmatter into object
 */
function parseFrontmatter(content) {
  const frontmatterRegex = /^---\n([\s\S]*?)\n---/;
  const match = content.match(frontmatterRegex);

  if (!match) {
    return {};
  }

  const frontmatterText = match[1];
  const lines = frontmatterText.split('\n');
  const result = {};

  for (const line of lines) {
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;

    const key = line.substring(0, colonIndex).trim();
    let value = line.substring(colonIndex + 1).trim();

    // Remove quotes
    value = value.replace(/^["']|["']$/g, '');

    result[key] = value;
  }

  return result;
}

/**
 * Extract body content (everything after frontmatter)
 */
function extractBody(content) {
  const frontmatterRegex = /^---\n[\s\S]*?\n---\n*/;
  return content.replace(frontmatterRegex, '');
}

/**
 * Build file content with updated frontmatter
 */
function buildFileWithFrontmatter(frontmatter, body) {
  const fmLines = Object.entries(frontmatter).map(([key, value]) => {
    // Quote string values if they contain special characters
    const needsQuotes = typeof value === 'string' && /[:#\[\]{}|>]/.test(value);
    const formattedValue = needsQuotes ? `"${value}"` : value;
    return `${key}: ${formattedValue}`;
  });

  return `---\n${fmLines.join('\n')}\n---\n\n${body}`;
}

/**
 * Build completion note to append to task
 */
function buildCompletionNote(status, summary, errorDetails, timestamp) {
  const statusEmoji = status === "completed" ? "✅" : status === "failed" ? "❌" : "⏸️";
  const statusText = status.toUpperCase();

  let note = `\n---\n\n## ${statusEmoji} Task ${statusText}\n\n`;
  note += `**Completed At:** ${new Date(timestamp).toLocaleString()}\n\n`;

  if (summary) {
    note += `### Summary\n\n${summary}\n\n`;
  }

  if (errorDetails) {
    note += `### Error Details\n\n${errorDetails}\n\n`;
  }

  return note;
}

/**
 * Emit completion event via bb CLI
 */
async function emitCompletionEvent({ taskId, eventId, status, summary, errorDetails, workingDir }) {
  try {
    // Check if bb CLI is available
    const { exec } = require('child_process');

    // Build command to emit completion event
    const escapeShell = (str) => {
      return str ? str.replace(/'/g, "'\\''") : '';
    };

    let command = `bb task-complete --task-id '${escapeShell(taskId)}'`;

    if (eventId) {
      command += ` --event-id '${escapeShell(eventId)}'`;
    }

    command += ` --status '${status}'`;

    if (summary) {
      command += ` --summary '${escapeShell(summary)}'`;
    }

    if (errorDetails) {
      command += ` --error '${escapeShell(errorDetails)}'`;
    }

    if (workingDir) {
      command += ` --working-dir '${escapeShell(workingDir)}'`;
    }

    return new Promise((resolve) => {
      exec(command, { timeout: 5000 }, (error, stdout, stderr) => {
        if (error) {
          console.error("Failed to emit completion event:", error);
          resolve({ success: false, error: error.message });
        } else {
          console.log("Completion event emitted:", stdout);
          resolve({ success: true, output: stdout });
        }
      });
    });

  } catch (error) {
    console.error("Error emitting completion event:", error);
    return { success: false, error: error.message };
  }
}

/**
 * Format duration in seconds to human-readable string
 */
function formatDuration(seconds) {
  if (seconds < 60) {
    return `${seconds}s`;
  } else if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${minutes}m ${secs}s`;
  } else {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${hours}h ${minutes}m`;
  }
}

/**
 * Archive task note to archive folder
 */
async function archiveTaskNote(app, file, status) {
  try {
    // Determine archive folder based on status
    const archiveFolder = status === "completed" ? "Archive/Completed Tasks" : "Archive/Failed Tasks";

    // Create archive folder if it doesn't exist
    const folderExists = app.vault.getAbstractFileByPath(archiveFolder);
    if (!folderExists) {
      await app.vault.createFolder(archiveFolder);
    }

    // Generate new path
    const timestamp = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const newPath = `${archiveFolder}/${timestamp}_${file.name}`;

    // Move file
    await app.fileManager.renameFile(file, newPath);

    new obsidian.Notice(`📦 Task archived to ${archiveFolder}`);

  } catch (error) {
    console.error("Archive error:", error);
    new obsidian.Notice(`⚠️ Could not archive task: ${error.message}`);
  }
}

/**
 * QuickAdd Macro: Check Task Progress
 *
 * Queries the task monitoring API for current task status and displays
 * progress information in Obsidian notice and updates the note.
 *
 * Features:
 * - Query monitoring API for task status
 * - Display progress percentage and current activity
 * - Show last heartbeat and duration
 * - Update note with latest status
 * - Option to open dashboard in browser
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

    // Extract task_id or event_id
    const taskId = frontmatterData.task_id || frontmatterData.taskId;
    const eventId = frontmatterData.event_id || frontmatterData.eventId;

    if (!taskId && !eventId) {
      new obsidian.Notice("❌ No task_id or event_id found in frontmatter");

      const openDashboard = await QuickAdd.yesNoPrompt(
        "No task information",
        "This note doesn't have task tracking information. Open task dashboard to view all tasks?"
      );

      if (openDashboard) {
        openTaskDashboard();
      }
      return;
    }

    new obsidian.Notice("🔍 Checking task progress...");

    // Query monitoring API
    const taskStatus = await queryTaskStatus(taskId, eventId);

    if (!taskStatus) {
      new obsidian.Notice("❌ Could not retrieve task status");
      return;
    }

    // Display progress information
    displayTaskProgress(taskStatus, obsidian);

    // Update frontmatter with latest status
    await updateTaskStatus(app, activeFile, frontmatterData, taskStatus);

    // Ask if user wants to open dashboard
    if (taskStatus.status === "in_progress" || taskStatus.status === "started") {
      const shouldOpenDashboard = await QuickAdd.yesNoPrompt(
        "Task is active",
        "Task is currently running. Open dashboard for real-time monitoring?"
      );

      if (shouldOpenDashboard) {
        openTaskDashboard(taskId);
      }
    }

  } catch (error) {
    new obsidian.Notice(`❌ Error: ${error.message}`);
    console.error("Check task progress macro error:", error);
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
 * Query task monitoring API
 */
async function queryTaskStatus(taskId, eventId) {
  const monitoringApiUrl = getMonitoringApiUrl();

  try {
    // Try to use Node's https module if available
    const https = require('https');
    const http = require('http');

    const url = new URL(`${monitoringApiUrl}/tasks/${taskId}`);
    const protocol = url.protocol === 'https:' ? https : http;

    return new Promise((resolve, reject) => {
      const req = protocol.get(url, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const taskData = JSON.parse(data);
              resolve(taskData);
            } catch (e) {
              console.error("Failed to parse API response:", e);
              resolve(null);
            }
          } else if (res.statusCode === 404) {
            console.warn("Task not found in monitoring system");
            resolve(null);
          } else {
            console.error("API request failed:", res.statusCode);
            resolve(null);
          }
        });
      });

      req.on('error', (err) => {
        console.error("API request error:", err);
        resolve(null);
      });

      req.setTimeout(5000, () => {
        req.destroy();
        resolve(null);
      });
    });

  } catch (error) {
    console.error("Query task status error:", error);
    return null;
  }
}

/**
 * Get monitoring API URL from environment or config
 */
function getMonitoringApiUrl() {
  // Default to localhost
  return process.env.FLUME_MONITOR_API_URL || "http://localhost:8001";
}

/**
 * Display task progress in Obsidian notice
 */
function displayTaskProgress(taskStatus, obsidian) {
  const statusEmojis = {
    pending: "⏳",
    assigned: "📋",
    started: "▶️",
    in_progress: "⚙️",
    paused: "⏸️",
    completed: "✅",
    failed: "❌",
    stale: "⚠️"
  };

  const emoji = statusEmojis[taskStatus.status] || "❓";
  const status = taskStatus.status.toUpperCase();

  // Build progress message
  let message = `${emoji} Task Status: ${status}\n`;

  if (taskStatus.agent_id) {
    message += `🤖 Agent: ${taskStatus.agent_id}\n`;
  }

  // Add progress information for in-progress tasks
  if (taskStatus.status === "in_progress" && taskStatus.events) {
    const progressEvents = taskStatus.events.filter(e => e.event_type === "in_progress");
    if (progressEvents.length > 0) {
      const latest = progressEvents[progressEvents.length - 1];

      if (latest.data && latest.data.progress_percentage !== undefined) {
        message += `📊 Progress: ${latest.data.progress_percentage}%\n`;
      }

      if (latest.data && latest.data.current_activity) {
        message += `📝 Activity: ${latest.data.current_activity}\n`;
      }
    }
  }

  // Add timing information
  if (taskStatus.started_at) {
    const startedAt = new Date(taskStatus.started_at);
    const elapsed = Math.floor((Date.now() - startedAt.getTime()) / 1000);
    message += `⏱️ Running for: ${formatDuration(elapsed)}\n`;
  }

  if (taskStatus.last_heartbeat) {
    const lastHeartbeat = new Date(taskStatus.last_heartbeat);
    const timeSince = Math.floor((Date.now() - lastHeartbeat.getTime()) / 1000);
    message += `💓 Last heartbeat: ${timeSince}s ago\n`;
  }

  // Add completion information
  if (taskStatus.status === "completed" && taskStatus.completed_at) {
    const duration = taskStatus.total_duration || taskStatus.time_processing;
    if (duration) {
      message += `⏱️ Duration: ${formatDuration(duration)}\n`;
    }
  }

  // Add error information
  if (taskStatus.status === "failed" && taskStatus.error_message) {
    message += `\n💥 Error: ${taskStatus.error_message}\n`;
  }

  // Show notice with longer duration for important statuses
  const noticeDuration = ["completed", "failed", "stale"].includes(taskStatus.status) ? 10000 : 5000;
  new obsidian.Notice(message, noticeDuration);
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
 * Update task status in note frontmatter
 */
async function updateTaskStatus(app, file, frontmatter, taskStatus) {
  const updatedFrontmatter = {
    ...frontmatter,
    status: taskStatus.status,
    last_checked: new Date().toISOString()
  };

  // Add additional fields based on status
  if (taskStatus.started_at && !frontmatter.started_at) {
    updatedFrontmatter.started_at = taskStatus.started_at;
  }

  if (taskStatus.completed_at && !frontmatter.completed_at) {
    updatedFrontmatter.completed_at = taskStatus.completed_at;
  }

  if (taskStatus.agent_id && !frontmatter.agent_id) {
    updatedFrontmatter.agent_id = taskStatus.agent_id;
  }

  if (taskStatus.error_message) {
    updatedFrontmatter.error_message = taskStatus.error_message;
  }

  // Read current content
  const fileContent = await app.vault.read(file);
  const bodyContent = extractBody(fileContent);

  // Update file
  const updatedContent = buildFileWithFrontmatter(updatedFrontmatter, bodyContent);
  await app.vault.modify(file, updatedContent);
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
 * Open task dashboard in browser
 */
function openTaskDashboard(taskId) {
  const dashboardUrl = getDashboardUrl();
  const url = taskId ? `${dashboardUrl}?task=${taskId}` : dashboardUrl;

  try {
    // Try to open in default browser
    const { exec } = require('child_process');

    // Detect platform and use appropriate command
    const platform = process.platform;
    let openCommand;

    if (platform === 'darwin') {
      openCommand = `open "${url}"`;
    } else if (platform === 'win32') {
      openCommand = `start "${url}"`;
    } else {
      // Linux
      openCommand = `xdg-open "${url}"`;
    }

    exec(openCommand, (error) => {
      if (error) {
        console.error("Failed to open dashboard:", error);
      }
    });
  } catch (error) {
    console.error("Error opening dashboard:", error);
  }
}

/**
 * Get dashboard URL from environment or config
 */
function getDashboardUrl() {
  return process.env.FLUME_DASHBOARD_URL || "http://localhost:3000";
}

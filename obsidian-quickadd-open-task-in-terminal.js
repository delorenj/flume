/**
 * QuickAdd Macro: Open Task in Terminal
 *
 * Enhanced Obsidian integration for Flume Task Lifecycle System.
 * Reads TASK.md from current file, fires task.lifecycle.assigned event,
 * and launches platform-specific terminal with agent session attached.
 *
 * Features:
 * - TASK.md frontmatter parsing
 * - Agent and priority selection
 * - Automatic terminal launching
 * - Session attachment
 * - Status tracking in note
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

    // Check if file is TASK.md or has task frontmatter
    const fileContent = await app.vault.read(activeFile);
    const frontmatterData = parseFrontmatter(fileContent);

    // Determine if this is a task file
    const isTaskFile = activeFile.name === "TASK.md" || frontmatterData.type === "task";

    if (!isTaskFile) {
      const confirmConvert = await QuickAdd.yesNoPrompt(
        "Not a task file",
        `${activeFile.name} doesn't appear to be a task file. Convert it to a task?`
      );

      if (!confirmConvert) {
        new obsidian.Notice("❌ Operation cancelled");
        return;
      }
    }

    // Extract task metadata from frontmatter
    let taskId = frontmatterData.task_id || frontmatterData.taskId;
    let title = frontmatterData.title || activeFile.basename;
    let agentType = frontmatterData.agent_type || frontmatterData.agent;
    let priority = frontmatterData.priority;
    let workingDir = frontmatterData.working_dir || frontmatterData.project_path;

    // If no working directory, try to infer from file location
    if (!workingDir) {
      workingDir = activeFile.parent.path;
    }

    // Agent selection if not specified
    if (!agentType) {
      const agents = [
        "claude-code",
        "gemini-cli",
        "openai-cli",
        "local-llm",
        "cursor-ide",
        "windsurf-ide"
      ];

      agentType = await QuickAdd.suggester(
        agents.map(a => `🤖 ${a}`),
        agents
      );

      if (!agentType) {
        new obsidian.Notice("❌ Agent selection cancelled");
        return;
      }
    }

    // Priority selection if not specified
    if (!priority) {
      const priorities = ["low", "medium", "high", "critical"];
      const priorityEmojis = {
        low: "🟢",
        medium: "🟡",
        high: "🟠",
        critical: "🔴"
      };

      priority = await QuickAdd.suggester(
        priorities.map(p => `${priorityEmojis[p]} ${p}`),
        priorities
      );

      if (!priority) {
        new obsidian.Notice("❌ Priority selection cancelled");
        return;
      }
    }

    // Task title input if not specified
    if (!title || title === activeFile.basename) {
      const inputTitle = await QuickAdd.inputPrompt(
        "Task Title",
        "Enter a brief task title:",
        title
      );

      if (inputTitle) {
        title = inputTitle;
      }
    }

    // Show confirmation with summary
    const confirm = await QuickAdd.yesNoPrompt(
      `Open task in terminal?`,
      `Task: ${title}\nAgent: ${agentType}\nPriority: ${priority}\n\nThis will:\n• Fire task.lifecycle.assigned event\n• Launch ${agentType} in new terminal\n• Attach to session automatically`
    );

    if (!confirm) {
      new obsidian.Notice("❌ Operation cancelled");
      return;
    }

    new obsidian.Notice("🚀 Opening task in terminal...");

    // Get absolute path to current file
    const filePath = app.vault.adapter.getFullPath(activeFile.path);

    // Build flume-obsidian-bridge.sh command
    const bridgeScript = findBridgeScript();

    if (!bridgeScript) {
      new obsidian.Notice("❌ flume-obsidian-bridge.sh not found. Please check installation.");
      return;
    }

    const command = buildBridgeCommand({
      scriptPath: bridgeScript,
      taskFile: filePath,
      agent: agentType,
      priority: priority
    });

    // Execute bridge script
    const result = await executeCommand(command);

    if (result.error) {
      new obsidian.Notice(`❌ Failed to open task: ${result.error}`);
      console.error("Bridge script error:", result);
      return;
    }

    // Parse result JSON
    let resultData = {};
    try {
      const jsonMatch = result.stdout.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        resultData = JSON.parse(jsonMatch[0]);
      }
    } catch (e) {
      console.warn("Could not parse bridge script output:", e);
    }

    taskId = resultData.task_id || taskId || `task_${Date.now()}`;
    const eventId = resultData.event_id || `evt_${Date.now()}`;
    const timestamp = new Date().toISOString();

    // Update frontmatter with task metadata
    const updatedFrontmatter = {
      ...frontmatterData,
      type: "task",
      task_id: taskId,
      event_id: eventId,
      title: title,
      agent_type: agentType,
      priority: priority,
      status: "assigned",
      assigned_at: timestamp,
      working_dir: workingDir
    };

    // Update the file
    const bodyContent = extractBody(fileContent);
    const updatedContent = buildFileWithFrontmatter(updatedFrontmatter, bodyContent);
    await app.vault.modify(activeFile, updatedContent);

    new obsidian.Notice(`✅ Task opened in terminal! (${taskId})`);
    new obsidian.Notice(`💡 Session: flume-${taskId}`, 5000);

  } catch (error) {
    new obsidian.Notice(`❌ Error: ${error.message}`);
    console.error("Open task in terminal macro error:", error);
  }
};

/**
 * Find flume-obsidian-bridge.sh script
 */
function findBridgeScript() {
  const possiblePaths = [
    // Same directory as Obsidian vault
    "./flume-obsidian-bridge.sh",
    // User's home directory
    "~/flume-obsidian-bridge.sh",
    // In PATH
    "flume-obsidian-bridge.sh",
    // Common installation locations
    "/usr/local/bin/flume-obsidian-bridge.sh",
    "~/.local/bin/flume-obsidian-bridge.sh"
  ];

  // For now, assume it's in PATH or same directory
  // In production, this could be configurable
  return "flume-obsidian-bridge.sh";
}

/**
 * Build bridge script command
 */
function buildBridgeCommand({ scriptPath, taskFile, agent, priority }) {
  const escapeShell = (str) => {
    return str.replace(/'/g, "'\\''");
  };

  return `${scriptPath} '${escapeShell(taskFile)}' --agent '${escapeShell(agent)}' --priority '${escapeShell(priority)}'`;
}

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
 * Execute shell command
 */
async function executeCommand(command) {
  return new Promise((resolve) => {
    try {
      const { exec } = require('child_process');

      exec(command, { maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
          resolve({ error: error.message, stdout: stdout || '', stderr: stderr || '' });
        } else {
          resolve({ stdout, stderr, error: null });
        }
      });
    } catch (err) {
      resolve({ error: err.message, stdout: '', stderr: '' });
    }
  });
}

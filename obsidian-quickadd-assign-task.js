/**
 * QuickAdd Macro: Assign Task to Agent
 *
 * Reads task details from current note's frontmatter and body,
 * prompts for agent and priority, then fires task assignment via bb CLI.
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
    const frontmatterRegex = /^---\n([\s\S]*?)\n---/;
    const match = fileContent.match(frontmatterRegex);

    let frontmatter = {};
    let bodyContent = fileContent;

    if (match) {
      // Parse YAML frontmatter
      const frontmatterText = match[1];
      frontmatter = parseFrontmatter(frontmatterText);
      bodyContent = fileContent.substring(match[0].length).trim();
    }

    // Extract task details from frontmatter
    const taskId = frontmatter.task_id || frontmatter.taskId || generateTaskId();
    const title = frontmatter.title || frontmatter.task_title || activeFile.basename;

    // Extract description from note body (remove frontmatter and empty lines)
    const description = bodyContent
      .split('\n')
      .filter(line => line.trim().length > 0)
      .join('\n')
      .substring(0, 500); // Limit description length

    if (!description) {
      new obsidian.Notice("❌ No task description found in note body");
      return;
    }

    // Agent selection menu
    const agents = [
      "claude-code",
      "gemini-cli",
      "openai-cli",
      "local-llm",
      "cursor-ide",
      "windsurf-ide"
    ];

    const selectedAgent = await QuickAdd.suggester(
      agents.map(a => `🤖 ${a}`),
      agents
    );

    if (!selectedAgent) {
      new obsidian.Notice("❌ Agent selection cancelled");
      return;
    }

    // Priority selection menu
    const priorities = ["low", "medium", "high", "critical"];
    const priorityEmojis = {
      low: "🟢",
      medium: "🟡",
      high: "🟠",
      critical: "🔴"
    };

    const selectedPriority = await QuickAdd.suggester(
      priorities.map(p => `${priorityEmojis[p]} ${p}`),
      priorities
    );

    if (!selectedPriority) {
      new obsidian.Notice("❌ Priority selection cancelled");
      return;
    }

    // Show confirmation
    const confirm = await QuickAdd.yesNoPrompt(
      `Assign task to ${selectedAgent}?`,
      `Task: ${title}\nPriority: ${selectedPriority}\nAgent: ${selectedAgent}`
    );

    if (!confirm) {
      new obsidian.Notice("❌ Task assignment cancelled");
      return;
    }

    // Build CLI command
    const command = buildTaskAssignCommand({
      taskId,
      title,
      description,
      agent: selectedAgent,
      priority: selectedPriority,
      projectPath: activeFile.parent.path
    });

    new obsidian.Notice("🚀 Assigning task...");

    // Execute bb CLI command
    const result = await executeCommand(command);

    if (result.error) {
      new obsidian.Notice(`❌ Task assignment failed: ${result.error}`);
      console.error("Task assignment error:", result.error);
      return;
    }

    // Parse event_id from output (assuming CLI returns JSON or event_id line)
    const eventId = extractEventId(result.stdout);

    // Update frontmatter with assignment details
    const timestamp = new Date().toISOString();
    const updatedFrontmatter = {
      ...frontmatter,
      task_id: taskId,
      event_id: eventId || `evt_${Date.now()}`,
      assigned_to: selectedAgent,
      priority: selectedPriority,
      assigned_at: timestamp,
      status: "assigned"
    };

    // Update the file with new frontmatter
    const updatedContent = buildFileWithFrontmatter(updatedFrontmatter, bodyContent);
    await app.vault.modify(activeFile, updatedContent);

    new obsidian.Notice(`✅ Task assigned to ${selectedAgent} (${eventId || 'event created'})`);

  } catch (error) {
    new obsidian.Notice(`❌ Error: ${error.message}`);
    console.error("Task assignment macro error:", error);
  }
};

/**
 * Parse YAML frontmatter into object
 */
function parseFrontmatter(text) {
  const lines = text.split('\n');
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
 * Generate timestamp-based task ID
 */
function generateTaskId() {
  return `task_${Date.now()}`;
}

/**
 * Build bb task-assign command
 */
function buildTaskAssignCommand({ taskId, title, description, agent, priority, projectPath }) {
  // Escape strings for shell
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
 * Execute shell command using Node.js child_process
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
  // Try to parse as JSON first
  try {
    const json = JSON.parse(output);
    return json.event_id || json.eventId || json.id;
  } catch (e) {
    // Fall back to regex extraction
    const match = output.match(/event[_-]?id[:\s]+([a-zA-Z0-9_-]+)/i);
    return match ? match[1] : null;
  }
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

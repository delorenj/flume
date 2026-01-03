#!/bin/bash

# --- Configuration ---
TASK_DIR="/home/delorenj/code/DeLoDocs/Tasks" # Directory to store all task markdown files
AGENT_COMMAND="mise x -- claude"              # The command for your agent
TASK_FILE_ARG="--task-file"                   # The argument your agent uses to read a file
# ---------------------

# 1. Check if a task was provided as an argument
if [ -z "$1" ]; then
	echo "Error: No task provided."
	echo "Usage: start-task \"Your task description here...\""
	exit 1
fi

# 2. Generate a unique, sortable ID
UNIQUE_ID=$(date +%Y%m%d-%H%M%S)

# 3. Define the unique session name and task file path
SESSION_NAME="agent-task-$UNIQUE_ID"
TASK_FILE_PATH="$TASK_DIR/task-$UNIQUE_ID.md"

# 4. Write the dynamic task (all arguments) to the new, unique file
echo "$*" >"$TASK_FILE_PATH"

# 5. Generate the dynamic layout content in KDL format
#    This tells the new pane to run your agent and pass it the unique task file
LAYOUT_CONTENT="
layout {
    pane command=\"/home/delorenj/.local/bin/mise\" {
        args \"x\" \"--\" \"npx\" \"claude-flow@alpha\" \"swarm\" \"Implement the task in the file located at: $TASK_FILE_PATH\"
    }
}
"

# 6. Launch the new DETACHED session with the dynamic layout
#    We use process substitution <(echo ...) to feed the layout
nohup zellij -s "$SESSION_NAME" --layout <(echo "$LAYOUT_CONTENT") >/dev/null 2>&1 &

# 7. Report the mapping back to you
echo "🚀 Started new agent session:"
echo "   - Session Name: $SESSION_NAME"
echo "   - Task File:    $TASK_FILE_PATH"
echo "   - Attach with:  zellij attach $SESSION_NAME"

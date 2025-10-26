#!/usr/bin/env bash

# flume-obsidian-bridge.sh
# Obsidian-to-Terminal Bridge for Flume Task Lifecycle System
#
# This script is called by Obsidian QuickAdd macros to:
# 1. Parse TASK.md from Obsidian
# 2. Fire task.lifecycle.assigned event to RabbitMQ
# 3. Launch platform-specific terminal emulator
# 4. Attach to spawned agent session automatically
#
# Usage: flume-obsidian-bridge.sh <task-file-path> [--agent <agent-type>] [--priority <priority>]

set -euo pipefail

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="${HOME}/.config/flume/config.yaml"
DEFAULT_AGENT="claude-code"
DEFAULT_PRIORITY="medium"
DEFAULT_SESSION_MANAGER="zellij"

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $*" >&2
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $*" >&2
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $*" >&2
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $*" >&2
}

# Display usage
usage() {
    cat << EOF
Usage: $(basename "$0") <task-file-path> [OPTIONS]

Obsidian-to-Terminal Bridge for Flume Task Lifecycle System

ARGUMENTS:
    task-file-path      Path to TASK.md file

OPTIONS:
    --agent AGENT       Agent type (default: ${DEFAULT_AGENT})
    --priority PRIORITY Priority level: low, medium, high, critical (default: ${DEFAULT_PRIORITY})
    --session-mgr MGR   Session manager: tmux, zellij (default: ${DEFAULT_SESSION_MANAGER})
    --no-attach         Fire event but don't open terminal
    --help              Show this help message

EXAMPLES:
    # Basic usage - fire task and open terminal
    $(basename "$0") /path/to/TASK.md

    # Specify agent and priority
    $(basename "$0") /path/to/TASK.md --agent gemini-cli --priority high

    # Fire event without opening terminal
    $(basename "$0") /path/to/TASK.md --no-attach

ENVIRONMENT VARIABLES:
    FLUME_RABBITMQ_URL    RabbitMQ connection URL (default: amqp://guest:guest@localhost:5672/)
    FLUME_CONFIG_FILE     Alternative config file path

EOF
}

# Parse command line arguments
parse_args() {
    TASK_FILE=""
    AGENT="${DEFAULT_AGENT}"
    PRIORITY="${DEFAULT_PRIORITY}"
    SESSION_MANAGER="${DEFAULT_SESSION_MANAGER}"
    NO_ATTACH=false

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --help|-h)
                usage
                exit 0
                ;;
            --agent)
                AGENT="$2"
                shift 2
                ;;
            --priority)
                PRIORITY="$2"
                shift 2
                ;;
            --session-mgr)
                SESSION_MANAGER="$2"
                shift 2
                ;;
            --no-attach)
                NO_ATTACH=true
                shift
                ;;
            -*)
                log_error "Unknown option: $1"
                usage
                exit 1
                ;;
            *)
                if [[ -z "$TASK_FILE" ]]; then
                    TASK_FILE="$1"
                else
                    log_error "Multiple task files specified"
                    usage
                    exit 1
                fi
                shift
                ;;
        esac
    done

    if [[ -z "$TASK_FILE" ]]; then
        log_error "Task file path required"
        usage
        exit 1
    fi
}

# Validate TASK.md exists and is readable
validate_task_file() {
    if [[ ! -f "$TASK_FILE" ]]; then
        log_error "Task file not found: $TASK_FILE"
        exit 1
    fi

    if [[ ! -r "$TASK_FILE" ]]; then
        log_error "Task file not readable: $TASK_FILE"
        exit 1
    fi

    log_info "Task file validated: $TASK_FILE"
}

# Parse frontmatter from TASK.md
parse_frontmatter() {
    local file="$1"
    local in_frontmatter=false
    local frontmatter=""

    while IFS= read -r line; do
        if [[ "$line" == "---" ]]; then
            if [[ "$in_frontmatter" == true ]]; then
                break
            fi
            in_frontmatter=true
            continue
        fi

        if [[ "$in_frontmatter" == true ]]; then
            frontmatter+="$line"$'\n'
        fi
    done < "$file"

    echo "$frontmatter"
}

# Extract value from frontmatter
get_frontmatter_value() {
    local frontmatter="$1"
    local key="$2"
    local default="${3:-}"

    # Try exact match first (key: value)
    local value=$(echo "$frontmatter" | grep -E "^${key}:" | head -1 | sed -E "s/^${key}:[[:space:]]*//" | sed 's/^["'\'']\|["'\'']$//g')

    if [[ -n "$value" ]]; then
        echo "$value"
    else
        echo "$default"
    fi
}

# Generate task ID if not present
generate_task_id() {
    echo "task_$(date +%s)_$(head /dev/urandom | tr -dc A-Za-z0-9 | head -c 8)"
}

# Extract task metadata from TASK.md
extract_task_metadata() {
    local frontmatter=$(parse_frontmatter "$TASK_FILE")

    # Extract from frontmatter or use defaults
    TASK_ID=$(get_frontmatter_value "$frontmatter" "task_id" "$(generate_task_id)")
    TASK_TITLE=$(get_frontmatter_value "$frontmatter" "title" "$(basename "$TASK_FILE" .md)")
    TASK_WORKING_DIR=$(get_frontmatter_value "$frontmatter" "working_dir" "$(dirname "$TASK_FILE")")

    # Override with CLI args if provided
    TASK_AGENT_TYPE="${AGENT}"
    TASK_PRIORITY="${PRIORITY}"

    # Read description (everything after frontmatter)
    TASK_DESCRIPTION=$(awk '/^---$/{flag++; next} flag==2{print}' "$TASK_FILE" | head -c 1000)

    log_info "Extracted task metadata:"
    log_info "  Task ID: $TASK_ID"
    log_info "  Title: $TASK_TITLE"
    log_info "  Agent: $TASK_AGENT_TYPE"
    log_info "  Priority: $TASK_PRIORITY"
    log_info "  Working Dir: $TASK_WORKING_DIR"
}

# Fire task.lifecycle.assigned event via bb CLI
fire_task_event() {
    log_info "Firing task.lifecycle.assigned event..."

    # Check if bb CLI is available
    if ! command -v bb &> /dev/null; then
        log_error "bb CLI not found in PATH. Please install bloodbank CLI."
        exit 1
    fi

    # Escape single quotes in strings for shell command
    local escaped_title="${TASK_TITLE//\'/\'\\\'\'}"
    local escaped_description="${TASK_DESCRIPTION//\'/\'\\\'\'}"
    local escaped_working_dir="${TASK_WORKING_DIR//\'/\'\\\'\'}"

    # Build and execute bb task-assign command
    local bb_output
    if bb_output=$(bb task-assign \
        --task-id "$TASK_ID" \
        --title "$escaped_title" \
        --description "$escaped_description" \
        --agent "$TASK_AGENT_TYPE" \
        --priority "$TASK_PRIORITY" \
        --working-dir "$escaped_working_dir" \
        --task-file "$TASK_FILE" \
        --format json 2>&1); then

        log_success "Task event published successfully"

        # Extract event_id from JSON output
        EVENT_ID=$(echo "$bb_output" | grep -o '"event_id"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/"event_id"[[:space:]]*:[[:space:]]*"\([^"]*\)"/\1/')

        if [[ -z "$EVENT_ID" ]]; then
            log_warn "Could not extract event_id from output"
            EVENT_ID="evt_$(date +%s)"
        fi

        log_info "Event ID: $EVENT_ID"
    else
        log_error "Failed to publish task event"
        log_error "Output: $bb_output"
        exit 1
    fi
}

# Detect platform (Linux, macOS, Windows WSL)
detect_platform() {
    case "$(uname -s)" in
        Linux*)
            if grep -qi microsoft /proc/version 2>/dev/null; then
                echo "wsl"
            else
                echo "linux"
            fi
            ;;
        Darwin*)
            echo "macos"
            ;;
        CYGWIN*|MINGW*|MSYS*)
            echo "windows"
            ;;
        *)
            echo "unknown"
            ;;
    esac
}

# Detect available terminal emulator
detect_terminal() {
    local platform="$1"

    case "$platform" in
        linux)
            # Try common Linux terminals in order of preference
            for term in gnome-terminal konsole xterm alacritty kitty; do
                if command -v "$term" &> /dev/null; then
                    echo "$term"
                    return
                fi
            done
            ;;
        macos)
            # macOS - check for iTerm2, then fall back to Terminal.app
            if [[ -d "/Applications/iTerm.app" ]]; then
                echo "iterm2"
            else
                echo "terminal"
            fi
            return
            ;;
        wsl)
            # WSL - use wsl.exe
            echo "wsl"
            return
            ;;
    esac

    echo "none"
}

# Build session attach command
build_attach_command() {
    local session_name="flume-${TASK_ID}"

    case "$SESSION_MANAGER" in
        zellij)
            echo "zellij attach ${session_name}"
            ;;
        tmux)
            echo "tmux attach-session -t ${session_name}"
            ;;
        *)
            log_error "Unknown session manager: $SESSION_MANAGER"
            exit 1
            ;;
    esac
}

# Launch terminal with session attach
launch_terminal() {
    if [[ "$NO_ATTACH" == true ]]; then
        log_info "Skipping terminal launch (--no-attach specified)"
        return
    fi

    local platform=$(detect_platform)
    local terminal=$(detect_terminal "$platform")
    local attach_cmd=$(build_attach_command)

    log_info "Platform: $platform"
    log_info "Terminal: $terminal"
    log_info "Attach command: $attach_cmd"

    if [[ "$terminal" == "none" ]]; then
        log_warn "No suitable terminal emulator found"
        log_warn "Please manually attach to session: $attach_cmd"
        return
    fi

    log_info "Launching terminal..."

    case "$terminal" in
        gnome-terminal)
            gnome-terminal -- bash -c "$attach_cmd" &
            ;;
        konsole)
            konsole -e bash -c "$attach_cmd" &
            ;;
        xterm)
            xterm -e bash -c "$attach_cmd" &
            ;;
        alacritty)
            alacritty -e bash -c "$attach_cmd" &
            ;;
        kitty)
            kitty bash -c "$attach_cmd" &
            ;;
        iterm2)
            osascript <<EOF
tell application "iTerm"
    create window with default profile
    tell current session of current window
        write text "$attach_cmd"
    end tell
end tell
EOF
            ;;
        terminal)
            osascript <<EOF
tell application "Terminal"
    do script "$attach_cmd"
    activate
end tell
EOF
            ;;
        wsl)
            # Launch Windows Terminal or cmd.exe with WSL
            if command -v wt.exe &> /dev/null; then
                wt.exe -w 0 new-tab wsl.exe -e bash -c "$attach_cmd" &
            elif command -v cmd.exe &> /dev/null; then
                cmd.exe /c start wsl.exe -e bash -c "$attach_cmd" &
            else
                log_error "Neither wt.exe nor cmd.exe found"
                return 1
            fi
            ;;
        *)
            log_error "Unsupported terminal: $terminal"
            return 1
            ;;
    esac

    log_success "Terminal launched successfully"
    log_info "Session will be available shortly: $(build_attach_command)"
}

# Main execution
main() {
    log_info "Flume Obsidian Bridge - Starting"

    parse_args "$@"
    validate_task_file
    extract_task_metadata
    fire_task_event

    # Give session manager a moment to process the event and create session
    log_info "Waiting for session creation..."
    sleep 2

    launch_terminal

    log_success "Task dispatched successfully!"
    log_info "Task ID: $TASK_ID"
    log_info "Event ID: $EVENT_ID"

    # Output JSON for programmatic use
    cat << EOF
{
  "task_id": "$TASK_ID",
  "event_id": "$EVENT_ID",
  "agent_type": "$TASK_AGENT_TYPE",
  "priority": "$TASK_PRIORITY",
  "working_dir": "$TASK_WORKING_DIR"
}
EOF
}

# Execute main function
main "$@"

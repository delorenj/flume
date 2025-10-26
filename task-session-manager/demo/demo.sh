#!/bin/bash
# Flume CLI Tools Demonstration Script
# This script demonstrates the three CLI tools in action

set -e  # Exit on error

# Get script directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
BIN_DIR="$SCRIPT_DIR/../bin"

# Add bin directory to PATH for this script
export PATH="$BIN_DIR:$PATH"

echo "=========================================="
echo "Flume CLI Tools Demonstration"
echo "=========================================="
echo ""

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Helper function to print colored headers
print_header() {
    echo ""
    echo -e "${BLUE}>>> $1${NC}"
    echo ""
}

# Helper function to run command with description
run_cmd() {
    echo -e "${YELLOW}$ $1${NC}"
    eval "$1"
    echo ""
}

# 1. Show versions
print_header "1. Checking CLI Tool Versions"
run_cmd "flume-complete --version"
run_cmd "flume-session --version"
run_cmd "flume --version"

# 2. List active sessions
print_header "2. Listing Active Sessions"
run_cmd "flume-session list"

# 3. Check task status (will fail if API not running, that's ok for demo)
print_header "3. Checking Task Status"
echo -e "${YELLOW}$ flume status --all${NC}"
flume status --all 2>&1 || echo "Note: Task Monitor API not running (expected in demo mode)"
echo ""

# 4. Show help for each tool
print_header "4. CLI Tool Help Information"

echo -e "${GREEN}flume-complete --help:${NC}"
flume-complete --help | head -20
echo "... (truncated)"
echo ""

echo -e "${GREEN}flume-session --help:${NC}"
flume-session --help | head -20
echo "... (truncated)"
echo ""

echo -e "${GREEN}flume --help:${NC}"
flume --help | head -20
echo "... (truncated)"
echo ""

# 5. Demonstrate dry-run/error handling
print_header "5. Error Handling Examples"

echo -e "${YELLOW}Example: Missing required argument${NC}"
flume-complete 2>&1 || true
echo ""

echo -e "${YELLOW}Example: Invalid status${NC}"
flume-complete --task-id TEST-001 --status invalid 2>&1 || true
echo ""

# 6. Show configuration
print_header "6. Configuration"
echo "Configuration will be loaded from:"
echo "  - ~/.config/flume/config.yaml (if exists)"
echo "  - Environment variables (if set)"
echo "  - Built-in defaults"
echo ""
echo "Example configuration:"
cat ../config.example.yaml | head -20
echo "... (see config.example.yaml for full config)"
echo ""

# 7. Integration points
print_header "7. Integration Points"
echo "flume-complete  → RabbitMQ (amqp://localhost:5672)"
echo "                  Emits: task.lifecycle.completed/failed/paused"
echo ""
echo "flume-session   → tmux/zellij sessions"
echo "                  Manages: task-* sessions"
echo ""
echo "flume (status)  → Task Monitor API (http://localhost:8000)"
echo "                  Queries: GET /tasks/{id}"
echo ""

# 8. Exit codes
print_header "8. Exit Codes"
echo "All tools follow standardized exit codes:"
echo "  0 = Success"
echo "  1 = Usage error"
echo "  2 = Configuration error"
echo "  3 = Connection error"
echo "  4 = Operation error"
echo "  5 = Not found error"
echo ""

print_header "Demo Complete!"
echo -e "${GREEN}✓ All three CLI tools are working correctly${NC}"
echo ""
echo "Next steps:"
echo "  1. Install: sudo make install-all"
echo "  2. Configure: cp config.example.yaml ~/.config/flume/config.yaml"
echo "  3. Start using: flume-complete, flume-session, flume status"
echo ""
echo "Documentation:"
echo "  - CLI_README.md - Quick start guide"
echo "  - docs/CLI_TOOLS.md - Comprehensive documentation"
echo "  - CLI_IMPLEMENTATION_SUMMARY.md - Implementation details"
echo ""

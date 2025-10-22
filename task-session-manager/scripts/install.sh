#!/bin/bash

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
BINARY_NAME="task-session-manager"
SERVICE_NAME="task-session-manager"
INSTALL_DIR="/usr/local/bin"
SERVICE_DIR="/etc/systemd/system"
CONFIG_DIR="/etc/task-session-manager"
USER="taskmanager"

echo -e "${GREEN}Task Session Manager Installation Script${NC}"
echo "=========================================="
echo ""

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    echo -e "${RED}Error: This script must be run as root${NC}"
    exit 1
fi

# Check if binary exists
if [ ! -f "bin/${BINARY_NAME}" ]; then
    echo -e "${YELLOW}Binary not found, building...${NC}"
    make build
fi

# Create service user
echo -e "${GREEN}Creating service user...${NC}"
if ! id -u ${USER} >/dev/null 2>&1; then
    useradd -r -s /bin/false ${USER}
    echo "User ${USER} created"
else
    echo "User ${USER} already exists"
fi

# Install binary
echo -e "${GREEN}Installing binary...${NC}"
cp bin/${BINARY_NAME} ${INSTALL_DIR}/
chmod +x ${INSTALL_DIR}/${BINARY_NAME}
echo "Binary installed to ${INSTALL_DIR}/${BINARY_NAME}"

# Create config directory
echo -e "${GREEN}Creating configuration directory...${NC}"
mkdir -p ${CONFIG_DIR}
if [ -f ".env.example" ]; then
    if [ ! -f "${CONFIG_DIR}/env" ]; then
        cp .env.example ${CONFIG_DIR}/env
        echo "Configuration file created at ${CONFIG_DIR}/env"
        echo -e "${YELLOW}Please edit ${CONFIG_DIR}/env with your configuration${NC}"
    else
        echo "Configuration file already exists"
    fi
fi

# Install systemd service
echo -e "${GREEN}Installing systemd service...${NC}"
cp ${SERVICE_NAME}.service ${SERVICE_DIR}/
chmod 644 ${SERVICE_DIR}/${SERVICE_NAME}.service
echo "Service file installed to ${SERVICE_DIR}/${SERVICE_NAME}.service"

# Reload systemd
echo -e "${GREEN}Reloading systemd...${NC}"
systemctl daemon-reload

# Check if tmux or zellij is installed
echo -e "${GREEN}Checking session managers...${NC}"
TMUX_INSTALLED=false
ZELLIJ_INSTALLED=false

if command -v tmux &> /dev/null; then
    TMUX_INSTALLED=true
    echo "✓ tmux is installed"
else
    echo "✗ tmux is not installed"
fi

if command -v zellij &> /dev/null; then
    ZELLIJ_INSTALLED=true
    echo "✓ zellij is installed"
else
    echo "✗ zellij is not installed"
fi

if [ "$TMUX_INSTALLED" = false ] && [ "$ZELLIJ_INSTALLED" = false ]; then
    echo -e "${RED}Error: Neither tmux nor zellij is installed${NC}"
    echo "Please install at least one session manager:"
    echo "  Ubuntu/Debian: sudo apt-get install tmux"
    echo "  MacOS: brew install tmux"
    exit 1
fi

# Completion message
echo ""
echo -e "${GREEN}Installation completed successfully!${NC}"
echo ""
echo "Next steps:"
echo "1. Edit configuration: ${CONFIG_DIR}/env"
echo "2. Enable service: systemctl enable ${SERVICE_NAME}"
echo "3. Start service: systemctl start ${SERVICE_NAME}"
echo "4. Check status: systemctl status ${SERVICE_NAME}"
echo "5. View logs: journalctl -u ${SERVICE_NAME} -f"
echo ""

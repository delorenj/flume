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

echo -e "${YELLOW}Task Session Manager Uninstallation Script${NC}"
echo "==========================================="
echo ""

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    echo -e "${RED}Error: This script must be run as root${NC}"
    exit 1
fi

# Stop service if running
echo -e "${GREEN}Stopping service...${NC}"
if systemctl is-active --quiet ${SERVICE_NAME}; then
    systemctl stop ${SERVICE_NAME}
    echo "Service stopped"
else
    echo "Service is not running"
fi

# Disable service
echo -e "${GREEN}Disabling service...${NC}"
if systemctl is-enabled --quiet ${SERVICE_NAME}; then
    systemctl disable ${SERVICE_NAME}
    echo "Service disabled"
else
    echo "Service is not enabled"
fi

# Remove systemd service file
echo -e "${GREEN}Removing service file...${NC}"
if [ -f "${SERVICE_DIR}/${SERVICE_NAME}.service" ]; then
    rm ${SERVICE_DIR}/${SERVICE_NAME}.service
    echo "Service file removed"
fi

# Reload systemd
systemctl daemon-reload

# Remove binary
echo -e "${GREEN}Removing binary...${NC}"
if [ -f "${INSTALL_DIR}/${BINARY_NAME}" ]; then
    rm ${INSTALL_DIR}/${BINARY_NAME}
    echo "Binary removed"
fi

# Ask about configuration
echo ""
read -p "Remove configuration directory ${CONFIG_DIR}? (y/N) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    rm -rf ${CONFIG_DIR}
    echo "Configuration directory removed"
fi

# Ask about user
echo ""
read -p "Remove service user ${USER}? (y/N) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    userdel ${USER}
    echo "User removed"
fi

echo ""
echo -e "${GREEN}Uninstallation completed!${NC}"
echo ""

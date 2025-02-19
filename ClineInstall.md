# Cline Installation Guide

This guide provides specific instructions for Cline to install and configure the Proxmox MCP server.

## Prerequisites
- UV package manager
- Python 3.9 or higher
- Access to a Proxmox server with API token credentials

## Installation Steps

### 1. Environment Setup
```bash
# Clone repository into Cline MCP directory
cd ~/Documents/Cline/MCP
git clone https://github.com/canvrno/ProxmoxMCP.git
cd ProxmoxMCP

# Create and activate virtual environment using UV
uv venv
source .venv/bin/activate

# Install package in development mode with dependencies
uv pip install -e ".[dev]"
```

### 2. Configuration Setup
Create the config directory and config.json file:
```bash
mkdir -p proxmox-config
```

Create `proxmox-config/config.json` with the following structure:
```json
{
    "proxmox": {
        "host": "your-proxmox-host",  # Hostname or IP of Proxmox server
        "port": 8006,                 # Default Proxmox API port
        "verify_ssl": true,           # Set to false if using self-signed certs
        "service": "PVE"              # Default Proxmox service
    },
    "auth": {
        "user": "username@pve",       # Proxmox username with @pve suffix
        "token_name": "token-name",   # API token name
        "token_value": "token-value"  # API token value
    },
    "logging": {
        "level": "INFO",              # DEBUG for more verbose logging
        "format": "%(asctime)s - %(name)s - %(levelname)s - %(message)s",
        "file": "proxmox_mcp.log"     # Log file name
    }
}
```

### 3. MCP Server Configuration
Add the following configuration to the Cline MCP settings file (typically at `~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`):

```json
{
    "mcpServers": {
        "github.com/canvrno/ProxmoxMCP": {
            "command": "/absolute/path/to/ProxmoxMCP/.venv/bin/python",
            "args": ["-m", "proxmox_mcp.server"],
            "cwd": "/absolute/path/to/ProxmoxMCP",
            "env": {
                "PYTHONPATH": "/absolute/path/to/ProxmoxMCP/src",
                "PROXMOX_MCP_CONFIG": "/absolute/path/to/ProxmoxMCP/proxmox-config/config.json",
                "PROXMOX_HOST": "your-proxmox-host",
                "PROXMOX_USER": "username@pve",
                "PROXMOX_TOKEN_NAME": "token-name",
                "PROXMOX_TOKEN_VALUE": "token-value",
                "PROXMOX_PORT": "8006",
                "PROXMOX_VERIFY_SSL": "false",
                "PROXMOX_SERVICE": "PVE",
                "LOG_LEVEL": "DEBUG"
            },
            "disabled": false,
            "autoApprove": []
        }
    }
}
```

## Critical Requirements

1. **Virtual Environment**:
   - The virtual environment MUST be used for both installation and running the server
   - All Python commands should be run within the activated venv

2. **File Paths**:
   - ALL paths in the MCP settings must be absolute paths
   - The PYTHONPATH must point to the `src` directory
   - The PROXMOX_MCP_CONFIG environment variable must point to your config.json file

3. **Environment Variables**:
   - PROXMOX_MCP_CONFIG is required for the server to locate your configuration
   - All Proxmox-related environment variables can override config.json settings

4. **VSCode Integration**:
   - Restart VSCode after updating MCP settings
   - The server will be available through the MCP tools interface

## Troubleshooting

1. **Import Errors**:
   - Ensure PYTHONPATH is set correctly
   - Verify the package is installed in development mode
   - Make sure you're using the Python interpreter from the virtual environment

2. **Configuration Errors**:
   - Check that PROXMOX_MCP_CONFIG points to a valid config.json file
   - Verify all required fields are present in config.json
   - Ensure Proxmox credentials are correct

3. **Connection Issues**:
   - Verify Proxmox host is reachable
   - Check if SSL verification is appropriate for your setup
   - Confirm API token has necessary permissions

## Available Tools

Once installed, the following tools will be available:

1. `get_nodes`: List all nodes in the cluster
2. `get_node_status`: Get detailed status of a specific node
3. `get_vms`: List all VMs across the cluster
4. `get_storage`: List available storage
5. `get_cluster_status`: Get cluster status
6. `execute_vm_command`: Run commands in VM consoles

Example usage:
```python
# Get cluster status
use_mcp_tool(
    server_name="github.com/canvrno/ProxmoxMCP",
    tool_name="get_cluster_status",
    arguments={}
)

# Get status of specific node
use_mcp_tool(
    server_name="github.com/canvrno/ProxmoxMCP",
    tool_name="get_node_status",
    arguments={"node": "pve1"}
)

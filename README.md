# 🚀 Proxmox MCP Server (Node.js Edition)

A Node.js-based Model Context Protocol (MCP) server for interacting with Proxmox hypervisors, providing a clean interface for managing nodes, VMs, and containers with configurable permission levels.

## 🙏 Credits

This project is based on the original Python implementation by [canvrno/ProxmoxMCP](https://github.com/canvrno/ProxmoxMCP). This Node.js version maintains the same core functionality while adapting it for JavaScript/Node.js environments and adding configurable permission management.

## 🔄 Changes from Original

**Architecture Changes:**
- ✅ Complete rewrite from Python to Node.js
- ✅ Uses `@modelcontextprotocol/sdk` instead of Python MCP SDK
- ✅ Environment variable configuration instead of JSON config files
- ✅ Simplified dependency management with npm

**New Features:**
- 🔒 **Configurable Permission Levels**: `PROXMOX_ALLOW_ELEVATED` setting for security
- 🛡️ **Basic Mode**: Safe operations (node listing, VM status) with minimal permissions
- 🔓 **Elevated Mode**: Advanced features (detailed metrics, command execution) requiring full permissions
- 📝 **Better Error Handling**: Clear permission warnings and graceful degradation
- 🔧 **Auto Environment Loading**: Automatically loads `.env` files from parent directories

## 🏗️ Built With

- [Node.js](https://nodejs.org/) - JavaScript runtime
- [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/sdk) - Model Context Protocol SDK for Node.js
- [node-fetch](https://github.com/node-fetch/node-fetch) - HTTP client for API requests

## ✨ Features

- 🔒 **Configurable Security**: Two permission levels for safe operation
- 🛠️ Built with the official MCP SDK for Node.js
- 🔐 Secure token-based authentication with Proxmox
- 🖥️ Comprehensive node and VM management
- 💻 VM console command execution (elevated mode)
- 📊 Real-time resource monitoring
- 🎨 Rich markdown-formatted output
- ⚡ Fast Node.js performance
- 🔧 Easy environment-based configuration



https://github.com/user-attachments/assets/1b5f42f7-85d5-4918-aca4-d38413b0e82b



## 📦 Installation

### Prerequisites
- Node.js 16+ and npm
- Git
- Access to a Proxmox server with API token credentials

Before starting, ensure you have:
- [ ] Node.js and npm installed
- [ ] Proxmox server hostname or IP
- [ ] Proxmox API token (see [API Token Setup](#proxmox-api-token-setup))

### Quick Install

1. Clone and set up:
   ```bash
   git clone https://github.com/gilby125/mcp-proxmox.git
   cd mcp-proxmox
   npm install
   ```

2. Create `.env` file with your Proxmox configuration:
   ```bash
   # Proxmox Configuration
   PROXMOX_HOST=192.168.1.100
   PROXMOX_USER=root@pam
   PROXMOX_TOKEN_NAME=mcp-server
   PROXMOX_TOKEN_VALUE=your-token-value-here
   PROXMOX_ALLOW_ELEVATED=false  # Set to 'true' for advanced features
   ```

   **Note**: `PROXMOX_PORT` defaults to 8006 and can be omitted unless using a custom port.

### Permission Levels

**Basic Mode** (`PROXMOX_ALLOW_ELEVATED=false`):
- List cluster nodes and their status
- List VMs and containers
- Basic cluster health overview
- Requires minimal API token permissions

**Elevated Mode** (`PROXMOX_ALLOW_ELEVATED=true`):
- All basic features plus:
- Detailed node resource metrics
- VM command execution
- Advanced cluster statistics
- Requires API token with `Sys.Audit`, `VM.Monitor`, `VM.Console` permissions

### Verifying Installation

1. Test the MCP server:
   ```bash
   echo '{"jsonrpc": "2.0", "id": 1, "method": "tools/list"}' | node index.js
   ```

2. Test a basic API call:
   ```bash
   echo '{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "proxmox_get_nodes", "arguments": {}}}' | node index.js
   ```

   You should see either:
   - A successful list of your Proxmox nodes
   - Or a connection/permission error with helpful guidance

## ⚙️ Configuration

### Proxmox API Token Setup
1. Log into your Proxmox web interface
2. Navigate to **Datacenter** → **Permissions** → **API Tokens**
3. Click **Add** to create a new API token:
   - **User**: Select existing user (e.g., `root@pam`)
   - **Token ID**: Enter a name (e.g., `mcp-server`)
   - **Privilege Separation**: Uncheck for full access or leave checked for limited permissions
   - Click **Add**
4. **Important**: Copy both the **Token ID** and **Secret** immediately (secret is only shown once)
   - Use Token ID as `PROXMOX_TOKEN_NAME`
   - Use Secret as `PROXMOX_TOKEN_VALUE`

**Permission Requirements:**
- **Basic Mode**: Minimal permissions (usually default user permissions work)
- **Elevated Mode**: Add permissions for `Sys.Audit`, `VM.Monitor`, `VM.Console` to the user/token


## 🚀 Running the Server

### Direct Execution
```bash
node index.js
```

### MCP Client Integration

For Claude Code or other MCP clients, add this to your MCP configuration:

```json
{
  "mcpServers": {
    "mcp-proxmox": {
      "command": "node",
      "args": ["index.js"],
      "cwd": "/absolute/path/to/mcp-proxmox"
    }
  }
}
```

**Important**: 
- Replace `/absolute/path/to/mcp-proxmox` with the actual path to your installation
- The server automatically loads environment variables from `.env` files
- Ensure the `.env` file is in the same directory as `index.js` or a parent directory

# 🔧 Available Tools

The server provides the following MCP tools for interacting with Proxmox:

### proxmox_get_nodes
Lists all nodes in the Proxmox cluster with their status and resources.

- Parameters: None
- Example Response:
  ```
  🖥️  **Proxmox Cluster Nodes**

  🟢 **pve1**
     • Status: online
     • Uptime: 3d 2h 53m
     • CPU: 1.8%
     • Memory: 5.89 GB / 62.21 GB (9.5%)
     • Load: N/A
  ```

### proxmox_get_node_status
Get detailed status of a specific node (requires elevated permissions).

- Parameters:
  - `node` (string, required): Name of the node
- Example Response (Basic Mode):
  ```
  ⚠️  **Node Status Requires Elevated Permissions**

  To view detailed node status, set `PROXMOX_ALLOW_ELEVATED=true` in your .env file 
  and ensure your API token has Sys.Audit permissions.

  **Current permissions**: Basic (node listing only)
  ```

### proxmox_get_vms
List all virtual machines across the cluster with their status.

- Parameters:
  - `node` (string, optional): Filter by specific node
  - `type` (string, optional): VM type filter ('qemu', 'lxc', 'all'), default: 'all'
- Example Response:
  ```
  💻 **Virtual Machines**

  🟢 📦 **docker** (ID: 100)
     • Node: pve1
     • Status: running
     • Type: LXC
     • Uptime: 5h 40m
     • CPU: 0.8%
     • Memory: 7.46 GB / 46.88 GB

  🔴 📦 **ubuntu1** (ID: 115)
     • Node: pve1
     • Status: stopped
     • Type: LXC
  ```

### proxmox_get_vm_status
Get detailed status information for a specific VM.

- Parameters:
  - `node` (string, required): Node name where VM is located
  - `vmid` (string, required): VM ID number
  - `type` (string, optional): VM type ('qemu', 'lxc'), default: 'qemu'
- Example Response:
  ```
  🟢 📦 **docker** (ID: 100)

  • **Node**: pve1
  • **Status**: running
  • **Type**: LXC
  • **Uptime**: 5h 42m
  • **CPU Usage**: 0.8%
  • **Memory**: 7.47 GB / 46.88 GB (15.9%)
  • **Disk Read**: 19.74 GB
  • **Disk Write**: 21.71 GB
  • **Network In**: 1.32 GB
  • **Network Out**: 216.56 MB
  ```

### proxmox_get_storage
List all storage pools and their usage across the cluster.

- Parameters:
  - `node` (string, optional): Filter by specific node
- Example Response:
  ```
  💾 **Storage Pools**

  🟢 **local**
     • Node: pve1
     • Type: dir
     • Content: vztmpl,iso,backup
     • Usage: 19.58 GB / 93.93 GB (20.8%)
     • Status: Enabled

  🟢 **zfs**
     • Node: pve1
     • Type: zfspool
     • Content: rootdir,images
     • Usage: 87.33 MB / 899.25 GB (0.0%)
     • Status: Enabled
  ```

### proxmox_get_cluster_status
Get overall cluster status including nodes and resource usage.

- Parameters: None
- Example Response (Basic Mode):
  ```
  🏗️  **Proxmox Cluster Status**

  **Cluster Health**: 🟢 Healthy
  **Nodes**: 1/1 online

  ⚠️  **Limited Information**: Resource usage requires elevated permissions

  **Node Details**:
  🟢 pve1 - online
  ```

### proxmox_execute_vm_command
Execute a shell command on a virtual machine via Proxmox API (requires elevated permissions).

- Parameters:
  - `node` (string, required): Node name where VM is located
  - `vmid` (string, required): VM ID number
  - `command` (string, required): Shell command to execute
  - `type` (string, optional): VM type ('qemu', 'lxc'), default: 'qemu'
- Example Response (Basic Mode):
  ```
  ⚠️  **VM Command Execution Requires Elevated Permissions**

  To execute commands on VMs, set `PROXMOX_ALLOW_ELEVATED=true` in your .env file 
  and ensure your API token has appropriate VM permissions.

  **Current permissions**: Basic (VM listing only)
  **Requested command**: `uptime`
  ```
- Requirements (Elevated Mode):
  - VM must be running
  - For QEMU: QEMU Guest Agent must be installed and running
  - For LXC: Direct execution via Proxmox API
  - Appropriate API token permissions

## 👨‍💻 Development

### Development Commands

```bash
# Install dependencies
npm install

# Run server (production)
npm start
# or
node index.js

# Run server with auto-reload (development)
npm run dev

# Test MCP server functionality
echo '{"jsonrpc": "2.0", "id": 1, "method": "tools/list"}' | node index.js

# Test specific API call
echo '{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "proxmox_get_nodes", "arguments": {}}}' | node index.js
```

### Development Notes

- The server loads environment variables from `.env` files automatically
- Use `npm run dev` for development with auto-reload on file changes
- All API calls require a proper `.env` configuration
- Check the server logs for connection and permission issues

## 📁 Project Structure

```
mcp-proxmox/
├── index.js                  # Main MCP server implementation
├── package.json             # Node.js dependencies and scripts
├── package-lock.json        # Dependency lock file
├── .env                     # Environment configuration (not in git)
├── node_modules/            # Dependencies (not in git)
└── README.md               # This documentation
```

## 📄 License

MIT License

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
   PROXMOX_PORT=8006
   PROXMOX_ALLOW_ELEVATED=false  # Set to 'true' for advanced features
   ```

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
2. Navigate to Datacenter -> Permissions -> API Tokens
3. Create a new API token:
   - Select a user (e.g., root@pam)
   - Enter a token ID (e.g., "mcp-token")
   - Uncheck "Privilege Separation" if you want full access
   - Save and copy both the token ID and secret


## 🚀 Running the Server

### Direct Execution
```bash
node index.js
```

### Claude Code Integration

Add this to your Claude Code MCP configuration:

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

The server will automatically load environment variables from `.env` files in the current directory or parent directories.

# 🔧 Available Tools

The server provides the following MCP tools for interacting with Proxmox:

### proxmox_get_nodes
Lists all nodes in the Proxmox cluster.

- Parameters: None
- Example Response:
  ```
  🖥️ Proxmox Nodes

  🖥️ pve-compute-01
    • Status: ONLINE
    • Uptime: ⏳ 156d 12h
    • CPU Cores: 64
    • Memory: 186.5 GB / 512.0 GB (36.4%)

  🖥️ pve-compute-02
    • Status: ONLINE
    • Uptime: ⏳ 156d 11h
    • CPU Cores: 64
    • Memory: 201.3 GB / 512.0 GB (39.3%)
  ```

### proxmox_get_node_status
Get detailed status of a specific node.

- Parameters:
  - `node` (string, required): Name of the node
- Example Response:
  ```
  🖥️ Node: pve-compute-01
    • Status: ONLINE
    • Uptime: ⏳ 156d 12h
    • CPU Usage: 42.3%
    • CPU Cores: 64 (AMD EPYC 7763)
    • Memory: 186.5 GB / 512.0 GB (36.4%)
    • Network: ⬆️ 12.8 GB/s ⬇️ 9.2 GB/s
    • Temperature: 38°C
  ```

### proxmox_get_vms
List all VMs across the cluster.

- Parameters: None
- Example Response:
  ```
  🗃️ Virtual Machines

  🗃️ prod-db-master (ID: 100)
    • Status: RUNNING
    • Node: pve-compute-01
    • CPU Cores: 16
    • Memory: 92.3 GB / 128.0 GB (72.1%)

  🗃️ prod-web-01 (ID: 102)
    • Status: RUNNING
    • Node: pve-compute-01
    • CPU Cores: 8
    • Memory: 12.8 GB / 32.0 GB (40.0%)
  ```

### proxmox_get_storage
List available storage.

- Parameters: None
- Example Response:
  ```
  💾 Storage Pools

  💾 ceph-prod
    • Status: ONLINE
    • Type: rbd
    • Usage: 12.8 TB / 20.0 TB (64.0%)
    • IOPS: ⬆️ 15.2k ⬇️ 12.8k

  💾 local-zfs
    • Status: ONLINE
    • Type: zfspool
    • Usage: 3.2 TB / 8.0 TB (40.0%)
    • IOPS: ⬆️ 42.8k ⬇️ 35.6k
  ```

### proxmox_get_cluster_status
Get overall cluster status.

- Parameters: None
- Example Response:
  ```
  ⚙️ Proxmox Cluster

    • Name: enterprise-cloud
    • Status: HEALTHY
    • Quorum: OK
    • Nodes: 4 ONLINE
    • Version: 8.1.3
    • HA Status: ACTIVE
    • Resources:
      - Total CPU Cores: 192
      - Total Memory: 1536 GB
      - Total Storage: 70 TB
    • Workload:
      - Running VMs: 7
      - Total VMs: 8
      - Average CPU Usage: 38.6%
      - Average Memory Usage: 42.8%
  ```

### proxmox_execute_vm_command
Execute a command in a VM's console using QEMU Guest Agent.

- Parameters:
  - `node` (string, required): Name of the node where VM is running
  - `vmid` (string, required): ID of the VM
  - `command` (string, required): Command to execute
- Example Response:
  ```
  🔧 Console Command Result
    • Status: SUCCESS
    • Command: systemctl status nginx
    • Node: pve-compute-01
    • VM: prod-web-01 (ID: 102)

  Output:
  ● nginx.service - A high performance web server and a reverse proxy server
     Loaded: loaded (/lib/systemd/system/nginx.service; enabled; vendor preset: enabled)
     Active: active (running) since Tue 2025-02-18 15:23:45 UTC; 2 months 3 days ago
  ```
- Requirements:
  - VM must be running
  - QEMU Guest Agent must be installed and running in the VM
  - Command execution permissions must be enabled in the Guest Agent
- Error Handling:
  - Returns error if VM is not running
  - Returns error if VM is not found
  - Returns error if command execution fails
  - Includes command output even if command returns non-zero exit code

## 👨‍💻 Development

Development commands:

- Install dependencies: `npm install`
- Run server: `npm start`
- Test server: `echo '{"jsonrpc": "2.0", "id": 1, "method": "tools/list"}' | node index.js`

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

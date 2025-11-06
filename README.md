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
  - ⚠️ **Default: Read-only mode** - Safe for production use
  - ⚠️ **Elevated mode: Enables 49 destructive operations** - Use with extreme caution
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

2. Create `.env` file in the **parent directory** of your installation:
   ```bash
   # If you cloned to: /home/user/mcp-proxmox
   # Create .env at:    /home/user/.env

   cd ..
   nano .env  # or use your preferred editor
   ```

3. Add your Proxmox configuration to `.env`:
   ```bash
   # Proxmox Configuration (REQUIRED)
   PROXMOX_HOST=your-proxmox-ip-or-hostname
   PROXMOX_USER=root@pam
   PROXMOX_TOKEN_NAME=your-token-name
   PROXMOX_TOKEN_VALUE=your-token-secret-here

   # Security Settings (REQUIRED)
   PROXMOX_ALLOW_ELEVATED=false  # Set to 'true' for advanced features

   # ⚠️  WARNING: Setting PROXMOX_ALLOW_ELEVATED=true enables DESTRUCTIVE operations
   # This allows creating, deleting, modifying VMs/containers, snapshots, backups, etc.
   # Only enable if you understand the security implications!

   # Optional Settings (can be omitted)
   # PROXMOX_PORT=8006  # Defaults to 8006
   ```

   **Important Notes**:
   - The `.env` file MUST be placed in the parent directory of the `mcp-proxmox` installation
   - `PROXMOX_TOKEN_VALUE` is REQUIRED - there is no default value
   - `PROXMOX_HOST` defaults to `192.168.6.247` if not specified (change this!)
   - `PROXMOX_TOKEN_NAME` defaults to `mcpserver` if not specified

   **⚠️ Security Warning**:
   - `PROXMOX_ALLOW_ELEVATED=false` is the SAFE default - only read operations allowed
   - `PROXMOX_ALLOW_ELEVATED=true` enables 49 DESTRUCTIVE tools that can:
     - Create, delete, start, stop, reboot VMs and containers
     - Delete snapshots and backups
     - Modify disk configurations, network settings, and resource allocations
     - Execute commands inside VMs/containers
   - **Only set to `true` if you fully understand and accept these risks**

### Permission Levels

**Basic Mode** (`PROXMOX_ALLOW_ELEVATED=false`):
- List cluster nodes and their status
- List VMs and containers
- View storage pools
- Basic cluster health overview
- Requires minimal API token permissions

**Elevated Mode** (`PROXMOX_ALLOW_ELEVATED=true`):
- ⚠️ **WARNING: Enables destructive operations** - Use with caution!
- All basic features plus:
- Detailed node resource metrics
- VM command execution
- Advanced cluster statistics
- **Create/Delete VMs and containers** (requires `VM.Allocate`)
- **Start/Stop/Reboot/Shutdown** (requires `VM.PowerMgmt`)
- **Snapshot and backup management** (requires `VM.Snapshot`, `VM.Backup`)
- **Disk and network configuration** (requires `VM.Config`)
- Recommended API token permissions: `Sys.Audit`, `VM.Monitor`, `VM.Console`, `VM.Allocate`, `VM.PowerMgmt`, `VM.Snapshot`, `VM.Backup`, `VM.Config`, `Datastore.Audit`, `Datastore.Allocate`

### Verifying Installation

1. Return to the mcp-proxmox directory:
   ```bash
   cd mcp-proxmox
   ```

2. Test the MCP server:
   ```bash
   echo '{"jsonrpc": "2.0", "id": 1, "method": "tools/list"}' | node index.js
   ```

3. Test a basic API call:
   ```bash
   echo '{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "proxmox_get_nodes", "arguments": {}}}' | node index.js
   ```

   You should see either:
   - A successful list of your Proxmox nodes
   - Or an error message - if you see "Could not load .env file", verify the .env file is in the parent directory

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

### Claude Desktop Integration

#### Config File Location

Add the configuration to your Claude Desktop config file:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux**: `~/.config/Claude/claude_desktop_config.json`

#### Option 1: Using External .env File (Recommended)

```json
{
  "mcpServers": {
    "proxmox": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-proxmox/index.js"]
    }
  }
}
```

**Important - Environment File Location**:
- Replace `/absolute/path/to/mcp-proxmox` with the actual path to your installation
- The server loads environment variables from `../../.env` relative to `index.js`
- **This means**: If your installation is at `/home/user/mcp-proxmox`, place `.env` at `/home/user/.env`
- **Example directory structure**:
  ```
  /home/user/
  ├── .env                 ← Environment file goes here
  └── mcp-proxmox/
      ├── index.js         ← Server looks for ../../.env from here
      ├── package.json
      └── README.md
  ```

#### Option 2: Inline Environment Variables

Alternatively, you can specify environment variables directly in the config:

```json
{
  "mcpServers": {
    "proxmox": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-proxmox/index.js"],
      "env": {
        "PROXMOX_HOST": "your-proxmox-ip",
        "PROXMOX_USER": "root@pam",
        "PROXMOX_TOKEN_NAME": "mcp-server",
        "PROXMOX_TOKEN_VALUE": "your-token-secret",
        "PROXMOX_ALLOW_ELEVATED": "false",
        "PROXMOX_PORT": "8006"
      }
    }
  }
}
```

**After adding the configuration**:
1. Restart Claude Desktop
2. Verify the server is loaded in Claude Desktop → Settings → Developer → MCP Servers
3. Test by asking Claude: "List my Proxmox VMs"

### Other MCP Clients

For Claude Code, MCP Inspector, or other MCP clients, use the stdio transport configuration shown above, adjusting paths as needed for your environment.

# 🔧 Available Tools

The server provides 55 MCP tools for interacting with Proxmox:

**Read-Only Tools** (Basic Mode):
- `proxmox_get_nodes` - List cluster nodes
- `proxmox_get_vms` - List all VMs and containers
- `proxmox_get_vm_status` - Get VM details
- `proxmox_get_storage` - View storage pools
- `proxmox_get_cluster_status` - Cluster overview

**Advanced Tools** (Elevated Mode):
- `proxmox_get_node_status` - Detailed node metrics
- `proxmox_execute_vm_command` - Run commands in VMs
- `proxmox_list_templates` - List LXC templates
- `proxmox_get_next_vmid` - Get next available VM/Container ID
- `proxmox_create_lxc` - Create LXC container
- `proxmox_create_vm` - Create QEMU virtual machine
- `proxmox_start_lxc` / `proxmox_start_vm` - Start container/VM
- `proxmox_stop_lxc` / `proxmox_stop_vm` - Stop container/VM
- `proxmox_reboot_lxc` / `proxmox_reboot_vm` - Reboot container/VM
- `proxmox_shutdown_lxc` / `proxmox_shutdown_vm` - Gracefully shutdown container/VM
- `proxmox_pause_vm` / `proxmox_resume_vm` - Pause/resume VM (QEMU only)
- `proxmox_clone_lxc` / `proxmox_clone_vm` - Clone container/VM
- `proxmox_resize_lxc` / `proxmox_resize_vm` - Resize container/VM resources
- `proxmox_create_snapshot_lxc` / `proxmox_create_snapshot_vm` - Create snapshot
- `proxmox_list_snapshots_lxc` / `proxmox_list_snapshots_vm` - List snapshots
- `proxmox_rollback_snapshot_lxc` / `proxmox_rollback_snapshot_vm` - Rollback to snapshot
- `proxmox_delete_snapshot_lxc` / `proxmox_delete_snapshot_vm` - Delete snapshot
- `proxmox_create_backup_lxc` / `proxmox_create_backup_vm` - Create backup
- `proxmox_list_backups` - List all backups on storage
- `proxmox_restore_backup_lxc` / `proxmox_restore_backup_vm` - Restore from backup
- `proxmox_delete_backup` - Delete backup file
- `proxmox_add_disk_vm` - Add disk to QEMU VM
- `proxmox_add_mountpoint_lxc` - Add mount point to LXC container
- `proxmox_resize_disk_vm` / `proxmox_resize_disk_lxc` - Resize disk/mount point
- `proxmox_remove_disk_vm` / `proxmox_remove_mountpoint_lxc` - Remove disk/mount point
- `proxmox_move_disk_vm` / `proxmox_move_disk_lxc` - Move disk between storage
- `proxmox_add_network_vm` / `proxmox_add_network_lxc` - Add network interface
- `proxmox_update_network_vm` / `proxmox_update_network_lxc` - Update network interface
- `proxmox_remove_network_vm` / `proxmox_remove_network_lxc` - Remove network interface
- `proxmox_delete_lxc` / `proxmox_delete_vm` - Delete container/VM

---

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

### proxmox_list_templates
List available LXC container templates on a storage.

- Parameters:
  - `node` (string, required): Node name
  - `storage` (string, optional): Storage name, default: 'local'
- Example Response:
  ```
  📦 **Available LXC Templates**

  • **local:vztmpl/debian-12-standard_12.2-1_amd64.tar.gz**
    Size: 129.50 MB

  • **local:vztmpl/ubuntu-22.04-standard_22.04-1_amd64.tar.gz**
    Size: 142.30 MB
  ```
- Requirements:
  - API token with `Datastore.Audit` or `Datastore.AllocateSpace` permissions

### proxmox_create_lxc
Create a new LXC container (requires elevated permissions).

- Parameters:
  - `node` (string, required): Node name where container will be created
  - `vmid` (string, required): VM ID number (must be unique)
  - `ostemplate` (string, required): OS template path (e.g., `local:vztmpl/debian-12-standard_12.2-1_amd64.tar.gz`)
  - `hostname` (string, optional): Container hostname
  - `password` (string, optional): Root password, default: 'proxmox'
  - `memory` (number, optional): RAM in MB, default: 512
  - `storage` (string, optional): Storage location, default: 'local-lvm'
  - `rootfs` (string, optional): Root filesystem size in GB, default: '8'
- Example Response:
  ```
  ✅ **LXC Container Creation Started**

  • **VM ID**: 100
  • **Hostname**: ct100
  • **Node**: pve1
  • **Template**: local:vztmpl/debian-12-standard_12.2-1_amd64.tar.gz
  • **Memory**: 512 MB
  • **Storage**: local-lvm
  • **Task ID**: UPID:pve1:00001234:...

  **Next steps**:
  1. Wait a moment for container to be created
  2. Start it with `proxmox_start_vm`
  3. View status with `proxmox_get_vm_status`
  ```
- Requirements:
  - `PROXMOX_ALLOW_ELEVATED=true`
  - API token with `VM.Allocate` permission
  - Valid LXC template available on storage

### proxmox_create_vm
Create a new QEMU virtual machine (requires elevated permissions).

- Parameters:
  - `node` (string, required): Node name where VM will be created
  - `vmid` (string, required): VM ID number (must be unique)
  - `name` (string, optional): VM name, default: `vm{vmid}`
  - `memory` (number, optional): RAM in MB, default: 512
  - `cores` (number, optional): Number of CPU cores, default: 1
  - `sockets` (number, optional): Number of CPU sockets, default: 1
  - `disk_size` (string, optional): Disk size (e.g., "8G", "20G"), default: '8G'
  - `storage` (string, optional): Storage location for disk, default: 'local-lvm'
  - `iso` (string, optional): ISO image path (e.g., "local:iso/alpine-virt-3.19.1-x86_64.iso")
  - `ostype` (string, optional): OS type (l26=Linux 2.6+, win10, etc), default: 'l26'
  - `net0` (string, optional): Network interface config, default: 'virtio,bridge=vmbr0'
- Example Response:
  ```
  ✅ **QEMU VM Creation Started**

  • **VM ID**: 200
  • **Name**: test-vm
  • **Node**: pve1
  • **Memory**: 1024 MB
  • **CPU**: 1 socket(s), 2 core(s)
  • **Disk**: local-lvm:20
  • **Network**: virtio,bridge=vmbr0
  • **ISO**: local:iso/debian-12.iso
  • **Task ID**: UPID:pve1:00001234:...

  **Next steps**:
  1. Wait a moment for VM to be created
  2. Start it with `proxmox_start_vm`
  3. View status with `proxmox_get_vm_status`
  ```
- Requirements:
  - `PROXMOX_ALLOW_ELEVATED=true`
  - API token with `VM.Allocate` permission
  - Sufficient storage space available
- Example Usage:
  ```bash
  # Create a minimal VM
  proxmox_create_vm(node="pve1", vmid="200", name="test-vm")

  # Create a VM with custom resources and ISO
  proxmox_create_vm(
    node="pve1",
    vmid="201",
    name="ubuntu-server",
    memory=2048,
    cores=2,
    disk_size="20G",
    iso="local:iso/ubuntu-22.04-server-amd64.iso"
  )
  ```

### proxmox_start_lxc / proxmox_start_vm
Start an LXC container or QEMU virtual machine (requires elevated permissions).

- Parameters:
  - `node` (string, required): Node name where VM/container is located
  - `vmid` (string, required): VM/Container ID number
- **Note**: Use `proxmox_start_lxc` for containers, `proxmox_start_vm` for VMs
- Example Response:
  ```
  ▶️  **VM/Container Start Command Sent**

  • **VM ID**: 100
  • **Type**: LXC
  • **Node**: pve1
  • **Task ID**: UPID:pve1:00001235:...

  **Tip**: Use `proxmox_get_vm_status` to check if it's running.
  ```
- Requirements:
  - `PROXMOX_ALLOW_ELEVATED=true`
  - API token with `VM.PowerMgmt` permission

### proxmox_stop_lxc / proxmox_stop_vm
Stop an LXC container or QEMU virtual machine (requires elevated permissions).

- Parameters:
  - `node` (string, required): Node name where VM/container is located
  - `vmid` (string, required): VM/Container ID number
- **Note**: Use `proxmox_stop_lxc` for containers, `proxmox_stop_vm` for VMs
- Example Response:
  ```
  ⏹️  **VM/Container Stop Command Sent**

  • **VM ID**: 100
  • **Type**: LXC
  • **Node**: pve1
  • **Task ID**: UPID:pve1:00001236:...

  **Tip**: Use `proxmox_get_vm_status` to confirm it's stopped.
  ```
- Requirements:
  - `PROXMOX_ALLOW_ELEVATED=true`
  - API token with `VM.PowerMgmt` permission

### proxmox_delete_lxc / proxmox_delete_vm
Delete an LXC container or QEMU virtual machine (requires elevated permissions).

- Parameters:
  - `node` (string, required): Node name where VM/container is located
  - `vmid` (string, required): VM/Container ID number to delete
- Example Response:
  ```
  🗑️  **VM/Container Deletion Started**

  • **VM/Container ID**: 200
  • **Type**: LXC
  • **Node**: pve1
  • **Task ID**: UPID:pve1:002A3E96:...

  **Note**: Deletion may take a moment to complete.
  ```
- Requirements:
  - `PROXMOX_ALLOW_ELEVATED=true`
  - VM/Container must be stopped first
  - API token with `VM.Allocate` permission
- **Note**: Use `proxmox_delete_lxc` for containers, `proxmox_delete_vm` for VMs

### proxmox_get_next_vmid
Get the next available VM/Container ID number.

- Parameters: None
- Example Response:
  ```
  **Next Available VM/Container ID**: 102
  ```
- Use Case: Call this before creating a new VM/container to avoid ID conflicts

### proxmox_reboot_lxc / proxmox_reboot_vm
Reboot an LXC container or QEMU virtual machine (requires elevated permissions).

- Parameters:
  - `node` (string, required): Node name where VM/container is located
  - `vmid` (string, required): VM/Container ID number
- **Note**: Use `proxmox_reboot_lxc` for containers, `proxmox_reboot_vm` for VMs
- Example Response:
  ```
  🔄 **VM/Container Reboot Command Sent**

  • **VM ID**: 115
  • **Type**: LXC
  • **Node**: pve1
  • **Task ID**: UPID:pve1:002A62C2:...

  **Tip**: The VM/container will restart momentarily.
  ```
- Requirements:
  - `PROXMOX_ALLOW_ELEVATED=true`
  - API token with `VM.PowerMgmt` permission
  - VM/Container must be running

### proxmox_shutdown_lxc / proxmox_shutdown_vm
Gracefully shutdown an LXC container or QEMU virtual machine (requires elevated permissions).

- Parameters:
  - `node` (string, required): Node name where VM/container is located
  - `vmid` (string, required): VM/Container ID number
- **Note**: Use `proxmox_shutdown_lxc` for containers, `proxmox_shutdown_vm` for VMs
- Difference from `stop`: Shutdown sends a clean shutdown signal (like pressing power button), while stop forcefully halts the VM
- Example Response:
  ```
  ⏸️  **VM/Container Shutdown Command Sent**

  • **VM ID**: 115
  • **Type**: LXC
  • **Node**: pve1
  • **Task ID**: UPID:pve1:002A632A:...

  **Note**: This is a graceful shutdown. Use `proxmox_stop_vm` for forceful stop.
  ```
- Requirements:
  - `PROXMOX_ALLOW_ELEVATED=true`
  - API token with `VM.PowerMgmt` permission
  - VM/Container must be running

### proxmox_pause_vm / proxmox_resume_vm
Pause or resume a QEMU virtual machine (requires elevated permissions). **Note**: Only available for QEMU VMs, not LXC containers.

- Parameters:
  - `node` (string, required): Node name where VM is located
  - `vmid` (string, required): VM ID number
- **Note**: Pause suspends VM execution without shutting down, resume continues execution
- Example Response (pause):
  ```
  ⏸️  **VM Pause Command Sent**

  • **VM ID**: 101
  • **Type**: QEMU
  • **Node**: pve1
  • **Task ID**: UPID:pve1:...

  **Tip**: Use `proxmox_resume_vm` to continue execution.
  ```
- Example Response (resume):
  ```
  ▶️  **VM Resume Command Sent**

  • **VM ID**: 101
  • **Type**: QEMU
  • **Node**: pve1
  • **Task ID**: UPID:pve1:...

  **Note**: VM execution will continue from paused state.
  ```
- Requirements:
  - `PROXMOX_ALLOW_ELEVATED=true`
  - API token with `VM.PowerMgmt` permission
  - VM must be running (for pause) or paused (for resume)
  - **QEMU VMs only** - not supported for LXC containers

### proxmox_clone_lxc / proxmox_clone_vm
Clone an LXC container or QEMU virtual machine (requires elevated permissions).

- Parameters:
  - `node` (string, required): Node name where source VM/container is located
  - `vmid` (string, required): Source VM/Container ID number to clone from
  - `newid` (string, required): New VM/Container ID for the clone
  - `name` (string, optional): Name for the new clone
  - `full` (boolean, optional): Create full clone instead of linked clone, default: false
- **Note**: Use `proxmox_clone_lxc` for containers, `proxmox_clone_vm` for VMs
- Example Response:
  ```
  📋 **VM/Container Clone Started**

  • **Source ID**: 100
  • **New ID**: 105
  • **Type**: LXC
  • **Node**: pve1
  • **Clone Type**: linked
  • **Task ID**: UPID:pve1:...

  **Tip**: Use `proxmox_get_vm_status` to check clone status.
  ```
- Requirements:
  - `PROXMOX_ALLOW_ELEVATED=true`
  - API token with `VM.Allocate` and `VM.Clone` permissions
  - Source VM/container should be stopped for best results
  - New ID must not already exist

### proxmox_resize_lxc / proxmox_resize_vm
Resize CPU and memory resources for an LXC container or QEMU virtual machine (requires elevated permissions).

- Parameters:
  - `node` (string, required): Node name where VM/container is located
  - `vmid` (string, required): VM/Container ID number
  - `cores` (number, optional): Number of CPU cores to allocate
  - `memory` (number, optional): Memory in MB to allocate
- **Note**: Use `proxmox_resize_lxc` for containers, `proxmox_resize_vm` for VMs
- At least one parameter (cores or memory) must be specified
- Example Response:
  ```
  ⚙️  **VM/Container Resize Complete**

  • **VM ID**: 100
  • **Type**: LXC
  • **Node**: pve1
  • **New Cores**: 2
  • **New Memory**: 1024 MB

  **Note**: Changes may require VM/container restart to take effect.
  ```
- Requirements:
  - `PROXMOX_ALLOW_ELEVATED=true`
  - API token with `VM.Config` or `VM.Allocate` permissions
  - VM/container can be running or stopped (hot-resize supported for some settings)

### proxmox_create_snapshot_lxc / proxmox_create_snapshot_vm
Create a snapshot of an LXC container or QEMU virtual machine (requires elevated permissions).

- Parameters:
  - `node` (string, required): Node name where VM/container is located
  - `vmid` (string, required): VM/Container ID number
  - `snapname` (string, required): Name for the snapshot
- **Note**: Use `proxmox_create_snapshot_lxc` for containers, `proxmox_create_snapshot_vm` for VMs
- Example Response:
  ```
  📸 **Snapshot Creation Started**

  • **VM ID**: 115
  • **Snapshot Name**: test-snapshot-1
  • **Type**: LXC
  • **Node**: pve1
  • **Task ID**: UPID:pve1:002A7ECF:...

  **Tip**: Use `proxmox_list_snapshots_lxc` to view all snapshots.
  ```
- Requirements:
  - `PROXMOX_ALLOW_ELEVATED=true`
  - API token with `VM.Snapshot` permission
  - Sufficient storage space for snapshot
- Use Case: Create point-in-time backups before making changes

### proxmox_list_snapshots_lxc / proxmox_list_snapshots_vm
List all snapshots for an LXC container or QEMU virtual machine (requires elevated permissions).

- Parameters:
  - `node` (string, required): Node name where VM/container is located
  - `vmid` (string, required): VM/Container ID number
- **Note**: Use `proxmox_list_snapshots_lxc` for containers, `proxmox_list_snapshots_vm` for VMs
- Example Response:
  ```
  📋 **Snapshots for LXC 115**

  • **test-snapshot-1**
    Created: 11/6/2025, 9:05:11 AM

  • **before-update**
    Created: 11/5/2025, 2:30:45 PM
    Description: Snapshot before system update

  **Total**: 2 snapshot(s)
  ```
- Requirements:
  - `PROXMOX_ALLOW_ELEVATED=true`
  - API token with `VM.Audit` permission

### proxmox_rollback_snapshot_lxc / proxmox_rollback_snapshot_vm
Rollback an LXC container or QEMU virtual machine to a previous snapshot (requires elevated permissions).

- Parameters:
  - `node` (string, required): Node name where VM/container is located
  - `vmid` (string, required): VM/Container ID number
  - `snapname` (string, required): Name of the snapshot to rollback to
- **Note**: Use `proxmox_rollback_snapshot_lxc` for containers, `proxmox_rollback_snapshot_vm` for VMs
- **Warning**: This will revert the VM/container to the snapshot state. Any changes made after the snapshot was created will be lost.
- Example Response:
  ```
  ⏮️  **Snapshot Rollback Started**

  • **VM ID**: 115
  • **Snapshot Name**: test-snapshot-1
  • **Type**: LXC
  • **Node**: pve1
  • **Task ID**: UPID:pve1:...

  ⚠️  **Warning**: This will revert to the snapshot state. Data created after this snapshot will be lost.
  ```
- Requirements:
  - `PROXMOX_ALLOW_ELEVATED=true`
  - API token with `VM.Snapshot` permission
  - VM/container must be stopped (for most cases)
  - Snapshot must exist

### proxmox_delete_snapshot_lxc / proxmox_delete_snapshot_vm
Delete a snapshot from an LXC container or QEMU virtual machine (requires elevated permissions).

- Parameters:
  - `node` (string, required): Node name where VM/container is located
  - `vmid` (string, required): VM/Container ID number
  - `snapname` (string, required): Name of the snapshot to delete
- **Note**: Use `proxmox_delete_snapshot_lxc` for containers, `proxmox_delete_snapshot_vm` for VMs
- Example Response:
  ```
  🗑️  **Snapshot Deletion Started**

  • **VM ID**: 115
  • **Snapshot Name**: test-snapshot-1
  • **Type**: LXC
  • **Node**: pve1
  • **Task ID**: UPID:pve1:002A7F81:...

  **Note**: Snapshot deletion may take a moment to complete.
  ```
- Requirements:
  - `PROXMOX_ALLOW_ELEVATED=true`
  - API token with `VM.Snapshot` permission
  - Snapshot must exist
- Use Case: Free up storage space by removing old snapshots

### proxmox_create_backup_lxc / proxmox_create_backup_vm
Create a backup of an LXC container or QEMU virtual machine (requires elevated permissions).

- Parameters:
  - `node` (string, required): Node name where VM/container is located
  - `vmid` (string, required): VM/Container ID number
  - `storage` (string, optional): Storage for backup, default: 'local'
  - `mode` (string, optional): Backup mode ('snapshot', 'suspend', 'stop'), default: 'snapshot'
  - `compress` (string, optional): Compression ('none', 'lzo', 'gzip', 'zstd'), default: 'zstd'
- **Note**: Use `proxmox_create_backup_lxc` for containers, `proxmox_create_backup_vm` for VMs
- Backup Modes:
  - **snapshot**: Quick backup using snapshots (recommended, minimal downtime)
  - **suspend**: Suspends VM during backup (ensures consistency)
  - **stop**: Stops VM during backup (maximum consistency, maximum downtime)
- Example Response:
  ```
  💾 **Backup Creation Started**

  • **VM ID**: 115
  • **Type**: LXC
  • **Node**: pve1
  • **Storage**: local
  • **Mode**: snapshot
  • **Compression**: zstd
  • **Task ID**: UPID:pve1:002A9368:...

  **Tip**: Backup runs in the background. Use `proxmox_list_backups` to view all backups.
  ```
- Requirements:
  - `PROXMOX_ALLOW_ELEVATED=true`
  - API token with `VM.Backup` permission
  - Sufficient storage space for backup
  - For snapshot mode: Storage must support snapshots
- Use Case: Create full backups for disaster recovery

### proxmox_list_backups
List all backup files on a storage (works for both LXC and VM backups).

- Parameters:
  - `node` (string, required): Node name
  - `storage` (string, optional): Storage name, default: 'local'
- **Note**: This is a unified tool that lists all backup types
- Example Response:
  ```
  📦 **Backups on local**

  • **vzdump-lxc-115-2025_11_06-09_12_00.tar.zst**
    VM ID: 115 (LXC)
    Size: 409.42 MB
    Created: 11/6/2025, 9:12:00 AM
    Volume: local:backup/vzdump-lxc-115-2025_11_06-09_12_00.tar.zst

  • **vzdump-qemu-101-2025_11_05-14_30_00.vma.zst**
    VM ID: 101 (QEMU)
    Size: 2.15 GB
    Created: 11/5/2025, 2:30:00 PM
    Volume: local:backup/vzdump-qemu-101-2025_11_05-14_30_00.vma.zst

  **Total**: 2 backup(s)
  ```
- Requirements:
  - `PROXMOX_ALLOW_ELEVATED=true`
  - API token with `Datastore.Audit` permission

### proxmox_restore_backup_lxc / proxmox_restore_backup_vm
Restore an LXC container or QEMU virtual machine from a backup file (requires elevated permissions).

- Parameters:
  - `node` (string, required): Node name where VM/container will be restored
  - `vmid` (string, required): New VM/Container ID for the restored instance
  - `archive` (string, required): Backup file path (e.g., 'local:backup/vzdump-lxc-115-2025_11_06-09_12_00.tar.zst')
  - `storage` (string, optional): Storage location for restored VM/container
- **Note**: Use `proxmox_restore_backup_lxc` for LXC backups, `proxmox_restore_backup_vm` for VM backups
- **Important**: This creates a NEW VM/container with the specified vmid, it does not overwrite the original
- Example Response:
  ```
  ♻️  **Backup Restore Started**

  • **New VM ID**: 116
  • **Archive**: local:backup/vzdump-lxc-115-2025_11_06-09_12_00.tar.zst
  • **Type**: LXC
  • **Node**: pve1
  • **Task ID**: UPID:pve1:...

  **Tip**: Use `proxmox_get_vm_status` to check restore progress.
  **Note**: The restored VM/container will have the new ID specified, not the original ID from the backup.
  ```
- Requirements:
  - `PROXMOX_ALLOW_ELEVATED=true`
  - API token with `VM.Allocate` permission
  - Valid backup archive file exists
  - New vmid must not already be in use
  - Sufficient storage space for restore
- Use Case: Recover from backup or clone VM/container from backup

### proxmox_delete_backup
Delete a backup file from storage (works for both LXC and VM backups).

- Parameters:
  - `node` (string, required): Node name
  - `storage` (string, required): Storage name
  - `volume` (string, required): Full backup volume path (e.g., 'local:backup/vzdump-lxc-115-2025_11_06-09_12_00.tar.zst')
- **Note**: This is a unified tool that deletes any backup type
- Example Response:
  ```
  🗑️  **Backup Deletion Started**

  • **Node**: pve1
  • **Storage**: local
  • **Volume**: local:backup/vzdump-lxc-115-2025_11_06-09_12_00.tar.zst
  • **Task ID**: UPID:pve1:002A94BA:...

  **Note**: Backup file will be permanently deleted from storage.
  ```
- Requirements:
  - `PROXMOX_ALLOW_ELEVATED=true`
  - API token with `Datastore.Allocate` or `Datastore.AllocateSpace` permission
  - Backup file must exist
- **Warning**: This permanently deletes the backup file and cannot be undone
- Use Case: Free up storage space by removing old backups

### proxmox_add_disk_vm
Add a new disk to a QEMU virtual machine (requires elevated permissions).

- Parameters:
  - `node` (string, required): Node name where VM is located
  - `vmid` (string, required): VM ID number
  - `disk` (string, required): Disk identifier (e.g., 'scsi1', 'virtio1', 'sata1', 'ide1')
  - `storage` (string, required): Storage name (e.g., 'local-lvm')
  - `size` (string, required): Disk size in GB (e.g., '10')
- **Note**: QEMU VMs only, not for LXC containers
- Disk naming conventions:
  - **SCSI**: scsi0-15 (most common, supports TRIM/discard)
  - **VirtIO**: virtio0-15 (best performance)
  - **SATA**: sata0-5
  - **IDE**: ide0-3 (legacy)
- Example Response:
  ```
  💿 **Disk Added to VM**

  • **VM ID**: 101
  • **Disk**: scsi1
  • **Storage**: local-lvm
  • **Size**: 10 GB
  • **Node**: pve1

  **Tip**: VM may need to be stopped to add disks.
  ```
- Requirements:
  - `PROXMOX_ALLOW_ELEVATED=true`
  - API token with `VM.Config` permission
  - VM should be stopped
  - Disk identifier must not already exist
  - Sufficient storage space

### proxmox_add_mountpoint_lxc
Add a mount point to an LXC container (requires elevated permissions).

- Parameters:
  - `node` (string, required): Node name where container is located
  - `vmid` (string, required): Container ID number
  - `mp` (string, required): Mount point identifier (e.g., 'mp0', 'mp1', 'mp2')
  - `storage` (string, required): Storage name (e.g., 'local-lvm')
  - `size` (string, required): Mount point size in GB (e.g., '10')
- **Note**: LXC containers only, not for QEMU VMs
- Mount point naming: mp0-255
- Example Response:
  ```
  💿 **Mount Point Added to Container**

  • **Container ID**: 115
  • **Mount Point**: mp0
  • **Storage**: local-lvm
  • **Size**: 10 GB
  • **Node**: pve1

  **Tip**: Container may need to be stopped to add mount points.
  ```
- Requirements:
  - `PROXMOX_ALLOW_ELEVATED=true`
  - API token with `VM.Config` permission
  - Container should be stopped
  - Mount point identifier must not already exist

### proxmox_resize_disk_vm / proxmox_resize_disk_lxc
Resize a disk on a QEMU VM or LXC container (requires elevated permissions).

- Parameters:
  - `node` (string, required): Node name where VM/container is located
  - `vmid` (string, required): VM/Container ID number
  - `disk` (string, required): Disk identifier (e.g., 'scsi0', 'virtio0', 'rootfs', 'mp0')
  - `size` (string, required): New size ('+10G' for relative, '50G' for absolute)
- **Note**: Use `proxmox_resize_disk_vm` for VMs, `proxmox_resize_disk_lxc` for containers
- Size format:
  - Relative: '+10G' (adds 10GB to current size)
  - Absolute: '50G' (sets size to exactly 50GB)
- Example Response:
  ```
  📏 **Disk Resized**

  • **VM ID**: 101
  • **Disk**: scsi0
  • **New Size**: +10G
  • **Node**: pve1

  **Note**: Disk has been expanded. You may need to resize the filesystem inside the VM.
  **Tip**: Use tools like 'growpart' and 'resize2fs' inside the VM to expand the filesystem.
  ```
- Requirements:
  - `PROXMOX_ALLOW_ELEVATED=true`
  - API token with `VM.Config` permission
  - Can only increase size, not decrease
  - Some configurations support online resize (VirtIO/SCSI)
- **Important**: Resizing only expands the disk, you must resize the filesystem inside the VM/container

### proxmox_remove_disk_vm / proxmox_remove_mountpoint_lxc
Remove a disk from a QEMU VM or mount point from an LXC container (requires elevated permissions).

- Parameters:
  - `node` (string, required): Node name where VM/container is located
  - `vmid` (string, required): VM/Container ID number
  - `disk` or `mp` (string, required): Disk/mount point identifier to remove
- **Note**: Use `proxmox_remove_disk_vm` for VMs, `proxmox_remove_mountpoint_lxc` for containers
- **Warning**: This removes the disk configuration. Data may be deleted depending on storage type.
- Example Response:
  ```
  ➖ **Disk Removed from VM**

  • **VM ID**: 101
  • **Disk**: scsi1
  • **Node**: pve1

  ⚠️  **Warning**: Disk configuration removed. Data deletion depends on storage settings.
  ```
- Requirements:
  - `PROXMOX_ALLOW_ELEVATED=true`
  - API token with `VM.Config` permission
  - VM/container should be stopped
  - Cannot remove primary disk (scsi0/rootfs)
- Use Case: Remove unused disks to free configuration slots

### proxmox_move_disk_vm / proxmox_move_disk_lxc
Move a disk/volume to different storage (requires elevated permissions).

- Parameters:
  - `node` (string, required): Node name where VM/container is located
  - `vmid` (string, required): VM/Container ID number
  - `disk` (string, required): Disk identifier (e.g., 'scsi0', 'rootfs', 'mp0')
  - `storage` (string, required): Target storage name
  - `delete` (boolean, optional): Delete source after move, default: true
- **Note**: Use `proxmox_move_disk_vm` for VMs, `proxmox_move_disk_lxc` for containers
- Example Response:
  ```
  📦 **Disk Move Started**

  • **VM ID**: 101
  • **Disk**: scsi0
  • **Target Storage**: local-lvm
  • **Delete Source**: true
  • **Node**: pve1
  • **Task ID**: UPID:pve1:...

  **Tip**: This operation may take time depending on disk size.
  ```
- Requirements:
  - `PROXMOX_ALLOW_ELEVATED=true`
  - API token with `VM.Config` and `Datastore.Allocate` permissions
  - VM/container should be stopped
  - Sufficient space on target storage
  - Source and target must be different storage
- Use Case: Migrate disks between storage types (e.g., HDD to SSD) or rebalance storage

### proxmox_add_network_vm / proxmox_add_network_lxc
Add a network interface to a QEMU VM or LXC container (requires elevated permissions).

- Parameters (VM):
  - `node` (string, required): Node name where VM is located
  - `vmid` (string, required): VM ID number
  - `net` (string, required): Network interface identifier (e.g., 'net0', 'net1')
  - `bridge` (string, required): Bridge name (e.g., 'vmbr0', 'vmbr1')
  - `model` (string, optional): Network model ('virtio', 'e1000', 'rtl8139', 'vmxnet3'), default: 'virtio'
  - `macaddr` (string, optional): MAC address (auto-generated if not specified)
  - `vlan` (number, optional): VLAN tag (1-4094)
  - `firewall` (boolean, optional): Enable firewall for this interface
- Parameters (LXC):
  - `node` (string, required): Node name where container is located
  - `vmid` (string, required): Container ID number
  - `net` (string, required): Network interface identifier (e.g., 'net0', 'net1')
  - `bridge` (string, required): Bridge name (e.g., 'vmbr0')
  - `ip` (string, optional): IP address ('dhcp', '192.168.1.100/24', or 'auto')
  - `gw` (string, optional): Gateway address (e.g., '192.168.1.1')
  - `firewall` (boolean, optional): Enable firewall for this interface
- **Note**: Use `proxmox_add_network_vm` for VMs, `proxmox_add_network_lxc` for containers
- Network Models (VM):
  - **virtio**: Best performance (recommended)
  - **e1000**: Intel E1000 (good compatibility)
  - **rtl8139**: Realtek (legacy)
  - **vmxnet3**: VMware paravirtualized
- Example Response (VM):
  ```
  🌐 **Network Interface Added to VM**

  • **VM ID**: 101
  • **Interface**: net1
  • **Bridge**: vmbr0
  • **Model**: virtio
  • **Node**: pve1

  **Tip**: VM may need to be restarted for changes to take effect.
  ```
- Example Response (LXC):
  ```
  🌐 **Network Interface Added to Container**

  • **Container ID**: 115
  • **Interface**: net1 (eth1)
  • **Bridge**: vmbr0
  • **IP**: dhcp
  • **Node**: pve1

  **Tip**: Container may need to be restarted for changes to take effect.
  ```
- Requirements:
  - `PROXMOX_ALLOW_ELEVATED=true`
  - API token with `VM.Config` permission
  - VM/container should be stopped for best results
  - Interface identifier must not already exist
  - Bridge must exist on the node

### proxmox_update_network_vm / proxmox_update_network_lxc
Update/modify an existing network interface on a QEMU VM or LXC container (requires elevated permissions).

- Parameters (VM):
  - `node` (string, required): Node name where VM is located
  - `vmid` (string, required): VM ID number
  - `net` (string, required): Network interface to update (e.g., 'net0')
  - `bridge` (string, optional): New bridge name
  - `model` (string, optional): New network model
  - `macaddr` (string, optional): New MAC address
  - `vlan` (number, optional): New VLAN tag
  - `firewall` (boolean, optional): Enable/disable firewall
- Parameters (LXC):
  - `node` (string, required): Node name where container is located
  - `vmid` (string, required): Container ID number
  - `net` (string, required): Network interface to update (e.g., 'net0')
  - `bridge` (string, optional): New bridge name
  - `ip` (string, optional): New IP address
  - `gw` (string, optional): New gateway
  - `firewall` (boolean, optional): Enable/disable firewall
- **Note**: Only provided parameters will be updated; others remain unchanged
- Example Response:
  ```
  🔧 **Network Interface Updated**

  • **VM ID**: 101
  • **Interface**: net0
  • **Updated**: bridge, firewall
  • **Node**: pve1

  **Tip**: VM may need to be restarted for changes to take effect.
  ```
- Requirements:
  - `PROXMOX_ALLOW_ELEVATED=true`
  - API token with `VM.Config` permission
  - Interface must already exist
  - VM/container should be stopped for best results

### proxmox_remove_network_vm / proxmox_remove_network_lxc
Remove a network interface from a QEMU VM or LXC container (requires elevated permissions).

- Parameters:
  - `node` (string, required): Node name where VM/container is located
  - `vmid` (string, required): VM/Container ID number
  - `net` (string, required): Network interface to remove (e.g., 'net1')
- **Note**: Use `proxmox_remove_network_vm` for VMs, `proxmox_remove_network_lxc` for containers
- **Warning**: Cannot remove the only network interface (net0 if it's the only one)
- Example Response:
  ```
  ➖ **Network Interface Removed**

  • **VM ID**: 101
  • **Interface**: net1
  • **Node**: pve1

  **Tip**: VM may need to be restarted for changes to take effect.
  ```
- Requirements:
  - `PROXMOX_ALLOW_ELEVATED=true`
  - API token with `VM.Config` permission
  - Interface must exist
  - VM/container should be stopped
  - Should not be the only network interface
- Use Case: Remove unused network interfaces or reconfigure networking

## ✅ Testing Status

The following operations have been tested on a live Proxmox environment:

### Tested Operations ✓
- [x] List nodes (proxmox_get_nodes)
- [x] List VMs and containers (proxmox_get_vms)
- [x] Get VM status (proxmox_get_vm_status)
- [x] Get storage (proxmox_get_storage)
- [x] Create LXC container (proxmox_create_lxc)
- [x] Start LXC container (proxmox_start_lxc)
- [x] Stop LXC container (proxmox_stop_lxc)
- [x] Reboot LXC container (proxmox_reboot_lxc)
- [x] Shutdown LXC container (proxmox_shutdown_lxc)
- [x] Delete LXC container (proxmox_delete_lxc)
- [x] Get next available VMID (proxmox_get_next_vmid)
- [x] Create snapshot (proxmox_create_snapshot_lxc)
- [x] List snapshots (proxmox_list_snapshots_lxc)
- [x] Delete snapshot (proxmox_delete_snapshot_lxc)
- [x] Create backup (proxmox_create_backup_lxc)
- [x] List backups (proxmox_list_backups)
- [x] Delete backup (proxmox_delete_backup)

### Untested Operations (Implementation Complete, Needs Live Testing)
- [ ] VM operations (start_vm, stop_vm, reboot_vm, etc.) - No QEMU VMs available during testing
- [ ] Snapshot rollback (proxmox_rollback_snapshot_lxc/vm)
- [ ] Backup restore (proxmox_restore_backup_lxc/vm)
- [ ] Clone operations (proxmox_clone_lxc/vm)
- [ ] Resize operations (proxmox_resize_lxc/vm)
- [ ] Pause/Resume VM (proxmox_pause_vm/resume_vm)
- [ ] Disk operations (add_disk_vm, resize_disk_vm/lxc, remove_disk_vm, move_disk_vm/lxc)
- [ ] Mount point operations (add_mountpoint_lxc, remove_mountpoint_lxc)
- [ ] Network operations (add_network_vm/lxc, update_network_vm/lxc, remove_network_vm/lxc)
- [ ] VM command execution (proxmox_execute_vm_command)

**Note**: All untested operations follow the same implementation patterns as tested operations and should work correctly. They were not tested due to environment limitations (no QEMU VMs, avoiding destructive operations on production containers).

## 🧪 Testing

### Test Suite

The project includes comprehensive test scripts to validate functionality:

#### test-basic-tools.js
Tests all basic (non-elevated) read-only operations:
- Validates connection to Proxmox
- Tests node listing
- Tests VM/container listing
- Tests storage and cluster status
- Tests template listing
- Tests VM status retrieval

**Usage:**
```bash
node test-basic-tools.js
```

**Expected Result:** 7/7 tests pass (100%)

**Requirements:**
- Valid `.env` configuration
- Working Proxmox connection
- Does NOT require `PROXMOX_ALLOW_ELEVATED=true`

#### test-workflows.js
Comprehensive workflow tests for complete lifecycle operations:

**Available Workflows:**
- **LXC Container**: Create → Start → Snapshot → Stop → Delete
- **VM Lifecycle**: Start, stop, reboot operations
- **Network Management**: Add, update, remove interfaces
- **Disk Management**: Add, resize, remove disks
- **Snapshot Workflow**: Create, list, delete snapshots
- **Backup Workflow**: Create and list backups

**Usage:**
```bash
# Run all workflows
node test-workflows.js

# Run specific workflow
node test-workflows.js --workflow=lxc
node test-workflows.js --workflow=disk
node test-workflows.js --workflow=snapshot

# Dry-run mode (show what would be done)
node test-workflows.js --dry-run

# Interactive mode (confirm before destructive operations)
node test-workflows.js --interactive

# Skip cleanup (keep test resources for inspection)
node test-workflows.js --no-cleanup
```

**Expected Result:** 19-22/22 tests pass (86-100%), depending on environment

**Requirements:**
- Valid `.env` configuration
- `PROXMOX_ALLOW_ELEVATED=true` required
- API token with full permissions (VM.Allocate, VM.Config.*, VM.PowerMgmt, etc.)
- Available LXC templates for container workflow

**Note:** Some tests may fail due to environment limitations (no QEMU VMs, no stopped VMs) or Proxmox API timing issues (snapshot listing delay). These are expected and do not indicate bugs.

### Test Documentation

For detailed information about the test suite, including:
- Individual workflow descriptions
- Troubleshooting guides
- CI/CD integration examples
- Safety features and cleanup behavior

See [TEST-WORKFLOWS.md](./TEST-WORKFLOWS.md)

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

- The server loads environment variables from `../../.env` relative to `index.js`
- Place `.env` file in the parent directory of your `mcp-proxmox` installation
- Use `npm run dev` for development with auto-reload on file changes
- All API calls require a proper `.env` configuration
- Check the server logs (stderr) for connection and permission issues

## 📁 Project Structure

```
/your-installation-path/
├── .env                     # Environment configuration (not in git, MUST be here)
└── mcp-proxmox/
    ├── index.js             # Main MCP server implementation
    ├── package.json         # Node.js dependencies and scripts
    ├── package-lock.json    # Dependency lock file
    ├── node_modules/        # Dependencies (not in git)
    └── README.md            # This documentation
```

**Note**: The `.env` file MUST be in the parent directory of `mcp-proxmox`, not inside it.

## 🔍 Troubleshooting

### "Could not load .env file" Error

**Problem**: Server shows warning: `Warning: Could not load .env file: ENOENT: no such file or directory`

**Solution**:
1. The `.env` file must be in the parent directory of your `mcp-proxmox` installation
2. If you installed to `/path/to/mcp-proxmox`, create `.env` at `/path/to/.env`
3. Verify file location:
   ```bash
   # From mcp-proxmox directory
   ls -la ../.env
   ```

### Connection Refused / Cannot Connect to Proxmox

**Problem**: API calls fail with connection errors

**Solutions**:
- Verify `PROXMOX_HOST` is correct (IP or hostname)
- Ensure `PROXMOX_PORT` matches your Proxmox server (default: 8006)
- Check firewall allows access to Proxmox API port
- Verify Proxmox server is running and accessible

### Permission Denied / 401 Unauthorized

**Problem**: API calls fail with authentication errors

**Solutions**:
- Verify `PROXMOX_TOKEN_VALUE` is correct (copy the full secret)
- Check `PROXMOX_USER` format is correct (e.g., `root@pam`)
- Ensure `PROXMOX_TOKEN_NAME` matches the token ID in Proxmox
- Verify the API token exists in Proxmox: Datacenter → Permissions → API Tokens

### "Requires Elevated Permissions" Messages

**Problem**: Some tools return permission warning messages

**Solution**:
- Set `PROXMOX_ALLOW_ELEVATED=true` in your `.env` file
- Ensure API token has required Proxmox permissions:
  - `Sys.Audit` for node status
  - `VM.Monitor` and `VM.Console` for VM command execution
- In Proxmox: Datacenter → Permissions → Add role permissions to your user/token

### QEMU Guest Agent Commands Fail

**Problem**: `proxmox_execute_vm_command` fails on QEMU VMs

**Solutions**:
- Install QEMU Guest Agent in the VM:
  - Debian/Ubuntu: `apt install qemu-guest-agent`
  - RHEL/CentOS: `yum install qemu-guest-agent`
  - Windows: Install from VirtIO ISO
- Enable guest agent in VM hardware settings
- Restart the VM after installation
- Note: LXC containers don't need guest agent

### MCP Client Cannot Find Server

**Problem**: MCP client shows server connection errors

**Solutions**:
- Verify `cwd` path in MCP configuration is correct
- Ensure Node.js is installed and in PATH
- Check `.env` file is in parent directory of cwd path
- Test server manually: `node index.js` from the `mcp-proxmox` directory

## 📄 License

MIT License

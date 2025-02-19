# 🚀 Proxmox Manager - Proxmox MCP Server

![ProxmoxMCP](https://github.com/user-attachments/assets/e32ab79f-be8a-420c-ab2d-475612150534)

A Python-based Model Context Protocol (MCP) server for interacting with Proxmox hypervisors, providing a clean interface for managing nodes, VMs, and containers.

## 🏗️ Built With

- [Cline](https://github.com/cline/cline) - Autonomous coding agent - Go faster with Cline.
- [Proxmoxer](https://github.com/proxmoxer/proxmoxer) - Python wrapper for Proxmox API
- [MCP SDK](https://github.com/modelcontextprotocol/sdk) - Model Context Protocol SDK
- [Pydantic](https://docs.pydantic.dev/) - Data validation using Python type annotations

## ✨ Features

- 🤖 Full integration with Cline
- 🛠️ Built with the official MCP SDK
- 🔒 Secure token-based authentication with Proxmox
- 🖥️ Tools for managing nodes and VMs
- 💻 VM console command execution
- 📝 Configurable logging system
- ✅ Type-safe implementation with Pydantic
- 🎨 Rich output formatting with customizable themes

## 📦 Installation

### Prerequisites

- Python 3.10 or higher
- Git
- A Proxmox server with API access

### Cline Installation

1. Create a directory for your MCP servers:
   ```bash
   mkdir -p ~/Documents/Cline/MCP
   cd ~/Documents/Cline/MCP
   ```

2. Clone and install the package:
   ```bash
   # Clone the repository
   git clone https://github.com/canvrno/ProxmoxMCP.git
   cd ProxmoxMCP

   # Install UV if not already installed
   pip install uv

   # Create and activate virtual environment, then install dependencies
   uv venv && source .venv/bin/activate && uv pip install -e ".[dev]"
   ```

3. Create and configure Proxmox settings:
   ```bash
   # Create config directory
   mkdir -p proxmox-config
   ```

   Create `proxmox-config/config.json`:
   ```json
   {
       "proxmox": {
           "host": "your-proxmox-host",  # Must be a valid hostname or IP
           "port": 8006,
           "verify_ssl": true,
           "service": "PVE"
       },
       "auth": {
           "user": "your-username@pve",
           "token_name": "your-token-name",
           "token_value": "your-token-value"
       },
       "logging": {
           "level": "INFO",
           "format": "%(asctime)s - %(name)s - %(levelname)s - %(message)s",
           "file": "proxmox_mcp.log"
       }
   }
   ```

4. Add to Cline MCP settings:
   Edit `~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`:
   ```json
   {
     "mcpServers": {
       "github.com/canvrno/ProxmoxMCP": {
         "command": "/absolute/path/to/ProxmoxMCP/.venv/bin/python",
         "args": [
           "-m",
           "proxmox_mcp.server"
         ],
         "cwd": "/absolute/path/to/ProxmoxMCP",
         "env": {
           "PROXMOX_MCP_CONFIG": "/absolute/path/to/ProxmoxMCP/proxmox-config/config.json"
         },
         "disabled": false,
         "autoApprove": []
       }
     }
   }
   ```

   Important: Replace `/absolute/path/to/ProxmoxMCP` with your actual installation path.

### For Manual Installation

1. Create and activate a virtual environment:
   ```bash
   # Linux/macOS
   python3 -m venv .venv
   source .venv/bin/activate

   # Windows (PowerShell)
   python -m venv .venv
   .\.venv\Scripts\Activate.ps1
   ```

2. Install dependencies:
   ```bash
   # Install build tools
   pip install --upgrade pip build wheel setuptools

   # Install MCP SDK first (required)
   pip install git+https://github.com/modelcontextprotocol/python-sdk.git

   # Install package with dev dependencies
   pip install -e ".[dev]"
   ```

3. Create configuration:
   ```bash
   # Create config directory
   mkdir -p proxmox-config

   # Copy example config
   cp config/config.example.json proxmox-config/config.json

   # Edit the config with your Proxmox details
   # See Configuration section below
   ```

### Verifying Installation

1. Check Python environment:
   ```bash
   python -c "import proxmox_mcp; print('Installation OK')"
   ```

2. Run the tests:
   ```bash
   pytest
   ```

3. Verify configuration:
   ```bash
   # Linux/macOS
   PROXMOX_MCP_CONFIG="proxmox-config/config.json" python -m proxmox_mcp.server

   # Windows (PowerShell)
   $env:PROXMOX_MCP_CONFIG="proxmox-config\config.json"; python -m proxmox_mcp.server
   ```

   You should see either:
   - A successful connection to your Proxmox server
   - Or a connection error (if Proxmox details are incorrect)

## ⚙️ Configuration

### Proxmox API Token Setup
1. Log into your Proxmox web interface
2. Navigate to Datacenter -> Permissions -> API Tokens
3. Create a new API token:
   - Select a user (e.g., root@pam)
   - Enter a token ID (e.g., "mcp-token")
   - Uncheck "Privilege Separation" if you want full access
   - Save and copy both the token ID and secret

### Configuration Methods

#### Using JSON Configuration (Recommended)
1. Copy the example configuration:
   ```bash
   cp config/config.example.json proxmox-config/config.json
   ```

2. Edit `proxmox-config/config.json` with your settings (see format above)

#### Using Environment Variables
Set the following environment variables:
```bash
# Required
PROXMOX_HOST=your-host
PROXMOX_USER=username@pve
PROXMOX_TOKEN_NAME=your-token-name
PROXMOX_TOKEN_VALUE=your-token-value

# Optional
PROXMOX_PORT=8006                  # Default: 8006
PROXMOX_VERIFY_SSL=true           # Default: true
PROXMOX_SERVICE=PVE               # Default: PVE
LOG_LEVEL=INFO                    # Default: INFO
LOG_FORMAT=%(asctime)s...         # Default: standard format
LOG_FILE=proxmox_mcp.log         # Default: None (stdout)
```

## 🚀 Running the Server

### Development Mode
For testing and development:
```bash
# Activate virtual environment first
source .venv/bin/activate  # Linux/macOS
# OR
.\.venv\Scripts\Activate.ps1  # Windows

# Run the server
python -m proxmox_mcp.server
```

### Claude Desktop Integration
To install the server in Claude Desktop:
```bash
# Basic installation
mcp install proxmox_mcp/server.py

# Installation with custom name and environment variables
mcp install proxmox_mcp/server.py \
  --name "Proxmox Manager" \
  -v PROXMOX_HOST=your-host \
  -v PROXMOX_USER=username@pve \
  -v PROXMOX_TOKEN_NAME=your-token \
  -v PROXMOX_TOKEN_VALUE=your-secret
```

# 🔧 Available Tools

The server provides the following MCP tools for interacting with Proxmox:

### get_nodes
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

  🖥️ pve-storage-01
    • Status: ONLINE
    • Uptime: ⏳ 156d 12h
    • CPU Cores: 32
    • Memory: 89.2 GB / 256.0 GB (34.8%)

  🖥️ pve-storage-02
    • Status: ONLINE
    • Uptime: ⏳ 156d 12h
    • CPU Cores: 32
    • Memory: 92.8 GB / 256.0 GB (36.2%)
  ```

### get_node_status
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

### get_vms
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

  🗃️ prod-db-replica-01 (ID: 101)
    • Status: RUNNING
    • Node: pve-compute-02
    • CPU Cores: 16
    • Memory: 86.5 GB / 128.0 GB (67.6%)

  🗃️ prod-web-01 (ID: 102)
    • Status: RUNNING
    • Node: pve-compute-01
    • CPU Cores: 8
    • Memory: 12.8 GB / 32.0 GB (40.0%)

  🗃️ prod-web-02 (ID: 103)
    • Status: RUNNING
    • Node: pve-compute-02
    • CPU Cores: 8
    • Memory: 13.2 GB / 32.0 GB (41.3%)

  🗃️ prod-cache-01 (ID: 104)
    • Status: RUNNING
    • Node: pve-compute-01
    • CPU Cores: 4
    • Memory: 24.6 GB / 64.0 GB (38.4%)

  🗃️ prod-cache-02 (ID: 105)
    • Status: RUNNING
    • Node: pve-compute-02
    • CPU Cores: 4
    • Memory: 25.1 GB / 64.0 GB (39.2%)

  🗃️ staging-env (ID: 106)
    • Status: RUNNING
    • Node: pve-compute-02
    • CPU Cores: 32
    • Memory: 48.2 GB / 128.0 GB (37.7%)

  🗃️ dev-env (ID: 107)
    • Status: STOPPED
    • Node: pve-compute-01
    • CPU Cores: 16
    • Memory: 0.0 GB / 64.0 GB (0.0%)
  ```

### get_storage
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

  💾 ceph-backup
    • Status: ONLINE
    • Type: rbd
    • Usage: 28.6 TB / 40.0 TB (71.5%)
    • IOPS: ⬆️ 8.4k ⬇️ 6.2k

  💾 nvme-cache
    • Status: ONLINE
    • Type: lvmthin
    • Usage: 856.2 GB / 2.0 TB (42.8%)
    • IOPS: ⬆️ 125.6k ⬇️ 98.4k

  💾 local-zfs
    • Status: ONLINE
    • Type: zfspool
    • Usage: 3.2 TB / 8.0 TB (40.0%)
    • IOPS: ⬆️ 42.8k ⬇️ 35.6k
  ```

### get_cluster_status
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

### execute_vm_command
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
       Docs: man:nginx(8)
   Main PID: 1234 (nginx)
      Tasks: 64
     Memory: 256.2M
        CPU: 42.6h
     CGroup: /system.slice/nginx.service
             ├─1234 "nginx: master process /usr/sbin/nginx -g daemon on; master_pr..."
             ├─1235 "nginx: worker process" "" "" "" "" "" "" "" "" "" "" "" "" ""
             └─1236 "nginx: worker process" "" "" "" "" "" "" "" "" "" "" "" "" ""
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

After activating your virtual environment:

- Run tests: `pytest`
- Format code: `black .`
- Type checking: `mypy .`
- Lint: `ruff .`

## 📁 Project Structure

```
proxmox-mcp/
├── src/
│   └── proxmox_mcp/
│       ├── server.py          # Main MCP server implementation
│       ├── config/            # Configuration handling
│       ├── core/              # Core functionality
│       ├── formatting/        # Output formatting and themes
│       ├── tools/             # Tool implementations
│       │   └── console/       # VM console operations
│       └── utils/             # Utilities (auth, logging)
├── tests/                     # Test suite
├── config/
│   └── config.example.json    # Configuration template
├── setup.sh                   # Unix setup script
├── setup.ps1                  # Windows setup script
├── pyproject.toml            # Project metadata and dependencies
└── LICENSE                   # MIT License
```

## 📄 License

MIT License

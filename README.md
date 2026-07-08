# Proxmox MCP Server (Node.js Edition)

A Node.js-based Model Context Protocol (MCP) server for managing Proxmox VE hypervisors: nodes, QEMU VMs, and LXC containers, with configurable permission levels and Terraform/OpenTofu export.

## Credits

Based on the original Python implementation by [canvrno/ProxmoxMCP](https://github.com/canvrno/ProxmoxMCP). This Node.js version keeps the same core functionality while adding configurable permission management and Terraform/OpenTofu generation.

## Features

- Two permission levels: read-only by default; destructive operations require an explicit opt-in (`PROXMOX_ALLOW_ELEVATED=true`)
- Node, VM, and container management: status, lifecycle (start/stop/reboot/shutdown/pause), create, clone, resize, delete
- Snapshots and backups: create, list, rollback, delete
- Disk and network configuration: add, resize, move, and remove disks, mount points, and network interfaces
- Terraform/OpenTofu export: generate HCL (with `import` blocks) from existing VMs and containers to adopt them into IaC without recreation
- Markdown-formatted output built on the official MCP SDK

https://github.com/user-attachments/assets/1b5f42f7-85d5-4918-aca4-d38413b0e82b

## Installation

### Prerequisites

- Node.js 18+ and npm
- A Proxmox VE server and an API token (see [API Token Setup](#proxmox-api-token-setup))

### Setup

```bash
git clone https://github.com/gilby125/mcp-proxmox.git
cd mcp-proxmox
npm install
```

## Configuration

The server is configured entirely through environment variables:

| Variable | Required | Default | Description |
|---|---|---|---|
| `PROXMOX_HOST` | yes | — | Proxmox IP or hostname |
| `PROXMOX_TOKEN_VALUE` | yes | — | API token secret |
| `PROXMOX_USER` | no | `root@pam` | User the token belongs to |
| `PROXMOX_TOKEN_NAME` | no | `mcpserver` | API token ID |
| `PROXMOX_PORT` | no | `8006` | Proxmox API port |
| `PROXMOX_ALLOW_ELEVATED` | no | `false` | Set `true` to enable write/destructive tools |

There are two ways to provide them:

### Option 1: env block in your MCP client config (recommended)

For Claude Desktop, edit the config file (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`, Linux: `~/.config/Claude/claude_desktop_config.json`, Windows: `%APPDATA%\Claude\claude_desktop_config.json`):

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
        "PROXMOX_ALLOW_ELEVATED": "false"
      }
    }
  }
}
```

Restart the client after editing, then test by asking: "List my Proxmox VMs".

### Option 2: .env file in the parent directory of the installation

The server loads `.env` from `../.env` relative to `index.js` — i.e. the directory above the cloned repo (kept outside the repo so the secret cannot be committed):

```
/home/user/
├── .env             <- environment file goes here
└── mcp-proxmox/
    └── index.js     <- loads ../.env from here
```

```bash
# /home/user/.env
PROXMOX_HOST=your-proxmox-ip-or-hostname
PROXMOX_USER=root@pam
PROXMOX_TOKEN_NAME=mcp-server
PROXMOX_TOKEN_VALUE=your-token-secret
PROXMOX_ALLOW_ELEVATED=false
```

### Proxmox API Token Setup

1. Proxmox web UI -> Datacenter -> Permissions -> API Tokens -> Add
2. Pick a user (e.g. `root@pam`) and a Token ID (e.g. `mcp-server`)
3. Copy the secret immediately — it is shown only once
4. Use the Token ID as `PROXMOX_TOKEN_NAME` and the secret as `PROXMOX_TOKEN_VALUE`

Permissions: basic (read-only) mode works with minimal token permissions. Elevated mode needs roles covering `Sys.Audit`, `VM.Monitor`, `VM.Console`, `VM.Allocate`, `VM.PowerMgmt`, `VM.Snapshot`, `VM.Backup`, `VM.Config.*`, `Datastore.Audit`, `Datastore.Allocate`, depending on which tools you use.

### Permission Levels

Basic mode (`PROXMOX_ALLOW_ELEVATED=false`, the default) allows only read operations: listing nodes, VMs, containers, storage, cluster status, templates, and generating Terraform.

Elevated mode (`PROXMOX_ALLOW_ELEVATED=true`) additionally enables the write tools that can create, modify, and permanently delete VMs, containers, snapshots, backups, disks, and network interfaces, and execute commands inside guests. Only enable it if you understand and accept those risks.

## Available Tools

### Read-only (always available)

| Tool | Description |
|---|---|
| `proxmox_get_nodes` | List cluster nodes with status and resources |
| `proxmox_get_node_status` | Detailed node status (needs elevated + `Sys.Audit`) |
| `proxmox_get_vms` | List VMs/containers, filterable by node and type |
| `proxmox_get_vm_status` | Detailed status for one VM/container |
| `proxmox_get_storage` | List storage pools and usage |
| `proxmox_get_cluster_status` | Cluster health overview |
| `proxmox_list_templates` | List LXC templates on a storage |
| `proxmox_get_next_vmid` | Next free VM/container ID |
| `proxmox_generate_terraform` | Generate Terraform/OpenTofu HCL from existing guests |

### Elevated (require `PROXMOX_ALLOW_ELEVATED=true`)

| Category | Tools |
|---|---|
| Create | `proxmox_create_vm`, `proxmox_create_lxc` |
| Lifecycle | `proxmox_start_*`, `proxmox_stop_*`, `proxmox_reboot_*`, `proxmox_shutdown_*`, `proxmox_pause_vm`, `proxmox_resume_vm` |
| Clone / resize / delete | `proxmox_clone_*`, `proxmox_resize_*`, `proxmox_delete_*` |
| Snapshots | `proxmox_create_snapshot_*`, `proxmox_list_snapshots_*`, `proxmox_rollback_snapshot_*`, `proxmox_delete_snapshot_*` |
| Backups | `proxmox_create_backup_*`, `proxmox_list_backups`, `proxmox_restore_backup_*`, `proxmox_delete_backup` |
| Disks | `proxmox_add_disk_vm`, `proxmox_add_mountpoint_lxc`, `proxmox_resize_disk_*`, `proxmox_remove_disk_vm`, `proxmox_remove_mountpoint_lxc`, `proxmox_move_disk_*` |
| Network | `proxmox_add_network_*`, `proxmox_update_network_*`, `proxmox_remove_network_*` |
| Guest exec | `proxmox_execute_vm_command` (QEMU via guest agent) |

Tools with a `_*` suffix exist in `_vm` (QEMU) and `_lxc` (container) variants.

### Terraform/OpenTofu export

`proxmox_generate_terraform` reads the live configuration of existing VMs and containers and emits HCL for the [bpg/proxmox](https://registry.terraform.io/providers/bpg/proxmox/latest) provider, including `import` blocks so `terraform plan` / `tofu plan` adopts the running guests instead of recreating them.

Arguments (all optional):

- `node` — export only guests on this node
- `vmid` — export a single VM/container
- `type` — `qemu`, `lxc`, or `all` (default)
- `include_provider` — include `terraform {}` / `provider {}` scaffolding (default `true`)

Example prompt: "Generate terraform for VM 100 on node pve1". Then:

```bash
# save the output as main.tf
terraform init   # or: tofu init
export TF_VAR_proxmox_api_token='user@realm!tokenid=uuid'
terraform plan   # import blocks adopt the existing guests
```

Options the generator cannot map are listed in comments inside each resource block. LXC resources include an `ignore_changes = [operating_system]` lifecycle block because Proxmox does not record the source template, so the placeholder `template_file_id` must not force replacement of an adopted container.

## Testing

```bash
# Unit tests (no Proxmox server needed)
npm test

# Live read-only integration test (needs a configured Proxmox connection)
node test-basic-tools.js

# Live workflow tests — CREATES AND DELETES real resources; needs elevated mode
node test-workflows.js [--dry-run] [--interactive] [--workflow=lxc|disk|snapshot]
```

See [TEST-WORKFLOWS.md](./TEST-WORKFLOWS.md) for workflow test details.

## Development

```bash
npm install
npm start        # run the server
npm run dev      # run with auto-reload
npm test         # unit tests

# Poke the server directly over stdio
echo '{"jsonrpc": "2.0", "id": 1, "method": "tools/list"}' | node index.js
```

The repository also contains an unmaintained Python implementation under `src/` inherited from the upstream project; the active server is `index.js`.

## Known Limitations

- TLS verification is disabled for the Proxmox API connection (self-signed certificates are accepted). Do not point this at untrusted networks.
- `proxmox_execute_vm_command` works for QEMU VMs (via the guest agent) only. The Proxmox HTTP API has no exec endpoint for LXC containers, so the tool returns a clear "not supported" message for `type: lxc` — use SSH or `pct exec` on the host instead.

## Troubleshooting

- "Could not load .env file" warning — harmless if you pass variables via the MCP client `env` block; otherwise put `.env` in the parent directory of the repo (`ls ../.env` from inside `mcp-proxmox`).
- Connection refused / timeout — check `PROXMOX_HOST`, `PROXMOX_PORT` (default 8006), and firewall rules.
- 401 Unauthorized — check `PROXMOX_USER` format (`root@pam`), `PROXMOX_TOKEN_NAME`, and that the secret in `PROXMOX_TOKEN_VALUE` is complete.
- "Requires Elevated Permissions" — set `PROXMOX_ALLOW_ELEVATED=true` and grant the token the roles listed above.
- QEMU command execution fails — install and enable the QEMU guest agent inside the VM (`apt install qemu-guest-agent`), enable it in VM options, and restart the VM.

## License

MIT — see [LICENSE](./LICENSE).

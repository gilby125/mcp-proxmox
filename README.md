# Proxmox MCP Server (Node.js Edition)

A Node.js-based Model Context Protocol (MCP) server for managing Proxmox VE hypervisors: nodes, QEMU VMs, and LXC containers, with configurable permission levels and Terraform/OpenTofu export.

## Credits

Based on the original Python implementation by [canvrno/ProxmoxMCP](https://github.com/canvrno/ProxmoxMCP). This Node.js version keeps the same core functionality while adding configurable permission management and Terraform/OpenTofu generation.

## Features

- Two permission levels: read-only by default; destructive operations require an explicit opt-in (`PROXMOX_ALLOW_ELEVATED=true`)
- Node, VM, and container management: status, lifecycle (start/stop/reboot/shutdown/pause), create, clone, resize, delete, migrate, convert-to-template
- Task tracking: read (and optionally wait on) any task by UPID so mutating operations can confirm they actually finished
- Guest agent integration: run commands and read their stdout/exit code, and discover a running VM's real IP addresses
- Snapshots and backups: create, list, rollback, delete
- Disk and network configuration: add, resize, move, and remove disks, mount points, and network interfaces
- Cloud-init, historical metrics (RRD), and read-only observability of pools, HA resources, and firewall rules
- Terraform/OpenTofu export: generate HCL (with `import` blocks) from existing VMs and containers to adopt them into IaC without recreation
- Structured output: tools return machine-readable `structuredContent` alongside the Markdown text, so agents can chain on the data
- MCP Resources (`proxmox://nodes`, `proxmox://vms`, `proxmox://storage`) and Prompts (provisioning, health check, permission diagnosis)
- Safety rails: optional TLS verification, node/VMID allowlists, and a protection-flag check that blocks deleting protected guests
- Built on the official MCP SDK

## Quick navigation

- [Install or run the server](#installation)
- [Configure credentials and permissions](#configuration)
- [Connect an MCP client](#connect-an-mcp-client)
- [Browse tools and Terraform export](#available-tools)
- [Resources, prompts, and structured output](#resources-and-prompts)
- [Testing and development](#testing)
- [Troubleshooting](#troubleshooting)

## Installation

### Prerequisites

- Node.js 20+ and npm
- A Proxmox VE server and an API token (see [Create a Proxmox API token](#create-a-proxmox-api-token))

### Setup

Clone and install:

```bash
git clone https://github.com/gilby125/mcp-proxmox.git
cd mcp-proxmox
npm install
```

Or run without cloning via `npx`:

```bash
PROXMOX_HOST=your-proxmox-ip PROXMOX_TOKEN_VALUE=your-token-secret npx mcp-proxmox
```

Or with Docker (MCP speaks over stdio, so run attached with `-i`):

```bash
docker build -t mcp-proxmox .
docker run -i --rm \
  -e PROXMOX_HOST=your-proxmox-ip \
  -e PROXMOX_TOKEN_VALUE=your-token-secret \
  mcp-proxmox
```

## Configuration

The server is configured through environment variables. The only required
values are the Proxmox host and API token secret:

| Variable | Required | Default | Description |
|---|---|---|---|
| `PROXMOX_HOST` | yes | — | Proxmox IP or hostname |
| `PROXMOX_TOKEN_VALUE` | yes | — | API token secret |
| `PROXMOX_USER` | no | `root@pam` | User the token belongs to |
| `PROXMOX_TOKEN_NAME` | no | `mcpserver` | API token ID |
| `PROXMOX_PORT` | no | `8006` | Proxmox API port |
| `PROXMOX_ALLOW_ELEVATED` | no | `false` | Set `true` to enable write/destructive tools |
| `PROXMOX_VERIFY_TLS` | no | `false` | Set `true` to verify the Proxmox TLS certificate (use with a CA-signed cert) |
| `PROXMOX_NODE_ALLOWLIST` | no | — | Comma-separated node names the server may touch; empty means no restriction |
| `PROXMOX_VMID_ALLOWLIST` | no | — | Comma-separated VMIDs the server may touch; empty means no restriction |

### Create a Proxmox API token

1. In the Proxmox web UI, go to **Datacenter -> Permissions -> API Tokens -> Add**.
2. Choose a user (for example, `root@pam`) and a Token ID (for example, `mcp-server`).
3. Copy the secret immediately; Proxmox displays it only once.
4. Set the Token ID as `PROXMOX_TOKEN_NAME` and the secret as `PROXMOX_TOKEN_VALUE`.

Basic (read-only) mode works with minimal token permissions. Elevated mode needs
roles covering `Sys.Audit`, `VM.Monitor`, `VM.Console`, `VM.Allocate`,
`VM.PowerMgmt`, `VM.Snapshot`, `VM.Backup`, `VM.Config.*`, `Datastore.Audit`,
and `Datastore.Allocate`, depending on which tools you use.

### Choose a permission level

Basic mode (`PROXMOX_ALLOW_ELEVATED=false`, the default) allows read
operations: listing nodes, VMs, containers, storage, cluster status, templates,
and generating Terraform.

Elevated mode (`PROXMOX_ALLOW_ELEVATED=true`) additionally enables tools that
can create, modify, and permanently delete VMs, containers, snapshots, backups,
disks, and network interfaces, as well as execute commands inside guests. Only
enable it if you understand and accept those risks.

### Provide credentials

You can set credentials in your MCP client configuration, or place them in a
`.env` file one directory above the cloned repository. The server loads this
file from `../.env` relative to `index.js`, keeping secrets outside the repo:

```text
/home/user/
├── .env
└── mcp-proxmox/
    └── index.js
```

```bash
# /home/user/.env
PROXMOX_HOST=your-proxmox-ip-or-hostname
PROXMOX_USER=root@pam
PROXMOX_TOKEN_NAME=mcp-server
PROXMOX_TOKEN_VALUE=your-token-secret
PROXMOX_ALLOW_ELEVATED=false
```

Alternatively, provide the values in the MCP client's `env` block. For
example, in Claude Desktop, edit `claude_desktop_config.json`:

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

## Connect an MCP client

Restart the client after configuring the server, then test by asking: "List my
Proxmox VMs".

### Claude Desktop

Config locations: macOS `~/Library/Application Support/Claude/claude_desktop_config.json`,
Linux `~/.config/Claude/claude_desktop_config.json`, Windows
`%APPDATA%\Claude\claude_desktop_config.json`. Use the configuration example
above and restart Claude Desktop.

### Codex

Codex CLI and the Codex editor extension share MCP configuration. From this
repository, register the local server with:

```bash
codex mcp add proxmox -- node "$PWD/index.js"
codex mcp list
```

To run the Docker image instead (after building it):

```bash
codex mcp add proxmox \
    docker \
  --env PROXMOX_HOST=YOUR_PROXMOX_HOST \
  --env PROXMOX_TOKEN_VALUE=YOUR_TOKEN_SECRET \
  -- docker run -i --rm \
    -e PROXMOX_HOST \
    -e PROXMOX_TOKEN_VALUE \
    mcp-proxmox:latest
```

Set credentials as described in [Provide credentials](#provide-credentials),
then restart the Codex session. To remove the server, run
`codex mcp remove proxmox`.

### GitHub Copilot

#### Copilot CLI

This repository includes two GitHub Copilot CLI configuration templates:

- [Host](.copilot/host/mcp-config.json): runs Node.js directly. Run `npm install`
  first and replace `/path/to/mcp-proxmox/index.js` with the absolute path to
  this checkout's `index.js`.
- [Docker](.copilot/docker/mcp-config.json): runs `mcp-proxmox:latest` over
  stdio and forwards all nine Proxmox environment variables. Build the image
  first with `docker build -t mcp-proxmox:latest .`.

Both templates include all supported environment variables. Fill in
`PROXMOX_HOST`, `PROXMOX_TOKEN_NAME`, and `PROXMOX_TOKEN_VALUE` in the selected
template's `env` block and adjust the optional settings as needed. Do not
commit real credentials.

From the repository root, load **one** template for a Copilot CLI session:

```bash
# Host
copilot --additional-mcp-config @.copilot/host/mcp-config.json

# Docker (alternative)
copilot --additional-mcp-config @.copilot/docker/mcp-config.json
```

These nested templates are not loaded automatically. For a persistent personal
setup, merge the selected `proxmox` entry into `mcpServers` in
`$COPILOT_HOME/mcp-config.json`, or `~/.copilot/mcp-config.json` if
`COPILOT_HOME` is not set, preserving any other configured servers. Restart the
Copilot session after changing credentials or server configuration.

#### VS Code Copilot (global, across workspaces)

Current VS Code versions support a **Copilot Global** configuration shared
with Copilot CLI. This is a personal, user-level configuration, not a file
that must be added to every repository.

1. Prepare **one** of the host or Docker templates above. For the host version,
   install dependencies and use an absolute path to `index.js`, not
   `${workspaceFolder}`: the server must work when another project is open.
   For Docker, build `mcp-proxmox:latest` first.
2. In VS Code, open or create the global file:
   - If `COPILOT_HOME` is set, use `mcp-config.json` inside that directory.
   - Otherwise, use `~/.copilot/mcp-config.json` on Linux/macOS, or
     `%USERPROFILE%\.copilot\mcp-config.json` on Windows.
3. For a new file, copy the entire selected template. For an existing file,
   merge only its `proxmox` entry into the existing `mcpServers` object;
   preserve other servers. Keep `"type": "local"` and the template's `env`
   block. The Docker version also needs all the `-e` arguments so the
   container receives those variables. Fill in the host and token details
   locally; do not commit credentials.
4. Save the file. Open the Command Palette (`Ctrl+Shift+P` on Linux/Windows,
   `Cmd+Shift+P` on macOS), run **MCP: List Servers**, select `proxmox`, and
   start or restart it. Review any trust prompt before approving it. Use the
   server's output to diagnose startup errors.
5. In Copilot Chat, select Agent mode and use **Configure Tools** to enable
   the Proxmox tools you want available.

You can also use **MCP: Add Server** -> **Command (stdio)** and select
**Copilot Global** when asked where to save the configuration, then edit the
generated entry to match your chosen template.

**VS Code user-profile alternative:** If your VS Code version does not offer
**Copilot Global**, or you want a configuration specific to the current
VS Code profile, run **MCP: Open User Configuration**. This opens the profile's
`mcp.json`; it is global across workspaces using that profile. Merge the
selected template with these format changes:

- Rename the top-level `mcpServers` key to `servers`.
- Change the `proxmox` entry's `"type": "local"` to `"type": "stdio"`.
- Omit the CLI-specific `"tools": ["*"]` field; choose tools in Copilot Chat.
- Keep `command`, `args`, and `env` unchanged, including all nine environment
  variables and the absolute host path or Docker forwarding flags.

Configure `proxmox` in only one of these locations to avoid duplicate entries.
Do not use `.vscode/mcp.json` for a global setup: that file is workspace-scoped.
For Remote SSH, WSL, or Dev Containers, ensure Node.js or Docker and the host
path/image are available where the server runs. To configure a server on a
remote machine rather than locally, use **MCP: Open Remote User Configuration**.
See the [official VS Code MCP setup documentation](https://code.visualstudio.com/docs/agent-customization/mcp-servers)
for configuration scopes and supported formats.

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
| `proxmox_get_vm_config` | Full configuration of a VM/container (cores, memory, disks, network, cloud-init) |
| `proxmox_get_task_status` | Status of a task by UPID; optionally wait until it finishes |
| `proxmox_whoami` | Identity the token authenticates as and its effective permissions |
| `proxmox_get_rrd_data` | Historical CPU/memory/disk/network time series (node or guest) |
| `proxmox_get_pools` | Resource pools and their members |
| `proxmox_get_ha_resources` | High-availability resources and desired state |
| `proxmox_get_firewall_rules` | Firewall rules at cluster / node / guest level |
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
| Migrate / template | `proxmox_migrate_vm`, `proxmox_convert_to_template` |
| Cloud-init | `proxmox_set_cloudinit` (QEMU) |
| Guest exec / IPs | `proxmox_execute_vm_command`, `proxmox_get_guest_ips` (QEMU via guest agent) |

Tools with a `_*` suffix exist in `_vm` (QEMU) and `_lxc` (container) variants.

`proxmox_execute_vm_command` polls the guest agent by default (`wait: true`) and returns the command's stdout, stderr, and exit code; pass `wait: false` to return only the PID. `proxmox_migrate_vm` and other long-running operations return a task UPID — feed it to `proxmox_get_task_status` (with `wait: true`) to confirm completion.

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

## Resources and Prompts

Beyond tools, the server exposes MCP **Resources** for browsable, read-only cluster state as JSON — `proxmox://nodes`, `proxmox://vms`, and `proxmox://storage` — and MCP **Prompts** for common workflows: `provision_lxc`, `health_check`, and `diagnose_permissions`.

## Structured output

Every tool returns a Markdown summary for humans plus a `structuredContent` object for programmatic use. For example, `proxmox_get_vms` returns `{ count, vms: [{ vmid, name, type, node, status, cpu, mem, maxmem, ... }] }`. Clients that don't understand `structuredContent` simply render the text.

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

Continuous integration runs `npm test` on Node 20 and 22 via GitHub Actions (`.github/workflows/ci.yml`).

## Known Limitations

- TLS verification defaults to off so the server works with Proxmox's self-signed certificate out of the box. Set `PROXMOX_VERIFY_TLS=true` when you have a CA-signed certificate. Do not point the server at untrusted networks with verification disabled.
- `proxmox_execute_vm_command`, `proxmox_get_guest_ips`, and `proxmox_set_cloudinit` work for QEMU VMs only. The Proxmox HTTP API has no exec/agent endpoint for LXC containers, so command execution returns a clear "not supported" message for `type: lxc` — use SSH or `pct exec` on the host instead.

## Troubleshooting

- "Could not load .env file" warning — harmless if you pass variables via the MCP client `env` block; otherwise put `.env` in the parent directory of the repo (`ls ../.env` from inside `mcp-proxmox`).
- Connection refused / timeout — check `PROXMOX_HOST`, `PROXMOX_PORT` (default 8006), and firewall rules.
- 401 Unauthorized — check `PROXMOX_USER` format (`root@pam`), `PROXMOX_TOKEN_NAME`, and that the secret in `PROXMOX_TOKEN_VALUE` is complete.
- "Requires Elevated Permissions" — set `PROXMOX_ALLOW_ELEVATED=true` and grant the token the roles listed above.
- QEMU command execution fails — install and enable the QEMU guest agent inside the VM (`apt install qemu-guest-agent`), enable it in VM options, and restart the VM.

## License

MIT — see [LICENSE](./LICENSE).

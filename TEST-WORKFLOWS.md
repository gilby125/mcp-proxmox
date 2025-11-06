# Proxmox MCP Workflow Test Scripts

This directory contains comprehensive test scripts for validating Proxmox MCP server functionality.

## Available Test Scripts

### 1. test-basic-tools.js
Tests all basic (non-elevated) read-only tools:
- `proxmox_get_nodes` - List cluster nodes
- `proxmox_get_cluster_status` - Cluster status
- `proxmox_get_vms` - List VMs/containers
- `proxmox_get_vm_status` - VM details
- `proxmox_get_storage` - Storage information
- `proxmox_get_next_vmid` - Get next available VMID
- `proxmox_list_templates` - List LXC templates

**Usage:**
```bash
node test-basic-tools.js
```

**Requirements:**
- Valid `.env` configuration
- Working Proxmox connection
- Does NOT require `PROXMOX_ALLOW_ELEVATED=true`

---

### 2. test-workflows.js
Comprehensive workflow tests for complete lifecycle operations.

**Usage:**
```bash
# Run all workflows
node test-workflows.js

# Run specific workflow
node test-workflows.js --workflow=lxc
node test-workflows.js --workflow=vm
node test-workflows.js --workflow=network
node test-workflows.js --workflow=disk
node test-workflows.js --workflow=snapshot
node test-workflows.js --workflow=backup

# Dry-run mode (show what would be done)
node test-workflows.js --dry-run

# Interactive mode (confirm before destructive operations)
node test-workflows.js --interactive

# Skip cleanup (keep test resources)
node test-workflows.js --no-cleanup

# Combine options
node test-workflows.js --workflow=lxc --interactive --dry-run
```

**Requirements:**
- Valid `.env` configuration
- `PROXMOX_ALLOW_ELEVATED=true` in `.env`
- API token with appropriate permissions:
  - `VM.Allocate` - Create VMs/containers
  - `VM.Config.Disk` - Disk management
  - `VM.Config.Network` - Network management
  - `VM.PowerMgmt` - Start/stop/reboot
  - `VM.Snapshot` - Snapshot operations
  - `VM.Backup` - Backup operations
  - `Datastore.Allocate` - Storage allocation

## Workflows Tested

### LXC Container Complete Workflow
1. Get next available VMID
2. List available templates
3. Create new LXC container
4. Start container
5. Check status
6. Create snapshot
7. List snapshots
8. Stop container
9. Delete snapshot
10. Delete container (cleanup)

**What it validates:**
- Container creation with templates
- Lifecycle management (start/stop)
- Snapshot operations
- Status monitoring
- Resource cleanup

---

### VM Lifecycle Operations
1. Find existing VM
2. Detect VM type (QEMU/LXC)
3. Get detailed status
4. Start (if stopped) or reboot (if running)
5. Verify operations

**What it validates:**
- VM discovery
- Power management operations
- Status checking
- Type detection

---

### Network Management Workflow
1. Find stopped VM
2. Add network interface (net1, bridge vmbr0)
3. Update interface (add rate limit)
4. Remove interface

**What it validates:**
- Network interface addition
- Configuration updates
- Interface removal
- Bridge configuration

**Note:** VM must be stopped for network changes

---

### Disk Management Workflow
1. Find QEMU VM
2. Add new disk (10G on local-lvm)
3. Resize disk (+2G)
4. Remove disk

**What it validates:**
- Disk allocation
- Disk resizing
- Disk removal
- Storage integration

**Note:** Primarily tests QEMU VMs for reliability

---

### Snapshot Workflow
1. Find VM
2. Create snapshot
3. List snapshots
4. Delete snapshot

**What it validates:**
- Snapshot creation
- Snapshot listing
- Snapshot deletion
- Snapshot naming

---

### Backup Workflow
1. Find VM
2. Create backup (to local storage)
3. Wait for background job
4. List backups

**What it validates:**
- Backup job creation
- Background job handling
- Backup listing
- Storage integration

**Note:** Backup restoration is not tested automatically (destructive operation)

## Exit Codes

- `0` - All tests passed
- `1` - One or more tests failed or error occurred

## Test Output

The scripts provide detailed, color-coded output:
- 🟢 **Green** - Success
- 🔴 **Red** - Failure
- 🟡 **Yellow** - Warning
- 🔵 **Blue** - Information
- 🟣 **Magenta** - Headers

Example output:
```
═══════════════════════════════════════════════════════════════════
  LXC Container Complete Workflow
═══════════════════════════════════════════════════════════════════

[12:34:56] ▶ Step 1: Get next available VMID
  ✓ Got VMID: 105

[12:34:57] ▶ Step 2: List available templates
  Node: pve1
  ✓ Templates listed successfully
  ✓ Found template: local:vztmpl/debian-12-standard_12.2-1_amd64.tar.gz

[12:34:58] ▶ Step 3: Create LXC container
  VMID: 105, Template: local:vztmpl/debian-12-standard_12.2-1_amd64.tar.gz
  ✓ Create Container: Container 105 created
```

## Cleanup

By default, `test-workflows.js` automatically cleans up test resources (deletes created VMs/containers) at the end.

**To keep test resources:**
```bash
node test-workflows.js --no-cleanup
```

**Manual cleanup:**
If a test fails or is interrupted, you may need to manually delete test resources:
- Container hostname: `test-mcp-{vmid}`
- Snapshots: `test-snapshot` or `test-snap-{timestamp}`

## Troubleshooting

### "Elevated permissions required"
**Solution:** Set `PROXMOX_ALLOW_ELEVATED=true` in your `.env` file

### "No templates found"
**Solution:** Download LXC templates via Proxmox UI: Storage → local → CT Templates → Download

### "No stopped VMs found" (network workflow)
**Solution:** Stop a VM first, or skip network workflow: `--workflow=lxc`

### "Failed to connect to Proxmox"
**Solution:**
- Check `.env` configuration
- Verify Proxmox API is accessible
- Check API token permissions
- Ensure firewall allows connection

### Tests timing out
**Solution:**
- Increase timeout values in script
- Check Proxmox performance
- Reduce concurrent operations

## Safety Features

1. **Dry-run mode** - Preview operations without executing
2. **Interactive mode** - Confirm before destructive operations
3. **Resource tracking** - Automatic cleanup of created resources
4. **Error handling** - Graceful failure with detailed messages
5. **Status validation** - Verify operations completed successfully

## Best Practices

1. **Start with dry-run:** `node test-workflows.js --dry-run`
2. **Test basic tools first:** `node test-basic-tools.js`
3. **Run one workflow at a time initially:** `--workflow=lxc`
4. **Use interactive mode for production:** `--interactive`
5. **Review cleanup:** Don't use `--no-cleanup` unless debugging
6. **Check permissions:** Ensure API token has all required permissions
7. **Monitor Proxmox:** Watch for resource usage during tests

## Integration with CI/CD

These scripts can be integrated into CI/CD pipelines:

```bash
# Basic connectivity test
node test-basic-tools.js || exit 1

# Full workflow validation (non-interactive)
node test-workflows.js || exit 1

# Or specific workflow
node test-workflows.js --workflow=snapshot || exit 1
```

## Contributing

When adding new workflows:
1. Follow existing pattern (logStep, recordResult)
2. Add cleanup tracking for new resources
3. Include error handling
4. Add to workflow list in main()
5. Document in this README

## License

Same as parent project (MIT)

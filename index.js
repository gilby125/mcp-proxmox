#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import fetch from 'node-fetch';
import https from 'https';
import crypto from 'crypto';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Load environment variables from .env file
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const envPath = join(__dirname, '../.env');

try {
  const envFile = readFileSync(envPath, 'utf8');
  const envVars = envFile.split('\n').filter(line => line.includes('=') && !line.trim().startsWith('#'));
  for (const line of envVars) {
    const [key, ...values] = line.split('=');
    // Validate key is a valid environment variable name (alphanumeric and underscore only)
    if (key && values.length > 0 && /^[A-Z_][A-Z0-9_]*$/.test(key.trim())) {
      // Remove surrounding quotes if present and trim
      let value = values.join('=').trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      process.env[key.trim()] = value;
    }
  }
} catch (error) {
  console.error('Warning: Could not load .env file:', error.message);
}

class ProxmoxServer {
  constructor() {
    this.server = new Server(
      {
        name: 'proxmox-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );
    
    this.proxmoxHost = process.env.PROXMOX_HOST || '192.168.6.247';
    this.proxmoxUser = process.env.PROXMOX_USER || 'root@pam';
    this.proxmoxTokenName = process.env.PROXMOX_TOKEN_NAME || 'mcpserver';
    this.proxmoxTokenValue = process.env.PROXMOX_TOKEN_VALUE;
    this.proxmoxPort = process.env.PROXMOX_PORT || '8006';
    this.allowElevated = process.env.PROXMOX_ALLOW_ELEVATED === 'true';
    
    // Create agent that accepts self-signed certificates
    this.httpsAgent = new https.Agent({
      rejectUnauthorized: false
    });
    
    this.setupToolHandlers();
  }

  // Input validation methods for security
  validateNodeName(node) {
    if (!node || typeof node !== 'string') {
      throw new Error('Node name is required and must be a string');
    }
    // Only allow alphanumeric, hyphens, and underscores
    if (!/^[a-zA-Z0-9\-_]+$/.test(node)) {
      throw new Error('Invalid node name format. Only alphanumeric, hyphens, and underscores allowed');
    }
    if (node.length > 64) {
      throw new Error('Node name too long (max 64 characters)');
    }
    return node;
  }

  validateVMID(vmid) {
    if (!vmid) {
      throw new Error('VM ID is required');
    }
    const id = parseInt(vmid, 10);
    if (isNaN(id) || id < 100 || id > 999999999) {
      throw new Error('Invalid VM ID. Must be a number between 100 and 999999999');
    }
    return id.toString();
  }

  validateCommand(command) {
    if (!command || typeof command !== 'string') {
      throw new Error('Command is required and must be a string');
    }

    // Check for dangerous characters that could be used for command injection
    const dangerousChars = /[;&|`$(){}[\]<>\\]/g;
    if (dangerousChars.test(command)) {
      throw new Error('Command contains potentially dangerous characters: ; & | ` $ ( ) { } [ ] < > \\');
    }

    // Limit command length
    if (command.length > 1000) {
      throw new Error('Command exceeds maximum allowed length (1000 characters)');
    }

    return command;
  }

  generateSecurePassword() {
    // Generate a secure random password using Node.js crypto
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
    let password = '';
    const randomBytes = crypto.randomBytes(16);

    for (let i = 0; i < 16; i++) {
      password += chars[randomBytes[i] % chars.length];
    }
    return password;
  }

  async proxmoxRequest(endpoint, method = 'GET', body = null) {
    const baseUrl = `https://${this.proxmoxHost}:${this.proxmoxPort}/api2/json`;
    const url = `${baseUrl}${endpoint}`;

    const headers = {
      'Authorization': `PVEAPIToken=${this.proxmoxUser}!${this.proxmoxTokenName}=${this.proxmoxTokenValue}`,
      'Content-Type': 'application/json'
    };

    const options = {
      method,
      headers,
      agent: this.httpsAgent
    };

    if (body) {
      options.body = JSON.stringify(body);
    }

    try {
      const response = await fetch(url, options);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Proxmox API error: ${response.status} - ${errorText}`);
      }

      const textResponse = await response.text();
      if (!textResponse.trim()) {
        throw new Error('Empty response from Proxmox API');
      }

      const data = JSON.parse(textResponse);
      return data.data;
    } catch (error) {
      if (error.name === 'SyntaxError') {
        throw new Error(`Failed to parse Proxmox API response: ${error.message}`);
      }
      throw new Error(`Failed to connect to Proxmox: ${error.message}`);
    }
  }

  setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'proxmox_get_nodes',
          description: 'List all Proxmox cluster nodes with their status and resources',
          inputSchema: {
            type: 'object',
            properties: {}
          }
        },
        {
          name: 'proxmox_get_node_status',
          description: 'Get detailed status information for a specific Proxmox node',
          inputSchema: {
            type: 'object',
            properties: {
              node: { type: 'string', description: 'Node name (e.g., pve1, proxmox-node2)' }
            },
            required: ['node']
          }
        },
        {
          name: 'proxmox_get_vms',
          description: 'List all virtual machines across the cluster with their status',
          inputSchema: {
            type: 'object',
            properties: {
              node: { type: 'string', description: 'Optional: filter by specific node' },
              type: { type: 'string', enum: ['qemu', 'lxc', 'all'], description: 'VM type filter', default: 'all' }
            }
          }
        },
        {
          name: 'proxmox_get_vm_status',
          description: 'Get detailed status information for a specific VM',
          inputSchema: {
            type: 'object',
            properties: {
              node: { type: 'string', description: 'Node name where VM is located' },
              vmid: { type: 'string', description: 'VM ID number' },
              type: { type: 'string', enum: ['qemu', 'lxc'], description: 'VM type', default: 'qemu' }
            },
            required: ['node', 'vmid']
          }
        },
        {
          name: 'proxmox_execute_vm_command',
          description: 'Execute a shell command on a virtual machine via Proxmox API',
          inputSchema: {
            type: 'object',
            properties: {
              node: { type: 'string', description: 'Node name where VM is located' },
              vmid: { type: 'string', description: 'VM ID number' },
              command: { type: 'string', description: 'Shell command to execute' },
              type: { type: 'string', enum: ['qemu', 'lxc'], description: 'VM type', default: 'qemu' }
            },
            required: ['node', 'vmid', 'command']
          }
        },
        {
          name: 'proxmox_get_storage',
          description: 'List all storage pools and their usage across the cluster',
          inputSchema: {
            type: 'object',
            properties: {
              node: { type: 'string', description: 'Optional: filter by specific node' }
            }
          }
        },
        {
          name: 'proxmox_get_cluster_status',
          description: 'Get overall cluster status including nodes and resource usage',
          inputSchema: {
            type: 'object',
            properties: {}
          }
        },
        {
          name: 'proxmox_list_templates',
          description: 'List available LXC container templates on a storage',
          inputSchema: {
            type: 'object',
            properties: {
              node: { type: 'string', description: 'Node name' },
              storage: { type: 'string', description: 'Storage name (e.g., local)', default: 'local' }
            },
            required: ['node']
          }
        },
        {
          name: 'proxmox_create_lxc',
          description: 'Create a new LXC container (requires elevated permissions)',
          inputSchema: {
            type: 'object',
            properties: {
              node: { type: 'string', description: 'Node name where container will be created' },
              vmid: { type: 'string', description: 'Container ID number (must be unique, or use proxmox_get_next_vmid)' },
              ostemplate: { type: 'string', description: 'OS template (e.g., local:vztmpl/debian-12-standard_12.2-1_amd64.tar.gz)' },
              hostname: { type: 'string', description: 'Container hostname' },
              password: { type: 'string', description: 'Root password' },
              memory: { type: 'number', description: 'RAM in MB', default: 512 },
              storage: { type: 'string', description: 'Storage location', default: 'local-lvm' },
              rootfs: { type: 'string', description: 'Root filesystem size in GB', default: '8' }
            },
            required: ['node', 'vmid', 'ostemplate']
          }
        },
        {
          name: 'proxmox_create_vm',
          description: 'Create a new QEMU virtual machine (requires elevated permissions)',
          inputSchema: {
            type: 'object',
            properties: {
              node: { type: 'string', description: 'Node name where VM will be created' },
              vmid: { type: 'string', description: 'VM ID number (must be unique, or use proxmox_get_next_vmid)' },
              name: { type: 'string', description: 'VM name' },
              memory: { type: 'number', description: 'RAM in MB', default: 512 },
              cores: { type: 'number', description: 'Number of CPU cores', default: 1 },
              sockets: { type: 'number', description: 'Number of CPU sockets', default: 1 },
              disk_size: { type: 'string', description: 'Disk size (e.g., "8G", "10G")', default: '8G' },
              storage: { type: 'string', description: 'Storage location for disk', default: 'local-lvm' },
              iso: { type: 'string', description: 'ISO image (e.g., "local:iso/alpine-virt-3.19.1-x86_64.iso"), optional' },
              ostype: { type: 'string', description: 'OS type (l26=Linux 2.6+, win10, etc)', default: 'l26' },
              net0: { type: 'string', description: 'Network interface config', default: 'virtio,bridge=vmbr0' }
            },
            required: ['node', 'vmid']
          }
        },
        {
          name: 'proxmox_get_next_vmid',
          description: 'Get the next available VM/Container ID number',
          inputSchema: {
            type: 'object',
            properties: {}
          }
        },
        {
          name: 'proxmox_start_lxc',
          description: 'Start an LXC container (requires elevated permissions)',
          inputSchema: {
            type: 'object',
            properties: {
              node: { type: 'string', description: 'Node name where container is located' },
              vmid: { type: 'string', description: 'Container ID number' }
            },
            required: ['node', 'vmid']
          }
        },
        {
          name: 'proxmox_start_vm',
          description: 'Start a QEMU virtual machine (requires elevated permissions)',
          inputSchema: {
            type: 'object',
            properties: {
              node: { type: 'string', description: 'Node name where VM is located' },
              vmid: { type: 'string', description: 'VM ID number' }
            },
            required: ['node', 'vmid']
          }
        },
        {
          name: 'proxmox_stop_lxc',
          description: 'Stop an LXC container (requires elevated permissions)',
          inputSchema: {
            type: 'object',
            properties: {
              node: { type: 'string', description: 'Node name where container is located' },
              vmid: { type: 'string', description: 'Container ID number' }
            },
            required: ['node', 'vmid']
          }
        },
        {
          name: 'proxmox_stop_vm',
          description: 'Stop a QEMU virtual machine (requires elevated permissions)',
          inputSchema: {
            type: 'object',
            properties: {
              node: { type: 'string', description: 'Node name where VM is located' },
              vmid: { type: 'string', description: 'VM ID number' }
            },
            required: ['node', 'vmid']
          }
        },
        {
          name: 'proxmox_delete_lxc',
          description: 'Delete an LXC container (requires elevated permissions)',
          inputSchema: {
            type: 'object',
            properties: {
              node: { type: 'string', description: 'Node name where container is located' },
              vmid: { type: 'string', description: 'Container ID number to delete' }
            },
            required: ['node', 'vmid']
          }
        },
        {
          name: 'proxmox_delete_vm',
          description: 'Delete a QEMU virtual machine (requires elevated permissions)',
          inputSchema: {
            type: 'object',
            properties: {
              node: { type: 'string', description: 'Node name where VM is located' },
              vmid: { type: 'string', description: 'VM ID number to delete' }
            },
            required: ['node', 'vmid']
          }
        },
        {
          name: 'proxmox_reboot_lxc',
          description: 'Reboot an LXC container (requires elevated permissions)',
          inputSchema: {
            type: 'object',
            properties: {
              node: { type: 'string', description: 'Node name where container is located' },
              vmid: { type: 'string', description: 'Container ID number' }
            },
            required: ['node', 'vmid']
          }
        },
        {
          name: 'proxmox_reboot_vm',
          description: 'Reboot a QEMU virtual machine (requires elevated permissions)',
          inputSchema: {
            type: 'object',
            properties: {
              node: { type: 'string', description: 'Node name where VM is located' },
              vmid: { type: 'string', description: 'VM ID number' }
            },
            required: ['node', 'vmid']
          }
        },
        {
          name: 'proxmox_shutdown_lxc',
          description: 'Gracefully shutdown an LXC container (requires elevated permissions)',
          inputSchema: {
            type: 'object',
            properties: {
              node: { type: 'string', description: 'Node name where container is located' },
              vmid: { type: 'string', description: 'Container ID number' }
            },
            required: ['node', 'vmid']
          }
        },
        {
          name: 'proxmox_shutdown_vm',
          description: 'Gracefully shutdown a QEMU virtual machine (requires elevated permissions)',
          inputSchema: {
            type: 'object',
            properties: {
              node: { type: 'string', description: 'Node name where VM is located' },
              vmid: { type: 'string', description: 'VM ID number' }
            },
            required: ['node', 'vmid']
          }
        },
        {
          name: 'proxmox_pause_vm',
          description: 'Pause a QEMU virtual machine (requires elevated permissions)',
          inputSchema: {
            type: 'object',
            properties: {
              node: { type: 'string', description: 'Node name where VM is located' },
              vmid: { type: 'string', description: 'VM ID number' }
            },
            required: ['node', 'vmid']
          }
        },
        {
          name: 'proxmox_resume_vm',
          description: 'Resume a paused QEMU virtual machine (requires elevated permissions)',
          inputSchema: {
            type: 'object',
            properties: {
              node: { type: 'string', description: 'Node name where VM is located' },
              vmid: { type: 'string', description: 'VM ID number' }
            },
            required: ['node', 'vmid']
          }
        },
        {
          name: 'proxmox_clone_lxc',
          description: 'Clone an LXC container (requires elevated permissions)',
          inputSchema: {
            type: 'object',
            properties: {
              node: { type: 'string', description: 'Node name where container is located' },
              vmid: { type: 'string', description: 'Container ID to clone from' },
              newid: { type: 'string', description: 'New container ID' },
              hostname: { type: 'string', description: 'Hostname for cloned container (optional)' }
            },
            required: ['node', 'vmid', 'newid']
          }
        },
        {
          name: 'proxmox_clone_vm',
          description: 'Clone a QEMU virtual machine (requires elevated permissions)',
          inputSchema: {
            type: 'object',
            properties: {
              node: { type: 'string', description: 'Node name where VM is located' },
              vmid: { type: 'string', description: 'VM ID to clone from' },
              newid: { type: 'string', description: 'New VM ID' },
              name: { type: 'string', description: 'Name for cloned VM (optional)' }
            },
            required: ['node', 'vmid', 'newid']
          }
        },
        {
          name: 'proxmox_resize_lxc',
          description: 'Resize an LXC container CPU/memory (requires elevated permissions)',
          inputSchema: {
            type: 'object',
            properties: {
              node: { type: 'string', description: 'Node name where container is located' },
              vmid: { type: 'string', description: 'Container ID number' },
              memory: { type: 'number', description: 'Memory in MB (optional)' },
              cores: { type: 'number', description: 'Number of CPU cores (optional)' }
            },
            required: ['node', 'vmid']
          }
        },
        {
          name: 'proxmox_resize_vm',
          description: 'Resize a QEMU VM CPU/memory (requires elevated permissions)',
          inputSchema: {
            type: 'object',
            properties: {
              node: { type: 'string', description: 'Node name where VM is located' },
              vmid: { type: 'string', description: 'VM ID number' },
              memory: { type: 'number', description: 'Memory in MB (optional)' },
              cores: { type: 'number', description: 'Number of CPU cores (optional)' }
            },
            required: ['node', 'vmid']
          }
        },
        {
          name: 'proxmox_create_snapshot_lxc',
          description: 'Create a snapshot of an LXC container (requires elevated permissions)',
          inputSchema: {
            type: 'object',
            properties: {
              node: { type: 'string', description: 'Node name where container is located' },
              vmid: { type: 'string', description: 'Container ID number' },
              snapname: { type: 'string', description: 'Snapshot name' }
            },
            required: ['node', 'vmid', 'snapname']
          }
        },
        {
          name: 'proxmox_create_snapshot_vm',
          description: 'Create a snapshot of a QEMU virtual machine (requires elevated permissions)',
          inputSchema: {
            type: 'object',
            properties: {
              node: { type: 'string', description: 'Node name where VM is located' },
              vmid: { type: 'string', description: 'VM ID number' },
              snapname: { type: 'string', description: 'Snapshot name' }
            },
            required: ['node', 'vmid', 'snapname']
          }
        },
        {
          name: 'proxmox_list_snapshots_lxc',
          description: 'List all snapshots of an LXC container (requires elevated permissions)',
          inputSchema: {
            type: 'object',
            properties: {
              node: { type: 'string', description: 'Node name where container is located' },
              vmid: { type: 'string', description: 'Container ID number' }
            },
            required: ['node', 'vmid']
          }
        },
        {
          name: 'proxmox_list_snapshots_vm',
          description: 'List all snapshots of a QEMU virtual machine (requires elevated permissions)',
          inputSchema: {
            type: 'object',
            properties: {
              node: { type: 'string', description: 'Node name where VM is located' },
              vmid: { type: 'string', description: 'VM ID number' }
            },
            required: ['node', 'vmid']
          }
        },
        {
          name: 'proxmox_rollback_snapshot_lxc',
          description: 'Rollback an LXC container to a snapshot (requires elevated permissions)',
          inputSchema: {
            type: 'object',
            properties: {
              node: { type: 'string', description: 'Node name where container is located' },
              vmid: { type: 'string', description: 'Container ID number' },
              snapname: { type: 'string', description: 'Snapshot name to rollback to' }
            },
            required: ['node', 'vmid', 'snapname']
          }
        },
        {
          name: 'proxmox_rollback_snapshot_vm',
          description: 'Rollback a QEMU virtual machine to a snapshot (requires elevated permissions)',
          inputSchema: {
            type: 'object',
            properties: {
              node: { type: 'string', description: 'Node name where VM is located' },
              vmid: { type: 'string', description: 'VM ID number' },
              snapname: { type: 'string', description: 'Snapshot name to rollback to' }
            },
            required: ['node', 'vmid', 'snapname']
          }
        },
        {
          name: 'proxmox_delete_snapshot_lxc',
          description: 'Delete a snapshot of an LXC container (requires elevated permissions)',
          inputSchema: {
            type: 'object',
            properties: {
              node: { type: 'string', description: 'Node name where container is located' },
              vmid: { type: 'string', description: 'Container ID number' },
              snapname: { type: 'string', description: 'Snapshot name to delete' }
            },
            required: ['node', 'vmid', 'snapname']
          }
        },
        {
          name: 'proxmox_delete_snapshot_vm',
          description: 'Delete a snapshot of a QEMU virtual machine (requires elevated permissions)',
          inputSchema: {
            type: 'object',
            properties: {
              node: { type: 'string', description: 'Node name where VM is located' },
              vmid: { type: 'string', description: 'VM ID number' },
              snapname: { type: 'string', description: 'Snapshot name to delete' }
            },
            required: ['node', 'vmid', 'snapname']
          }
        },
        {
          name: 'proxmox_create_backup_lxc',
          description: 'Create a backup of an LXC container (requires elevated permissions)',
          inputSchema: {
            type: 'object',
            properties: {
              node: { type: 'string', description: 'Node name where container is located' },
              vmid: { type: 'string', description: 'Container ID number' },
              storage: { type: 'string', description: 'Storage location for backup', default: 'local' },
              mode: { type: 'string', enum: ['snapshot', 'suspend', 'stop'], description: 'Backup mode', default: 'snapshot' },
              compress: { type: 'string', enum: ['none', 'lzo', 'gzip', 'zstd'], description: 'Compression algorithm', default: 'zstd' }
            },
            required: ['node', 'vmid']
          }
        },
        {
          name: 'proxmox_create_backup_vm',
          description: 'Create a backup of a QEMU virtual machine (requires elevated permissions)',
          inputSchema: {
            type: 'object',
            properties: {
              node: { type: 'string', description: 'Node name where VM is located' },
              vmid: { type: 'string', description: 'VM ID number' },
              storage: { type: 'string', description: 'Storage location for backup', default: 'local' },
              mode: { type: 'string', enum: ['snapshot', 'suspend', 'stop'], description: 'Backup mode', default: 'snapshot' },
              compress: { type: 'string', enum: ['none', 'lzo', 'gzip', 'zstd'], description: 'Compression algorithm', default: 'zstd' }
            },
            required: ['node', 'vmid']
          }
        },
        {
          name: 'proxmox_list_backups',
          description: 'List all backups on a storage (requires elevated permissions)',
          inputSchema: {
            type: 'object',
            properties: {
              node: { type: 'string', description: 'Node name' },
              storage: { type: 'string', description: 'Storage name', default: 'local' }
            },
            required: ['node']
          }
        },
        {
          name: 'proxmox_restore_backup_lxc',
          description: 'Restore an LXC container from backup (requires elevated permissions)',
          inputSchema: {
            type: 'object',
            properties: {
              node: { type: 'string', description: 'Node name where container will be restored' },
              vmid: { type: 'string', description: 'New container ID for restored container' },
              archive: { type: 'string', description: 'Backup archive path (e.g., local:backup/vzdump-lxc-100-2025_11_06-09_00_00.tar.zst)' },
              storage: { type: 'string', description: 'Storage location for restored container (optional)' }
            },
            required: ['node', 'vmid', 'archive']
          }
        },
        {
          name: 'proxmox_restore_backup_vm',
          description: 'Restore a QEMU virtual machine from backup (requires elevated permissions)',
          inputSchema: {
            type: 'object',
            properties: {
              node: { type: 'string', description: 'Node name where VM will be restored' },
              vmid: { type: 'string', description: 'New VM ID for restored VM' },
              archive: { type: 'string', description: 'Backup archive path (e.g., local:backup/vzdump-qemu-100-2025_11_06-09_00_00.vma.zst)' },
              storage: { type: 'string', description: 'Storage location for restored VM (optional)' }
            },
            required: ['node', 'vmid', 'archive']
          }
        },
        {
          name: 'proxmox_delete_backup',
          description: 'Delete a backup file from storage (requires elevated permissions)',
          inputSchema: {
            type: 'object',
            properties: {
              node: { type: 'string', description: 'Node name' },
              storage: { type: 'string', description: 'Storage name (e.g., local)' },
              volume: { type: 'string', description: 'Backup volume ID (e.g., local:backup/vzdump-lxc-100-2025_11_06-09_00_00.tar.zst)' }
            },
            required: ['node', 'storage', 'volume']
          }
        },
        {
          name: 'proxmox_add_disk_vm',
          description: 'Add a new disk to a QEMU virtual machine (requires elevated permissions)',
          inputSchema: {
            type: 'object',
            properties: {
              node: { type: 'string', description: 'Node name where VM is located' },
              vmid: { type: 'string', description: 'VM ID number' },
              disk: { type: 'string', description: 'Disk name (e.g., scsi1, virtio1, sata1, ide1)' },
              storage: { type: 'string', description: 'Storage name (e.g., local-lvm)' },
              size: { type: 'string', description: 'Disk size in GB (e.g., 10)' }
            },
            required: ['node', 'vmid', 'disk', 'storage', 'size']
          }
        },
        {
          name: 'proxmox_add_mountpoint_lxc',
          description: 'Add a mount point to an LXC container (requires elevated permissions)',
          inputSchema: {
            type: 'object',
            properties: {
              node: { type: 'string', description: 'Node name where container is located' },
              vmid: { type: 'string', description: 'Container ID number' },
              mp: { type: 'string', description: 'Mount point name (e.g., mp0, mp1, mp2)' },
              storage: { type: 'string', description: 'Storage name (e.g., local-lvm)' },
              size: { type: 'string', description: 'Mount point size in GB (e.g., 10)' }
            },
            required: ['node', 'vmid', 'mp', 'storage', 'size']
          }
        },
        {
          name: 'proxmox_resize_disk_vm',
          description: 'Resize a QEMU VM disk (requires elevated permissions)',
          inputSchema: {
            type: 'object',
            properties: {
              node: { type: 'string', description: 'Node name where VM is located' },
              vmid: { type: 'string', description: 'VM ID number' },
              disk: { type: 'string', description: 'Disk name (e.g., scsi0, virtio0, sata0, ide0)' },
              size: { type: 'string', description: 'New size with + for relative or absolute (e.g., +10G or 50G)' }
            },
            required: ['node', 'vmid', 'disk', 'size']
          }
        },
        {
          name: 'proxmox_resize_disk_lxc',
          description: 'Resize an LXC container disk or mount point (requires elevated permissions)',
          inputSchema: {
            type: 'object',
            properties: {
              node: { type: 'string', description: 'Node name where container is located' },
              vmid: { type: 'string', description: 'Container ID number' },
              disk: { type: 'string', description: 'Disk name (rootfs, mp0, mp1, etc.)' },
              size: { type: 'string', description: 'New size with + for relative or absolute (e.g., +10G or 50G)' }
            },
            required: ['node', 'vmid', 'disk', 'size']
          }
        },
        {
          name: 'proxmox_remove_disk_vm',
          description: 'Remove a disk from a QEMU virtual machine (requires elevated permissions)',
          inputSchema: {
            type: 'object',
            properties: {
              node: { type: 'string', description: 'Node name where VM is located' },
              vmid: { type: 'string', description: 'VM ID number' },
              disk: { type: 'string', description: 'Disk name to remove (e.g., scsi1, virtio1, sata1, ide1)' }
            },
            required: ['node', 'vmid', 'disk']
          }
        },
        {
          name: 'proxmox_remove_mountpoint_lxc',
          description: 'Remove a mount point from an LXC container (requires elevated permissions)',
          inputSchema: {
            type: 'object',
            properties: {
              node: { type: 'string', description: 'Node name where container is located' },
              vmid: { type: 'string', description: 'Container ID number' },
              mp: { type: 'string', description: 'Mount point name to remove (e.g., mp0, mp1, mp2)' }
            },
            required: ['node', 'vmid', 'mp']
          }
        },
        {
          name: 'proxmox_move_disk_vm',
          description: 'Move a QEMU VM disk to different storage (requires elevated permissions)',
          inputSchema: {
            type: 'object',
            properties: {
              node: { type: 'string', description: 'Node name where VM is located' },
              vmid: { type: 'string', description: 'VM ID number' },
              disk: { type: 'string', description: 'Disk name to move (e.g., scsi0, virtio0, sata0, ide0)' },
              storage: { type: 'string', description: 'Target storage name' },
              delete: { type: 'boolean', description: 'Delete source disk after move (default: true)', default: true }
            },
            required: ['node', 'vmid', 'disk', 'storage']
          }
        },
        {
          name: 'proxmox_move_disk_lxc',
          description: 'Move an LXC container disk to different storage (requires elevated permissions)',
          inputSchema: {
            type: 'object',
            properties: {
              node: { type: 'string', description: 'Node name where container is located' },
              vmid: { type: 'string', description: 'Container ID number' },
              disk: { type: 'string', description: 'Disk/volume name to move (rootfs, mp0, mp1, etc.)' },
              storage: { type: 'string', description: 'Target storage name' },
              delete: { type: 'boolean', description: 'Delete source disk after move (default: true)', default: true }
            },
            required: ['node', 'vmid', 'disk', 'storage']
          }
        },
        {
          name: 'proxmox_add_network_vm',
          description: 'Add network interface to QEMU VM (requires elevated permissions)',
          inputSchema: {
            type: 'object',
            properties: {
              node: { type: 'string', description: 'Node name where VM is located' },
              vmid: { type: 'string', description: 'VM ID number' },
              net: { type: 'string', description: 'Network interface name (net0, net1, net2, etc.)' },
              bridge: { type: 'string', description: 'Bridge name (e.g., vmbr0, vmbr1)' },
              model: { type: 'string', description: 'Network model (virtio, e1000, rtl8139, vmxnet3)', default: 'virtio' },
              macaddr: { type: 'string', description: 'MAC address (XX:XX:XX:XX:XX:XX) - auto-generated if not specified' },
              vlan: { type: 'number', description: 'VLAN tag (1-4094)' },
              firewall: { type: 'boolean', description: 'Enable firewall on this interface' }
            },
            required: ['node', 'vmid', 'net', 'bridge']
          }
        },
        {
          name: 'proxmox_add_network_lxc',
          description: 'Add network interface to LXC container (requires elevated permissions)',
          inputSchema: {
            type: 'object',
            properties: {
              node: { type: 'string', description: 'Node name where container is located' },
              vmid: { type: 'string', description: 'Container ID number' },
              net: { type: 'string', description: 'Network interface name (net0, net1, net2, etc.)' },
              bridge: { type: 'string', description: 'Bridge name (e.g., vmbr0, vmbr1)' },
              ip: { type: 'string', description: 'IP address (dhcp, 192.168.1.100/24, auto)' },
              gw: { type: 'string', description: 'Gateway IP address' },
              firewall: { type: 'boolean', description: 'Enable firewall on this interface' }
            },
            required: ['node', 'vmid', 'net', 'bridge']
          }
        },
        {
          name: 'proxmox_update_network_vm',
          description: 'Update/modify VM network interface configuration (requires elevated permissions)',
          inputSchema: {
            type: 'object',
            properties: {
              node: { type: 'string', description: 'Node name where VM is located' },
              vmid: { type: 'string', description: 'VM ID number' },
              net: { type: 'string', description: 'Network interface name to update (net0, net1, net2, etc.)' },
              bridge: { type: 'string', description: 'Bridge name (e.g., vmbr0, vmbr1)' },
              model: { type: 'string', description: 'Network model (virtio, e1000, rtl8139, vmxnet3)' },
              macaddr: { type: 'string', description: 'MAC address (XX:XX:XX:XX:XX:XX)' },
              vlan: { type: 'number', description: 'VLAN tag (1-4094)' },
              firewall: { type: 'boolean', description: 'Enable firewall on this interface' }
            },
            required: ['node', 'vmid', 'net']
          }
        },
        {
          name: 'proxmox_update_network_lxc',
          description: 'Update/modify LXC network interface configuration (requires elevated permissions)',
          inputSchema: {
            type: 'object',
            properties: {
              node: { type: 'string', description: 'Node name where container is located' },
              vmid: { type: 'string', description: 'Container ID number' },
              net: { type: 'string', description: 'Network interface name to update (net0, net1, net2, etc.)' },
              bridge: { type: 'string', description: 'Bridge name (e.g., vmbr0, vmbr1)' },
              ip: { type: 'string', description: 'IP address (dhcp, 192.168.1.100/24, auto)' },
              gw: { type: 'string', description: 'Gateway IP address' },
              firewall: { type: 'boolean', description: 'Enable firewall on this interface' }
            },
            required: ['node', 'vmid', 'net']
          }
        },
        {
          name: 'proxmox_remove_network_vm',
          description: 'Remove network interface from QEMU VM (requires elevated permissions)',
          inputSchema: {
            type: 'object',
            properties: {
              node: { type: 'string', description: 'Node name where VM is located' },
              vmid: { type: 'string', description: 'VM ID number' },
              net: { type: 'string', description: 'Network interface name to remove (net0, net1, net2, etc.)' }
            },
            required: ['node', 'vmid', 'net']
          }
        },
        {
          name: 'proxmox_remove_network_lxc',
          description: 'Remove network interface from LXC container (requires elevated permissions)',
          inputSchema: {
            type: 'object',
            properties: {
              node: { type: 'string', description: 'Node name where container is located' },
              vmid: { type: 'string', description: 'Container ID number' },
              net: { type: 'string', description: 'Network interface name to remove (net0, net1, net2, etc.)' }
            },
            required: ['node', 'vmid', 'net']
          }
        }
      ]
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'proxmox_get_nodes':
            return await this.getNodes();
            
          case 'proxmox_get_node_status':
            return await this.getNodeStatus(args.node);
            
          case 'proxmox_get_vms':
            return await this.getVMs(args.node, args.type);
            
          case 'proxmox_get_vm_status':
            return await this.getVMStatus(args.node, args.vmid, args.type);
            
          case 'proxmox_execute_vm_command':
            return await this.executeVMCommand(args.node, args.vmid, args.command, args.type);
            
          case 'proxmox_get_storage':
            return await this.getStorage(args.node);
            
          case 'proxmox_get_cluster_status':
            return await this.getClusterStatus();

          case 'proxmox_list_templates':
            return await this.listTemplates(args.node, args.storage);

          case 'proxmox_create_lxc':
            return await this.createLXCContainer(args);

          case 'proxmox_create_vm':
            return await this.createVM(args);

          case 'proxmox_get_next_vmid':
            return await this.getNextVMID();

          case 'proxmox_start_lxc':
            return await this.startVM(args.node, args.vmid, 'lxc');

          case 'proxmox_start_vm':
            return await this.startVM(args.node, args.vmid, 'qemu');

          case 'proxmox_stop_lxc':
            return await this.stopVM(args.node, args.vmid, 'lxc');

          case 'proxmox_stop_vm':
            return await this.stopVM(args.node, args.vmid, 'qemu');

          case 'proxmox_delete_lxc':
            return await this.deleteVM(args.node, args.vmid, 'lxc');

          case 'proxmox_delete_vm':
            return await this.deleteVM(args.node, args.vmid, 'qemu');

          case 'proxmox_reboot_lxc':
            return await this.rebootVM(args.node, args.vmid, 'lxc');

          case 'proxmox_reboot_vm':
            return await this.rebootVM(args.node, args.vmid, 'qemu');

          case 'proxmox_shutdown_lxc':
            return await this.shutdownVM(args.node, args.vmid, 'lxc');

          case 'proxmox_shutdown_vm':
            return await this.shutdownVM(args.node, args.vmid, 'qemu');

          case 'proxmox_pause_vm':
            return await this.pauseVM(args.node, args.vmid);

          case 'proxmox_resume_vm':
            return await this.resumeVM(args.node, args.vmid);

          case 'proxmox_clone_lxc':
            return await this.cloneVM(args.node, args.vmid, args.newid, args.hostname, 'lxc');

          case 'proxmox_clone_vm':
            return await this.cloneVM(args.node, args.vmid, args.newid, args.name, 'qemu');

          case 'proxmox_resize_lxc':
            return await this.resizeVM(args.node, args.vmid, args.memory, args.cores, 'lxc');

          case 'proxmox_resize_vm':
            return await this.resizeVM(args.node, args.vmid, args.memory, args.cores, 'qemu');

          case 'proxmox_create_snapshot_lxc':
            return await this.createSnapshot(args.node, args.vmid, args.snapname, 'lxc');

          case 'proxmox_create_snapshot_vm':
            return await this.createSnapshot(args.node, args.vmid, args.snapname, 'qemu');

          case 'proxmox_list_snapshots_lxc':
            return await this.listSnapshots(args.node, args.vmid, 'lxc');

          case 'proxmox_list_snapshots_vm':
            return await this.listSnapshots(args.node, args.vmid, 'qemu');

          case 'proxmox_rollback_snapshot_lxc':
            return await this.rollbackSnapshot(args.node, args.vmid, args.snapname, 'lxc');

          case 'proxmox_rollback_snapshot_vm':
            return await this.rollbackSnapshot(args.node, args.vmid, args.snapname, 'qemu');

          case 'proxmox_delete_snapshot_lxc':
            return await this.deleteSnapshot(args.node, args.vmid, args.snapname, 'lxc');

          case 'proxmox_delete_snapshot_vm':
            return await this.deleteSnapshot(args.node, args.vmid, args.snapname, 'qemu');

          case 'proxmox_create_backup_lxc':
            return await this.createBackup(args.node, args.vmid, args.storage, args.mode, args.compress, 'lxc');

          case 'proxmox_create_backup_vm':
            return await this.createBackup(args.node, args.vmid, args.storage, args.mode, args.compress, 'qemu');

          case 'proxmox_list_backups':
            return await this.listBackups(args.node, args.storage);

          case 'proxmox_restore_backup_lxc':
            return await this.restoreBackup(args.node, args.vmid, args.archive, args.storage, 'lxc');

          case 'proxmox_restore_backup_vm':
            return await this.restoreBackup(args.node, args.vmid, args.archive, args.storage, 'qemu');

          case 'proxmox_delete_backup':
            return await this.deleteBackup(args.node, args.storage, args.volume);

          case 'proxmox_add_disk_vm':
            return await this.addDiskVM(args.node, args.vmid, args.disk, args.storage, args.size);

          case 'proxmox_add_mountpoint_lxc':
            return await this.addMountPointLXC(args.node, args.vmid, args.mp, args.storage, args.size);

          case 'proxmox_resize_disk_vm':
            return await this.resizeDiskVM(args.node, args.vmid, args.disk, args.size);

          case 'proxmox_resize_disk_lxc':
            return await this.resizeDiskLXC(args.node, args.vmid, args.disk, args.size);

          case 'proxmox_remove_disk_vm':
            return await this.removeDiskVM(args.node, args.vmid, args.disk);

          case 'proxmox_remove_mountpoint_lxc':
            return await this.removeMountPointLXC(args.node, args.vmid, args.mp);

          case 'proxmox_move_disk_vm':
            return await this.moveDiskVM(args.node, args.vmid, args.disk, args.storage, args.delete);

          case 'proxmox_move_disk_lxc':
            return await this.moveDiskLXC(args.node, args.vmid, args.disk, args.storage, args.delete);

          case 'proxmox_add_network_vm':
            return await this.addNetworkVM(args.node, args.vmid, args.net, args.bridge, args.model, args.macaddr, args.vlan, args.firewall);

          case 'proxmox_add_network_lxc':
            return await this.addNetworkLXC(args.node, args.vmid, args.net, args.bridge, args.ip, args.gw, args.firewall);

          case 'proxmox_update_network_vm':
            return await this.updateNetworkVM(args.node, args.vmid, args.net, args.bridge, args.model, args.macaddr, args.vlan, args.firewall);

          case 'proxmox_update_network_lxc':
            return await this.updateNetworkLXC(args.node, args.vmid, args.net, args.bridge, args.ip, args.gw, args.firewall);

          case 'proxmox_remove_network_vm':
            return await this.removeNetworkVM(args.node, args.vmid, args.net);

          case 'proxmox_remove_network_lxc':
            return await this.removeNetworkLXC(args.node, args.vmid, args.net);

          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error: ${error.message}`
            }
          ]
        };
      }
    });
  }

  async getNodes() {
    const nodes = await this.proxmoxRequest('/nodes');
    
    let output = '🖥️  **Proxmox Cluster Nodes**\n\n';
    
    for (const node of nodes) {
      const status = node.status === 'online' ? '🟢' : '🔴';
      const uptime = node.uptime ? this.formatUptime(node.uptime) : 'N/A';
      const cpuUsage = node.cpu ? `${(node.cpu * 100).toFixed(1)}%` : 'N/A';
      const memUsage = node.mem && node.maxmem ? 
        `${this.formatBytes(node.mem)} / ${this.formatBytes(node.maxmem)} (${((node.mem / node.maxmem) * 100).toFixed(1)}%)` : 'N/A';
      
      output += `${status} **${node.node}**\n`;
      output += `   • Status: ${node.status}\n`;
      output += `   • Uptime: ${uptime}\n`;
      output += `   • CPU: ${cpuUsage}\n`;
      output += `   • Memory: ${memUsage}\n`;
      output += `   • Load: ${node.loadavg?.[0]?.toFixed(2) || 'N/A'}\n\n`;
    }
    
    return {
      content: [{ type: 'text', text: output }]
    };
  }

  async getNodeStatus(node) {
    if (!this.allowElevated) {
      return {
        content: [{
          type: 'text',
          text: `⚠️  **Node Status Requires Elevated Permissions**\n\nTo view detailed node status, set \`PROXMOX_ALLOW_ELEVATED=true\` in your .env file and ensure your API token has Sys.Audit permissions.\n\n**Current permissions**: Basic (node listing only)`
        }]
      };
    }

    try {
      // Validate inputs
      const safeNode = this.validateNodeName(node);

      const status = await this.proxmoxRequest(`/nodes/${safeNode}/status`);

      let output = `🖥️  **Node ${safeNode} Status**\n\n`;
      output += `• **Status**: ${status.uptime ? '🟢 Online' : '🔴 Offline'}\n`;
      output += `• **Uptime**: ${status.uptime ? this.formatUptime(status.uptime) : 'N/A'}\n`;
      output += `• **Load Average**: ${status.loadavg?.join(', ') || 'N/A'}\n`;
      output += `• **CPU Usage**: ${status.cpu ? `${(status.cpu * 100).toFixed(1)}%` : 'N/A'}\n`;
      output += `• **Memory**: ${status.memory ?
        `${this.formatBytes(status.memory.used)} / ${this.formatBytes(status.memory.total)} (${((status.memory.used / status.memory.total) * 100).toFixed(1)}%)` : 'N/A'}\n`;
      output += `• **Root Disk**: ${status.rootfs ?
        `${this.formatBytes(status.rootfs.used)} / ${this.formatBytes(status.rootfs.total)} (${((status.rootfs.used / status.rootfs.total) * 100).toFixed(1)}%)` : 'N/A'}\n`;

      return {
        content: [{ type: 'text', text: output }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `❌ **Failed to get node status**\n\nError: ${error.message}`
        }]
      };
    }
  }

  async getVMs(nodeFilter = null, typeFilter = 'all') {
    let vms = [];
    
    if (nodeFilter) {
      const nodeVMs = await this.proxmoxRequest(`/nodes/${nodeFilter}/qemu`);
      const nodeLXCs = await this.proxmoxRequest(`/nodes/${nodeFilter}/lxc`);
      
      if (typeFilter === 'all' || typeFilter === 'qemu') {
        vms.push(...nodeVMs.map(vm => ({ ...vm, type: 'qemu', node: nodeFilter })));
      }
      if (typeFilter === 'all' || typeFilter === 'lxc') {
        vms.push(...nodeLXCs.map(vm => ({ ...vm, type: 'lxc', node: nodeFilter })));
      }
    } else {
      const nodes = await this.proxmoxRequest('/nodes');
      
      for (const node of nodes) {
        if (typeFilter === 'all' || typeFilter === 'qemu') {
          const nodeVMs = await this.proxmoxRequest(`/nodes/${node.node}/qemu`);
          vms.push(...nodeVMs.map(vm => ({ ...vm, type: 'qemu', node: node.node })));
        }
        
        if (typeFilter === 'all' || typeFilter === 'lxc') {
          const nodeLXCs = await this.proxmoxRequest(`/nodes/${node.node}/lxc`);
          vms.push(...nodeLXCs.map(vm => ({ ...vm, type: 'lxc', node: vm.node || node.node })));
        }
      }
    }
    
    let output = '💻 **Virtual Machines**\n\n';
    
    if (vms.length === 0) {
      output += 'No virtual machines found.\n';
    } else {
      for (const vm of vms.sort((a, b) => parseInt(a.vmid) - parseInt(b.vmid))) {
        const status = vm.status === 'running' ? '🟢' : vm.status === 'stopped' ? '🔴' : '🟡';
        const typeIcon = vm.type === 'qemu' ? '🖥️' : '📦';
        const uptime = vm.uptime ? this.formatUptime(vm.uptime) : 'N/A';
        const cpuUsage = vm.cpu ? `${(vm.cpu * 100).toFixed(1)}%` : 'N/A';
        const memUsage = vm.mem && vm.maxmem ? 
          `${this.formatBytes(vm.mem)} / ${this.formatBytes(vm.maxmem)}` : 'N/A';
        
        output += `${status} ${typeIcon} **${vm.name || `VM-${vm.vmid}`}** (ID: ${vm.vmid})\n`;
        output += `   • Node: ${vm.node}\n`;
        output += `   • Status: ${vm.status}\n`;
        output += `   • Type: ${vm.type.toUpperCase()}\n`;
        if (vm.status === 'running') {
          output += `   • Uptime: ${uptime}\n`;
          output += `   • CPU: ${cpuUsage}\n`;
          output += `   • Memory: ${memUsage}\n`;
        }
        output += '\n';
      }
    }
    
    return {
      content: [{ type: 'text', text: output }]
    };
  }

  async getVMStatus(node, vmid, type = 'qemu') {
    try {
      // Validate inputs
      const safeNode = this.validateNodeName(node);
      const safeVMID = this.validateVMID(vmid);

      const vmStatus = await this.proxmoxRequest(`/nodes/${safeNode}/${type}/${safeVMID}/status/current`);

      const status = vmStatus.status === 'running' ? '🟢' : vmStatus.status === 'stopped' ? '🔴' : '🟡';
      const typeIcon = type === 'qemu' ? '🖥️' : '📦';

      let output = `${status} ${typeIcon} **${vmStatus.name || `VM-${safeVMID}`}** (ID: ${safeVMID})\n\n`;
      output += `• **Node**: ${safeNode}\n`;
    output += `• **Status**: ${vmStatus.status}\n`;
    output += `• **Type**: ${type.toUpperCase()}\n`;
    
    if (vmStatus.status === 'running') {
      output += `• **Uptime**: ${vmStatus.uptime ? this.formatUptime(vmStatus.uptime) : 'N/A'}\n`;
      output += `• **CPU Usage**: ${vmStatus.cpu ? `${(vmStatus.cpu * 100).toFixed(1)}%` : 'N/A'}\n`;
      output += `• **Memory**: ${vmStatus.mem && vmStatus.maxmem ? 
        `${this.formatBytes(vmStatus.mem)} / ${this.formatBytes(vmStatus.maxmem)} (${((vmStatus.mem / vmStatus.maxmem) * 100).toFixed(1)}%)` : 'N/A'}\n`;
      output += `• **Disk Read**: ${vmStatus.diskread ? this.formatBytes(vmStatus.diskread) : 'N/A'}\n`;
      output += `• **Disk Write**: ${vmStatus.diskwrite ? this.formatBytes(vmStatus.diskwrite) : 'N/A'}\n`;
      output += `• **Network In**: ${vmStatus.netin ? this.formatBytes(vmStatus.netin) : 'N/A'}\n`;
      output += `• **Network Out**: ${vmStatus.netout ? this.formatBytes(vmStatus.netout) : 'N/A'}\n`;
    }

      return {
        content: [{ type: 'text', text: output }]
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `❌ Failed to get VM status: ${error.message}` }],
        isError: true
      };
    }
  }

  async executeVMCommand(node, vmid, command, type = 'qemu') {
    if (!this.allowElevated) {
      return {
        content: [{
          type: 'text',
          text: `⚠️  **VM Command Execution Requires Elevated Permissions**\n\nTo execute commands on VMs, set \`PROXMOX_ALLOW_ELEVATED=true\` in your .env file and ensure your API token has appropriate VM permissions.\n\n**Current permissions**: Basic (VM listing only)\n**Requested command**: \`${command}\``
        }]
      };
    }

    try {
      // Validate inputs to prevent injection attacks
      const safeNode = this.validateNodeName(node);
      const safeVMID = this.validateVMID(vmid);
      const safeCommand = this.validateCommand(command);

      // For QEMU VMs, we need to use the guest agent
      if (type === 'qemu') {
        const result = await this.proxmoxRequest(`/nodes/${safeNode}/qemu/${safeVMID}/agent/exec`, 'POST', {
          command: safeCommand
        });

        let output = `💻 **Command executed on VM ${safeVMID}**\n\n`;
        output += `**Command**: \`${safeCommand}\`\n`;
        output += `**Result**: Command submitted to guest agent\n`;
        output += `**PID**: ${result.pid || 'N/A'}\n\n`;
        output += `*Note: Use guest agent status to check command completion*`;

        return {
          content: [{ type: 'text', text: output }]
        };
      } else {
        // For LXC containers, we can execute directly
        const result = await this.proxmoxRequest(`/nodes/${safeNode}/lxc/${safeVMID}/exec`, 'POST', {
          command: safeCommand
        });

        let output = `📦 **Command executed on LXC ${safeVMID}**\n\n`;
        output += `**Command**: \`${safeCommand}\`\n`;
        output += `**Output**:\n\`\`\`\n${result || 'Command executed successfully'}\n\`\`\``;

        return {
          content: [{ type: 'text', text: output }]
        };
      }
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `❌ **Failed to execute command on VM ${vmid}**\n\nError: ${error.message}\n\n*Note: Make sure the VM has guest agent installed and running*`
        }]
      };
    }
  }

  async getStorage(nodeFilter = null) {
    let storages = [];
    
    if (nodeFilter) {
      storages = await this.proxmoxRequest(`/nodes/${nodeFilter}/storage`);
      storages = storages.map(storage => ({ ...storage, node: nodeFilter }));
    } else {
      const nodes = await this.proxmoxRequest('/nodes');
      
      for (const node of nodes) {
        const nodeStorages = await this.proxmoxRequest(`/nodes/${node.node}/storage`);
        storages.push(...nodeStorages.map(storage => ({ ...storage, node: node.node })));
      }
    }
    
    let output = '💾 **Storage Pools**\n\n';
    
    if (storages.length === 0) {
      output += 'No storage found.\n';
    } else {
      const uniqueStorages = [];
      const seen = new Set();
      
      for (const storage of storages) {
        const key = `${storage.storage}-${storage.node}`;
        if (!seen.has(key)) {
          seen.add(key);
          uniqueStorages.push(storage);
        }
      }
      
      for (const storage of uniqueStorages.sort((a, b) => a.storage.localeCompare(b.storage))) {
        const enabled = storage.enabled ? '🟢' : '🔴';
        const usagePercent = storage.total && storage.used ? 
          ((storage.used / storage.total) * 100).toFixed(1) : 'N/A';
        
        output += `${enabled} **${storage.storage}**\n`;
        output += `   • Node: ${storage.node}\n`;
        output += `   • Type: ${storage.type || 'N/A'}\n`;
        output += `   • Content: ${storage.content || 'N/A'}\n`;
        if (storage.total && storage.used) {
          output += `   • Usage: ${this.formatBytes(storage.used)} / ${this.formatBytes(storage.total)} (${usagePercent}%)\n`;
        }
        output += `   • Status: ${storage.enabled ? 'Enabled' : 'Disabled'}\n\n`;
      }
    }
    
    return {
      content: [{ type: 'text', text: output }]
    };
  }

  async getClusterStatus() {
    try {
      const nodes = await this.proxmoxRequest('/nodes');
      
      // Try to get cluster status, but fall back gracefully if permissions are insufficient
      let clusterStatus = null;
      if (this.allowElevated) {
        try {
          clusterStatus = await this.proxmoxRequest('/cluster/status');
        } catch (error) {
          // Ignore cluster status errors for elevated permissions
        }
      }
      
      let output = '🏗️  **Proxmox Cluster Status**\n\n';
      
      // Cluster overview
      const onlineNodes = nodes.filter(n => n.status === 'online').length;
      const totalNodes = nodes.length;
      
      output += `**Cluster Health**: ${onlineNodes === totalNodes ? '🟢 Healthy' : '🟡 Warning'}\n`;
      output += `**Nodes**: ${onlineNodes}/${totalNodes} online\n\n`;
      
      if (this.allowElevated) {
        // Resource summary (only available with elevated permissions)
        let totalCpu = 0, usedCpu = 0;
        let totalMem = 0, usedMem = 0;
        
        for (const node of nodes) {
          if (node.status === 'online') {
            totalCpu += node.maxcpu || 0;
            usedCpu += (node.cpu || 0) * (node.maxcpu || 0);
            totalMem += node.maxmem || 0;
            usedMem += node.mem || 0;
          }
        }
        
        const cpuPercent = totalCpu > 0 ? ((usedCpu / totalCpu) * 100).toFixed(1) : 'N/A';
        const memPercent = totalMem > 0 ? ((usedMem / totalMem) * 100).toFixed(1) : 'N/A';
        
        output += `**Resource Usage**:\n`;
        output += `• CPU: ${cpuPercent}% (${usedCpu.toFixed(1)}/${totalCpu} cores)\n`;
        output += `• Memory: ${memPercent}% (${this.formatBytes(usedMem)}/${this.formatBytes(totalMem)})\n\n`;
      } else {
        output += `⚠️  **Limited Information**: Resource usage requires elevated permissions\n\n`;
      }
      
      // Node status
      output += `**Node Details**:\n`;
      for (const node of nodes.sort((a, b) => a.node.localeCompare(b.node))) {
        const status = node.status === 'online' ? '🟢' : '🔴';
        output += `${status} ${node.node} - ${node.status}\n`;
      }
      
      return {
        content: [{ type: 'text', text: output }]
      };
    } catch (error) {
      return {
        content: [{ 
          type: 'text', 
          text: `❌ **Failed to get cluster status**\n\nError: ${error.message}` 
        }]
      };
    }
  }

  async listTemplates(node, storage = 'local') {
    try {
      // Validate inputs
      const safeNode = this.validateNodeName(node);

      const templates = await this.proxmoxRequest(`/nodes/${safeNode}/storage/${storage}/content?content=vztmpl`);

      let output = '📦 **Available LXC Templates**\n\n';

      if (!templates || templates.length === 0) {
        output += `No templates found on storage \`${storage}\`.\n\n`;
        output += `**Tip**: Download templates in Proxmox:\n`;
        output += `1. Go to your node → Storage → ${storage}\n`;
        output += `2. Click "CT Templates"\n`;
        output += `3. Download a template (e.g., Debian, Ubuntu)\n`;
      } else {
        for (const template of templates) {
          const size = template.size ? this.formatBytes(template.size) : 'N/A';
          output += `• **${template.volid}**\n`;
          output += `  Size: ${size}\n\n`;
        }
      }

      return {
        content: [{ type: 'text', text: output }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `❌ **Failed to list templates**\n\nError: ${error.message}\n\n**Note**: Make sure the storage exists and contains LXC templates.`
        }]
      };
    }
  }

  async createLXCContainer(args) {
    if (!this.allowElevated) {
      return {
        content: [{
          type: 'text',
          text: `⚠️  **Container Creation Requires Elevated Permissions**\n\nTo create containers, set \`PROXMOX_ALLOW_ELEVATED=true\` in your .env file and ensure your API token has VM.Allocate permissions.\n\n**Current permissions**: Basic (read-only)`
        }]
      };
    }

    try {
      // Validate inputs
      const safeNode = this.validateNodeName(args.node);
      const safeVMID = this.validateVMID(args.vmid);

      // Generate secure password if not provided
      const generatedPassword = args.password || this.generateSecurePassword();
      const isPasswordGenerated = !args.password;

      // Build the request body
      const body = {
        vmid: safeVMID,
        ostemplate: args.ostemplate,
        hostname: args.hostname || `ct${safeVMID}`,
        password: generatedPassword,
        memory: args.memory || 512,
        storage: args.storage || 'local-lvm',
        rootfs: `${args.storage || 'local-lvm'}:${args.rootfs || 8}`
      };

      // Make the API request
      const result = await this.proxmoxRequest(`/nodes/${safeNode}/lxc`, 'POST', body);

      let output = `✅ **LXC Container Creation Started**\n\n`;
      output += `• **VM ID**: ${safeVMID}\n`;
      output += `• **Hostname**: ${body.hostname}\n`;
      output += `• **Node**: ${safeNode}\n`;
      output += `• **Template**: ${args.ostemplate}\n`;
      output += `• **Memory**: ${body.memory} MB\n`;
      output += `• **Storage**: ${body.storage}\n`;

      if (isPasswordGenerated) {
        output += `• **🔐 Generated Password**: \`${generatedPassword}\`\n`;
        output += `  ⚠️ **SAVE THIS PASSWORD** - it will not be shown again!\n`;
      }

      output += `• **Task ID**: ${result || 'N/A'}\n\n`;
      output += `**Next steps**:\n`;
      output += `1. Wait a moment for container to be created\n`;
      output += `2. Start it with \`proxmox_start_lxc\`\n`;
      output += `3. View status with \`proxmox_get_vm_status\`\n`;

      return {
        content: [{ type: 'text', text: output }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `❌ **Failed to create container**\n\nError: ${error.message}\n\n**Common issues**:\n- VM ID already in use\n- Invalid template path\n- Insufficient permissions\n- Storage doesn't exist`
        }]
      };
    }
  }

  async createVM(args) {
    if (!this.allowElevated) {
      return {
        content: [{
          type: 'text',
          text: `⚠️  **VM Creation Requires Elevated Permissions**\n\nTo create VMs, set \`PROXMOX_ALLOW_ELEVATED=true\` in your .env file and ensure your API token has VM.Allocate permissions.\n\n**Current permissions**: Basic (read-only)`
        }]
      };
    }

    try {
      // Validate inputs
      const safeNode = this.validateNodeName(args.node);
      const safeVMID = this.validateVMID(args.vmid);

      // Build the request body for QEMU VM creation
      const body = {
        vmid: safeVMID,
        name: args.name || `vm${safeVMID}`,
        memory: args.memory || 512,
        cores: args.cores || 1,
        sockets: args.sockets || 1,
        ostype: args.ostype || 'l26',
        net0: args.net0 || 'virtio,bridge=vmbr0'
      };

      // Add disk configuration
      // Format: storage:size (size in GB, no suffix)
      const storage = args.storage || 'local-lvm';
      const diskSize = args.disk_size || '8G';
      // Extract numeric value from disk size (e.g., "8G" -> "8")
      const sizeValue = diskSize.replace(/[^0-9]/g, '');
      body.scsi0 = `${storage}:${sizeValue}`;

      // Add ISO if provided
      if (args.iso) {
        body.ide2 = `${args.iso},media=cdrom`;
        body.boot = 'order=ide2;scsi0';
      }

      // Make the API request
      const result = await this.proxmoxRequest(`/nodes/${safeNode}/qemu`, 'POST', body);

      let output = `✅ **QEMU VM Creation Started**\n\n`;
      output += `• **VM ID**: ${safeVMID}\n`;
      output += `• **Name**: ${body.name}\n`;
      output += `• **Node**: ${safeNode}\n`;
      output += `• **Memory**: ${body.memory} MB\n`;
      output += `• **CPU**: ${body.sockets} socket(s), ${body.cores} core(s)\n`;
      output += `• **Disk**: ${body.scsi0}\n`;
      output += `• **Network**: ${body.net0}\n`;
      if (args.iso) {
        output += `• **ISO**: ${args.iso}\n`;
      }
      output += `• **Task ID**: ${result || 'N/A'}\n\n`;
      output += `**Next steps**:\n`;
      output += `1. Wait a moment for VM to be created\n`;
      output += `2. Start it with \`proxmox_start_vm\`\n`;
      output += `3. View status with \`proxmox_get_vm_status\`\n`;

      return {
        content: [{ type: 'text', text: output }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `❌ **Failed to create VM**\n\nError: ${error.message}\n\n**Common issues**:\n- VM ID already in use\n- Invalid ISO path\n- Insufficient permissions\n- Storage doesn't exist`
        }]
      };
    }
  }

  async startVM(node, vmid, type = 'lxc') {
    if (!this.allowElevated) {
      return {
        content: [{
          type: 'text',
          text: `⚠️  **VM Control Requires Elevated Permissions**\n\nTo start/stop VMs, set \`PROXMOX_ALLOW_ELEVATED=true\` in your .env file.\n\n**Current permissions**: Basic (read-only)`
        }]
      };
    }

    try {
      // Validate inputs
      const safeNode = this.validateNodeName(node);
      const safeVMID = this.validateVMID(vmid);

      const result = await this.proxmoxRequest(`/nodes/${safeNode}/${type}/${safeVMID}/status/start`, 'POST', {});

      let output = `▶️  **VM/Container Start Command Sent**\n\n`;
      output += `• **VM ID**: ${safeVMID}\n`;
      output += `• **Type**: ${type.toUpperCase()}\n`;
      output += `• **Node**: ${safeNode}\n`;
      output += `• **Task ID**: ${result || 'N/A'}\n\n`;
      output += `**Tip**: Use \`proxmox_get_vm_status\` to check if it's running.\n`;

      return {
        content: [{ type: 'text', text: output }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `❌ **Failed to start VM/Container**\n\nError: ${error.message}`
        }]
      };
    }
  }

  async stopVM(node, vmid, type = 'lxc') {
    if (!this.allowElevated) {
      return {
        content: [{
          type: 'text',
          text: `⚠️  **VM Control Requires Elevated Permissions**\n\nTo start/stop VMs, set \`PROXMOX_ALLOW_ELEVATED=true\` in your .env file.\n\n**Current permissions**: Basic (read-only)`
        }]
      };
    }

    try {
      // Validate inputs
      const safeNode = this.validateNodeName(node);
      const safeVMID = this.validateVMID(vmid);

      const result = await this.proxmoxRequest(`/nodes/${safeNode}/${type}/${safeVMID}/status/stop`, 'POST', {});

      let output = `⏹️  **VM/Container Stop Command Sent**\n\n`;
      output += `• **VM ID**: ${safeVMID}\n`;
      output += `• **Type**: ${type.toUpperCase()}\n`;
      output += `• **Node**: ${safeNode}\n`;
      output += `• **Task ID**: ${result || 'N/A'}\n\n`;
      output += `**Tip**: Use \`proxmox_get_vm_status\` to confirm it's stopped.\n`;

      return {
        content: [{ type: 'text', text: output }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `❌ **Failed to stop VM/Container**\n\nError: ${error.message}`
        }]
      };
    }
  }

  async getNextVMID() {
    try {
      const result = await this.proxmoxRequest('/cluster/nextid');
      return {
        content: [{ type: 'text', text: `**Next Available VM/Container ID**: ${result}` }]
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `❌ **Failed to get next VMID**\n\nError: ${error.message}` }]
      };
    }
  }

  async deleteVM(node, vmid, type = 'lxc') {
    if (!this.allowElevated) {
      return {
        content: [{
          type: 'text',
          text: `⚠️  **VM/Container Deletion Requires Elevated Permissions**\n\nTo delete VMs/containers, set \`PROXMOX_ALLOW_ELEVATED=true\` in your .env file.\n\n**Current permissions**: Basic (read-only)`
        }]
      };
    }

    try {
      // Validate inputs
      const safeNode = this.validateNodeName(node);
      const safeVMID = this.validateVMID(vmid);

      const result = await this.proxmoxRequest(`/nodes/${safeNode}/${type}/${safeVMID}`, 'DELETE');

      let output = `🗑️  **VM/Container Deletion Started**\n\n`;
      output += `• **VM/Container ID**: ${safeVMID}\n`;
      output += `• **Type**: ${type.toUpperCase()}\n`;
      output += `• **Node**: ${safeNode}\n`;
      output += `• **Task ID**: ${result || 'N/A'}\n\n`;
      output += `**Note**: Deletion may take a moment to complete.\n`;

      return {
        content: [{ type: 'text', text: output }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `❌ **Failed to delete VM/Container**\n\nError: ${error.message}\n\n**Note**: Make sure the VM/container is stopped first.`
        }]
      };
    }
  }

  async rebootVM(node, vmid, type = 'lxc') {
    if (!this.allowElevated) {
      return {
        content: [{
          type: 'text',
          text: `⚠️  **VM Reboot Requires Elevated Permissions**\n\nTo reboot VMs/containers, set \`PROXMOX_ALLOW_ELEVATED=true\` in your .env file.\n\n**Current permissions**: Basic (read-only)`
        }]
      };
    }

    try {
      // Validate inputs
      const safeNode = this.validateNodeName(node);
      const safeVMID = this.validateVMID(vmid);

      const result = await this.proxmoxRequest(`/nodes/${safeNode}/${type}/${safeVMID}/status/reboot`, 'POST', {});

      let output = `🔄 **VM/Container Reboot Command Sent**\n\n`;
      output += `• **VM ID**: ${safeVMID}\n`;
      output += `• **Type**: ${type.toUpperCase()}\n`;
      output += `• **Node**: ${safeNode}\n`;
      output += `• **Task ID**: ${result || 'N/A'}\n\n`;
      output += `**Tip**: The VM/container will restart momentarily.\n`;

      return {
        content: [{ type: 'text', text: output }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `❌ **Failed to reboot VM/Container**\n\nError: ${error.message}`
        }]
      };
    }
  }

  async shutdownVM(node, vmid, type = 'lxc') {
    if (!this.allowElevated) {
      return {
        content: [{
          type: 'text',
          text: `⚠️  **VM Shutdown Requires Elevated Permissions**\n\nTo shutdown VMs/containers, set \`PROXMOX_ALLOW_ELEVATED=true\` in your .env file.\n\n**Current permissions**: Basic (read-only)`
        }]
      };
    }

    try {
      // Validate inputs
      const safeNode = this.validateNodeName(node);
      const safeVMID = this.validateVMID(vmid);

      const result = await this.proxmoxRequest(`/nodes/${safeNode}/${type}/${safeVMID}/status/shutdown`, 'POST', {});

      let output = `⏸️  **VM/Container Shutdown Command Sent**\n\n`;
      output += `• **VM ID**: ${safeVMID}\n`;
      output += `• **Type**: ${type.toUpperCase()}\n`;
      output += `• **Node**: ${safeNode}\n`;
      output += `• **Task ID**: ${result || 'N/A'}\n\n`;
      output += `**Note**: This is a graceful shutdown. Use \`proxmox_stop_vm\` for forceful stop.\n`;

      return {
        content: [{ type: 'text', text: output }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `❌ **Failed to shutdown VM/Container**\n\nError: ${error.message}`
        }]
      };
    }
  }

  async pauseVM(node, vmid) {
    if (!this.allowElevated) {
      return {
        content: [{
          type: 'text',
          text: `⚠️  **VM Pause Requires Elevated Permissions**\n\nTo pause VMs, set \`PROXMOX_ALLOW_ELEVATED=true\` in your .env file.\n\n**Current permissions**: Basic (read-only)`
        }]
      };
    }

    try {
      // Validate inputs
      const safeNode = this.validateNodeName(node);
      const safeVMID = this.validateVMID(vmid);

      const result = await this.proxmoxRequest(`/nodes/${safeNode}/qemu/${safeVMID}/status/suspend`, 'POST', {});

      let output = `⏸️  **VM Pause Command Sent**\n\n`;
      output += `• **VM ID**: ${safeVMID}\n`;
      output += `• **Type**: QEMU\n`;
      output += `• **Node**: ${safeNode}\n`;
      output += `• **Task ID**: ${result || 'N/A'}\n\n`;
      output += `**Note**: VM is now paused. Use \`proxmox_resume_vm\` to resume.\n`;

      return {
        content: [{ type: 'text', text: output }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `❌ **Failed to pause VM**\n\nError: ${error.message}\n\n**Note**: Pause is only available for QEMU VMs, not LXC containers.`
        }]
      };
    }
  }

  async resumeVM(node, vmid) {
    if (!this.allowElevated) {
      return {
        content: [{
          type: 'text',
          text: `⚠️  **VM Resume Requires Elevated Permissions**\n\nTo resume VMs, set \`PROXMOX_ALLOW_ELEVATED=true\` in your .env file.\n\n**Current permissions**: Basic (read-only)`
        }]
      };
    }

    try {
      // Validate inputs
      const safeNode = this.validateNodeName(node);
      const safeVMID = this.validateVMID(vmid);

      const result = await this.proxmoxRequest(`/nodes/${safeNode}/qemu/${safeVMID}/status/resume`, 'POST', {});

      let output = `▶️  **VM Resume Command Sent**\n\n`;
      output += `• **VM ID**: ${safeVMID}\n`;
      output += `• **Type**: QEMU\n`;
      output += `• **Node**: ${safeNode}\n`;
      output += `• **Task ID**: ${result || 'N/A'}\n\n`;
      output += `**Note**: VM is now resuming from paused state.\n`;

      return {
        content: [{ type: 'text', text: output }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `❌ **Failed to resume VM**\n\nError: ${error.message}\n\n**Note**: Resume is only available for QEMU VMs, not LXC containers.`
        }]
      };
    }
  }

  async cloneVM(node, vmid, newid, nameOrHostname, type = 'lxc') {
    if (!this.allowElevated) {
      return {
        content: [{
          type: 'text',
          text: `⚠️  **VM Clone Requires Elevated Permissions**\n\nTo clone VMs/containers, set \`PROXMOX_ALLOW_ELEVATED=true\` in your .env file.\n\n**Current permissions**: Basic (read-only)`
        }]
      };
    }

    try {
      // Validate inputs
      const safeNode = this.validateNodeName(node);
      const safeVMID = this.validateVMID(vmid);
      const safeNewID = this.validateVMID(newid);

      const body = {
        newid: safeNewID
      };

      // For LXC, use 'hostname', for QEMU use 'name'
      if (type === 'lxc') {
        body.hostname = nameOrHostname || `clone-${safeNewID}`;
      } else {
        body.name = nameOrHostname || `clone-${safeNewID}`;
      }

      const result = await this.proxmoxRequest(`/nodes/${safeNode}/${type}/${safeVMID}/clone`, 'POST', body);

      let output = `📋 **VM/Container Clone Started**\n\n`;
      output += `• **Source VM ID**: ${safeVMID}\n`;
      output += `• **New VM ID**: ${safeNewID}\n`;
      output += `• **New Name**: ${nameOrHostname || `clone-${safeNewID}`}\n`;
      output += `• **Type**: ${type.toUpperCase()}\n`;
      output += `• **Node**: ${safeNode}\n`;
      output += `• **Task ID**: ${result || 'N/A'}\n\n`;
      output += `**Note**: Clone operation may take several minutes. Check task status in Proxmox.\n`;

      return {
        content: [{ type: 'text', text: output }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `❌ **Failed to clone VM/Container**\n\nError: ${error.message}\n\n**Common issues**:\n- New VM ID already in use\n- Insufficient storage space\n- Source VM is running (some storage types require stopped VM)`
        }]
      };
    }
  }

  async resizeVM(node, vmid, memory, cores, type = 'lxc') {
    if (!this.allowElevated) {
      return {
        content: [{
          type: 'text',
          text: `⚠️  **VM Resize Requires Elevated Permissions**\n\nTo resize VMs/containers, set \`PROXMOX_ALLOW_ELEVATED=true\` in your .env file.\n\n**Current permissions**: Basic (read-only)`
        }]
      };
    }

    // Build body with only provided parameters
    const body = {};
    if (memory !== undefined) {
      body.memory = memory;
    }
    if (cores !== undefined) {
      body.cores = cores;
    }

    if (Object.keys(body).length === 0) {
      return {
        content: [{
          type: 'text',
          text: `⚠️  **No Resize Parameters Provided**\n\nPlease specify at least one parameter:\n- \`memory\`: Memory in MB\n- \`cores\`: Number of CPU cores`
        }]
      };
    }

    try {
      // Validate inputs
      const safeNode = this.validateNodeName(node);
      const safeVMID = this.validateVMID(vmid);

      const result = await this.proxmoxRequest(`/nodes/${safeNode}/${type}/${safeVMID}/config`, 'PUT', body);

      let output = `📏 **VM/Container Resize Command Sent**\n\n`;
      output += `• **VM ID**: ${safeVMID}\n`;
      output += `• **Type**: ${type.toUpperCase()}\n`;
      output += `• **Node**: ${safeNode}\n`;
      if (memory !== undefined) {
        output += `• **New Memory**: ${memory} MB\n`;
      }
      if (cores !== undefined) {
        output += `• **New Cores**: ${cores}\n`;
      }
      output += `• **Task ID**: ${result || 'N/A'}\n\n`;
      output += `**Note**: Some changes may require a reboot to take effect.\n`;

      return {
        content: [{ type: 'text', text: output }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `❌ **Failed to resize VM/Container**\n\nError: ${error.message}\n\n**Common issues**:\n- Memory/CPU values exceed node capacity\n- VM is locked or in use\n- Invalid parameter values`
        }]
      };
    }
  }

  async createSnapshot(node, vmid, snapname, type = 'lxc') {
    if (!this.allowElevated) {
      return {
        content: [{
          type: 'text',
          text: `⚠️  **Snapshot Creation Requires Elevated Permissions**\n\nTo create snapshots, set \`PROXMOX_ALLOW_ELEVATED=true\` in your .env file.\n\n**Current permissions**: Basic (read-only)`
        }]
      };
    }

    try {
      // Validate inputs
      const safeNode = this.validateNodeName(node);
      const safeVMID = this.validateVMID(vmid);

      const result = await this.proxmoxRequest(`/nodes/${safeNode}/${type}/${safeVMID}/snapshot`, 'POST', {
        snapname: snapname
      });

      let output = `📸 **Snapshot Creation Started**\n\n`;
      output += `• **VM ID**: ${safeVMID}\n`;
      output += `• **Snapshot Name**: ${snapname}\n`;
      output += `• **Type**: ${type.toUpperCase()}\n`;
      output += `• **Node**: ${safeNode}\n`;
      output += `• **Task ID**: ${result || 'N/A'}\n\n`;
      output += `**Tip**: Use \`proxmox_list_snapshots_${type === 'lxc' ? 'lxc' : 'vm'}\` to view all snapshots.\n`;

      return {
        content: [{ type: 'text', text: output }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `❌ **Failed to create snapshot**\n\nError: ${error.message}\n\n**Common issues**:\n- Snapshot name already exists\n- Insufficient disk space\n- VM is locked or in use`
        }]
      };
    }
  }

  async listSnapshots(node, vmid, type = 'lxc') {
    if (!this.allowElevated) {
      return {
        content: [{
          type: 'text',
          text: `⚠️  **Snapshot Listing Requires Elevated Permissions**\n\nTo list snapshots, set \`PROXMOX_ALLOW_ELEVATED=true\` in your .env file.\n\n**Current permissions**: Basic (read-only)`
        }]
      };
    }

    try {
      // Validate inputs
      const safeNode = this.validateNodeName(node);
      const safeVMID = this.validateVMID(vmid);

      const snapshots = await this.proxmoxRequest(`/nodes/${safeNode}/${type}/${safeVMID}/snapshot`);

      let output = `📋 **Snapshots for ${type.toUpperCase()} ${safeVMID}**\n\n`;

      if (!snapshots || snapshots.length === 0) {
        output += `No snapshots found.\n\n`;
        output += `**Tip**: Create a snapshot with \`proxmox_create_snapshot_${type === 'lxc' ? 'lxc' : 'vm'}\`.\n`;
      } else {
        // Filter out 'current' pseudo-snapshot that Proxmox includes
        const realSnapshots = snapshots.filter(snap => snap.name !== 'current');

        if (realSnapshots.length === 0) {
          output += `No snapshots found.\n\n`;
          output += `**Tip**: Create a snapshot with \`proxmox_create_snapshot_${type === 'lxc' ? 'lxc' : 'vm'}\`.\n`;
        } else {
          for (const snapshot of realSnapshots) {
            output += `• **${snapshot.name}**\n`;
            if (snapshot.description) {
              output += `  Description: ${snapshot.description}\n`;
            }
            if (snapshot.snaptime) {
              const date = new Date(snapshot.snaptime * 1000);
              output += `  Created: ${date.toLocaleString()}\n`;
            }
            output += `\n`;
          }
          output += `**Total**: ${realSnapshots.length} snapshot(s)\n`;
        }
      }

      return {
        content: [{ type: 'text', text: output }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `❌ **Failed to list snapshots**\n\nError: ${error.message}`
        }]
      };
    }
  }

  async rollbackSnapshot(node, vmid, snapname, type = 'lxc') {
    if (!this.allowElevated) {
      return {
        content: [{
          type: 'text',
          text: `⚠️  **Snapshot Rollback Requires Elevated Permissions**\n\nTo rollback snapshots, set \`PROXMOX_ALLOW_ELEVATED=true\` in your .env file.\n\n**Current permissions**: Basic (read-only)`
        }]
      };
    }

    try {
      // Validate inputs
      const safeNode = this.validateNodeName(node);
      const safeVMID = this.validateVMID(vmid);

      const result = await this.proxmoxRequest(`/nodes/${safeNode}/${type}/${safeVMID}/snapshot/${snapname}/rollback`, 'POST', {});

      let output = `⏮️  **Snapshot Rollback Started**\n\n`;
      output += `• **VM ID**: ${safeVMID}\n`;
      output += `• **Snapshot Name**: ${snapname}\n`;
      output += `• **Type**: ${type.toUpperCase()}\n`;
      output += `• **Node**: ${safeNode}\n`;
      output += `• **Task ID**: ${result || 'N/A'}\n\n`;
      output += `**Warning**: This will restore the VM/container to the state of the snapshot.\n`;
      output += `**Tip**: Any changes made after the snapshot was created will be lost.\n`;

      return {
        content: [{ type: 'text', text: output }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `❌ **Failed to rollback snapshot**\n\nError: ${error.message}\n\n**Common issues**:\n- Snapshot doesn't exist\n- VM is running (stop it first)\n- VM is locked or in use`
        }]
      };
    }
  }

  async deleteSnapshot(node, vmid, snapname, type = 'lxc') {
    if (!this.allowElevated) {
      return {
        content: [{
          type: 'text',
          text: `⚠️  **Snapshot Deletion Requires Elevated Permissions**\n\nTo delete snapshots, set \`PROXMOX_ALLOW_ELEVATED=true\` in your .env file.\n\n**Current permissions**: Basic (read-only)`
        }]
      };
    }

    try {
      // Validate inputs
      const safeNode = this.validateNodeName(node);
      const safeVMID = this.validateVMID(vmid);

      const result = await this.proxmoxRequest(`/nodes/${safeNode}/${type}/${safeVMID}/snapshot/${snapname}`, 'DELETE');

      let output = `🗑️  **Snapshot Deletion Started**\n\n`;
      output += `• **VM ID**: ${safeVMID}\n`;
      output += `• **Snapshot Name**: ${snapname}\n`;
      output += `• **Type**: ${type.toUpperCase()}\n`;
      output += `• **Node**: ${safeNode}\n`;
      output += `• **Task ID**: ${result || 'N/A'}\n\n`;
      output += `**Note**: Snapshot deletion may take a moment to complete.\n`;

      return {
        content: [{ type: 'text', text: output }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `❌ **Failed to delete snapshot**\n\nError: ${error.message}\n\n**Common issues**:\n- Snapshot doesn't exist\n- VM is locked or in use\n- Insufficient permissions`
        }]
      };
    }
  }

  async createBackup(node, vmid, storage = 'local', mode = 'snapshot', compress = 'zstd', type = 'lxc') {
    if (!this.allowElevated) {
      return {
        content: [{
          type: 'text',
          text: `⚠️  **Backup Creation Requires Elevated Permissions**\n\nTo create backups, set \`PROXMOX_ALLOW_ELEVATED=true\` in your .env file.\n\n**Current permissions**: Basic (read-only)`
        }]
      };
    }

    try {
      // Validate inputs
      const safeNode = this.validateNodeName(node);
      const safeVMID = this.validateVMID(vmid);

      const result = await this.proxmoxRequest(`/nodes/${safeNode}/vzdump`, 'POST', {
        vmid: safeVMID,
        storage: storage,
        mode: mode,
        compress: compress
      });

      let output = `💾 **Backup Creation Started**\n\n`;
      output += `• **VM ID**: ${safeVMID}\n`;
      output += `• **Type**: ${type.toUpperCase()}\n`;
      output += `• **Node**: ${safeNode}\n`;
      output += `• **Storage**: ${storage}\n`;
      output += `• **Mode**: ${mode}\n`;
      output += `• **Compression**: ${compress}\n`;
      output += `• **Task ID**: ${result || 'N/A'}\n\n`;
      output += `**Tip**: Backup runs in the background. Use \`proxmox_list_backups\` to view all backups.\n`;
      output += `**Note**: Backup modes:\n`;
      output += `  - snapshot: Quick backup using snapshots (recommended)\n`;
      output += `  - suspend: Suspends VM during backup\n`;
      output += `  - stop: Stops VM during backup\n`;

      return {
        content: [{ type: 'text', text: output }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `❌ **Failed to create backup**\n\nError: ${error.message}\n\n**Common issues**:\n- Insufficient disk space on storage\n- VM is locked or in use\n- Invalid storage name\n- Insufficient permissions`
        }]
      };
    }
  }

  async listBackups(node, storage = 'local') {
    if (!this.allowElevated) {
      return {
        content: [{
          type: 'text',
          text: `⚠️  **Backup Listing Requires Elevated Permissions**\n\nTo list backups, set \`PROXMOX_ALLOW_ELEVATED=true\` in your .env file.\n\n**Current permissions**: Basic (read-only)`
        }]
      };
    }

    try {
      // Validate inputs
      const safeNode = this.validateNodeName(node);

      const backups = await this.proxmoxRequest(`/nodes/${safeNode}/storage/${storage}/content?content=backup`);

      let output = `📦 **Backups on ${storage}**\n\n`;

      if (!backups || backups.length === 0) {
        output += `No backups found on storage \`${storage}\`.\n\n`;
        output += `**Tip**: Create a backup with \`proxmox_create_backup_lxc\` or \`proxmox_create_backup_vm\`.\n`;
      } else {
        // Sort by creation time (newest first)
        backups.sort((a, b) => (b.ctime || 0) - (a.ctime || 0));

        for (const backup of backups) {
          // Parse backup filename to extract VM type and ID
          const filename = backup.volid.split('/').pop();
          const match = filename.match(/vzdump-(lxc|qemu)-(\d+)-/);
          const vmType = match ? match[1].toUpperCase() : 'UNKNOWN';
          const vmId = match ? match[2] : 'N/A';

          output += `• **${filename}**\n`;
          output += `  VM ID: ${vmId} (${vmType})\n`;
          output += `  Size: ${backup.size ? this.formatBytes(backup.size) : 'N/A'}\n`;
          if (backup.ctime) {
            const date = new Date(backup.ctime * 1000);
            output += `  Created: ${date.toLocaleString()}\n`;
          }
          output += `  Volume: ${backup.volid}\n`;
          output += `\n`;
        }
        output += `**Total**: ${backups.length} backup(s)\n`;
      }

      return {
        content: [{ type: 'text', text: output }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `❌ **Failed to list backups**\n\nError: ${error.message}\n\n**Common issues**:\n- Storage doesn't exist\n- Storage is not accessible\n- Insufficient permissions`
        }]
      };
    }
  }

  async restoreBackup(node, vmid, archive, storage, type = 'lxc') {
    if (!this.allowElevated) {
      return {
        content: [{
          type: 'text',
          text: `⚠️  **Backup Restore Requires Elevated Permissions**\n\nTo restore backups, set \`PROXMOX_ALLOW_ELEVATED=true\` in your .env file.\n\n**Current permissions**: Basic (read-only)`
        }]
      };
    }

    try {
      // Validate inputs
      const safeNode = this.validateNodeName(node);
      const safeVMID = this.validateVMID(vmid);

      const body = {
        vmid: safeVMID,
        archive: archive,
        restore: 1
      };

      if (storage) {
        body.storage = storage;
      }

      const result = await this.proxmoxRequest(`/nodes/${safeNode}/${type}`, 'POST', body);

      let output = `♻️  **Backup Restore Started**\n\n`;
      output += `• **New VM ID**: ${safeVMID}\n`;
      output += `• **Type**: ${type.toUpperCase()}\n`;
      output += `• **Node**: ${safeNode}\n`;
      output += `• **Archive**: ${archive}\n`;
      if (storage) {
        output += `• **Storage**: ${storage}\n`;
      }
      output += `• **Task ID**: ${result || 'N/A'}\n\n`;
      output += `**Note**: Restore operation may take several minutes depending on backup size.\n`;
      output += `**Tip**: Use \`proxmox_get_vm_status\` to check the restored VM status after completion.\n`;

      return {
        content: [{ type: 'text', text: output }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `❌ **Failed to restore backup**\n\nError: ${error.message}\n\n**Common issues**:\n- VM ID already in use\n- Backup archive doesn't exist\n- Insufficient storage space\n- Invalid archive path\n- Insufficient permissions`
        }]
      };
    }
  }

  async deleteBackup(node, storage, volume) {
    if (!this.allowElevated) {
      return {
        content: [{
          type: 'text',
          text: `⚠️  **Backup Deletion Requires Elevated Permissions**\n\nTo delete backups, set \`PROXMOX_ALLOW_ELEVATED=true\` in your .env file.\n\n**Current permissions**: Basic (read-only)`
        }]
      };
    }

    try {
      // Validate inputs
      const safeNode = this.validateNodeName(node);

      const encodedVolume = encodeURIComponent(volume);
      const result = await this.proxmoxRequest(`/nodes/${safeNode}/storage/${storage}/content/${encodedVolume}`, 'DELETE');

      let output = `🗑️  **Backup Deletion Started**\n\n`;
      output += `• **Node**: ${safeNode}\n`;
      output += `• **Storage**: ${storage}\n`;
      output += `• **Volume**: ${volume}\n`;
      output += `• **Task ID**: ${result || 'N/A'}\n\n`;
      output += `**Note**: Backup file will be permanently deleted from storage.\n`;

      return {
        content: [{ type: 'text', text: output }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `❌ **Failed to delete backup**\n\nError: ${error.message}\n\n**Common issues**:\n- Backup doesn't exist\n- Invalid volume path\n- Backup is in use\n- Insufficient permissions`
        }]
      };
    }
  }

  async addDiskVM(node, vmid, disk, storage, size) {
    if (!this.allowElevated) {
      return {
        content: [{
          type: 'text',
          text: `⚠️  **Disk Management Requires Elevated Permissions**\n\nTo add disks to VMs, set \`PROXMOX_ALLOW_ELEVATED=true\` in your .env file.\n\n**Current permissions**: Basic (read-only)`
        }]
      };
    }

    try {
      // Validate inputs
      const safeNode = this.validateNodeName(node);
      const safeVMID = this.validateVMID(vmid);

      const body = {
        [disk]: `${storage}:${size}`
      };

      const result = await this.proxmoxRequest(`/nodes/${safeNode}/qemu/${safeVMID}/config`, 'PUT', body);

      let output = `💿 **VM Disk Addition Started**\n\n`;
      output += `• **VM ID**: ${safeVMID}\n`;
      output += `• **Node**: ${safeNode}\n`;
      output += `• **Disk**: ${disk}\n`;
      output += `• **Storage**: ${storage}\n`;
      output += `• **Size**: ${size} GB\n`;
      output += `• **Task ID**: ${result || 'N/A'}\n\n`;
      output += `**Disk naming conventions**:\n`;
      output += `  - SCSI: scsi0-15\n`;
      output += `  - VirtIO: virtio0-15\n`;
      output += `  - SATA: sata0-5\n`;
      output += `  - IDE: ide0-3\n\n`;
      output += `**Note**: The VM may need to be stopped for this operation depending on configuration.\n`;

      return {
        content: [{ type: 'text', text: output }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `❌ **Failed to add disk to VM**\n\nError: ${error.message}\n\n**Common issues**:\n- Disk name already in use\n- VM is running (may need to be stopped)\n- Invalid disk name format\n- Insufficient storage space\n- Storage doesn't exist`
        }]
      };
    }
  }

  async addMountPointLXC(node, vmid, mp, storage, size) {
    if (!this.allowElevated) {
      return {
        content: [{
          type: 'text',
          text: `⚠️  **Disk Management Requires Elevated Permissions**\n\nTo add mount points to containers, set \`PROXMOX_ALLOW_ELEVATED=true\` in your .env file.\n\n**Current permissions**: Basic (read-only)`
        }]
      };
    }

    try {
      // Validate inputs
      const safeNode = this.validateNodeName(node);
      const safeVMID = this.validateVMID(vmid);

      const body = {
        [mp]: `${storage}:${size}`
      };

      const result = await this.proxmoxRequest(`/nodes/${safeNode}/lxc/${safeVMID}/config`, 'PUT', body);

      let output = `💿 **LXC Mount Point Addition Started**\n\n`;
      output += `• **Container ID**: ${safeVMID}\n`;
      output += `• **Node**: ${safeNode}\n`;
      output += `• **Mount Point**: ${mp}\n`;
      output += `• **Storage**: ${storage}\n`;
      output += `• **Size**: ${size} GB\n`;
      output += `• **Task ID**: ${result || 'N/A'}\n\n`;
      output += `**Mount point naming**: mp0-255\n\n`;
      output += `**Note**: The container may need to be stopped for this operation.\n`;

      return {
        content: [{ type: 'text', text: output }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `❌ **Failed to add mount point to container**\n\nError: ${error.message}\n\n**Common issues**:\n- Mount point name already in use\n- Container is running (may need to be stopped)\n- Invalid mount point name\n- Insufficient storage space\n- Storage doesn't exist`
        }]
      };
    }
  }

  async resizeDiskVM(node, vmid, disk, size) {
    if (!this.allowElevated) {
      return {
        content: [{
          type: 'text',
          text: `⚠️  **Disk Management Requires Elevated Permissions**\n\nTo resize VM disks, set \`PROXMOX_ALLOW_ELEVATED=true\` in your .env file.\n\n**Current permissions**: Basic (read-only)`
        }]
      };
    }

    try {
      // Validate inputs
      const safeNode = this.validateNodeName(node);
      const safeVMID = this.validateVMID(vmid);

      const body = {
        disk: disk,
        size: size
      };

      const result = await this.proxmoxRequest(`/nodes/${safeNode}/qemu/${safeVMID}/resize`, 'PUT', body);

      let output = `📏 **VM Disk Resize Started**\n\n`;
      output += `• **VM ID**: ${safeVMID}\n`;
      output += `• **Node**: ${safeNode}\n`;
      output += `• **Disk**: ${disk}\n`;
      output += `• **New Size**: ${size}\n`;
      output += `• **Task ID**: ${result || 'N/A'}\n\n`;
      output += `**Size format examples**:\n`;
      output += `  - +10G: Add 10GB to current size\n`;
      output += `  - 50G: Set absolute size to 50GB\n\n`;
      output += `**Note**: Disks can only be expanded, not shrunk. Some configurations allow online resizing.\n`;

      return {
        content: [{ type: 'text', text: output }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `❌ **Failed to resize VM disk**\n\nError: ${error.message}\n\n**Common issues**:\n- Disk doesn't exist\n- Trying to shrink disk (not supported)\n- Insufficient storage space\n- Invalid size format\n- VM is locked or in use`
        }]
      };
    }
  }

  async resizeDiskLXC(node, vmid, disk, size) {
    if (!this.allowElevated) {
      return {
        content: [{
          type: 'text',
          text: `⚠️  **Disk Management Requires Elevated Permissions**\n\nTo resize LXC disks, set \`PROXMOX_ALLOW_ELEVATED=true\` in your .env file.\n\n**Current permissions**: Basic (read-only)`
        }]
      };
    }

    try {
      // Validate inputs
      const safeNode = this.validateNodeName(node);
      const safeVMID = this.validateVMID(vmid);

      const body = {
        disk: disk,
        size: size
      };

      const result = await this.proxmoxRequest(`/nodes/${safeNode}/lxc/${safeVMID}/resize`, 'PUT', body);

      let output = `📏 **LXC Disk Resize Started**\n\n`;
      output += `• **Container ID**: ${safeVMID}\n`;
      output += `• **Node**: ${safeNode}\n`;
      output += `• **Disk**: ${disk}\n`;
      output += `• **New Size**: ${size}\n`;
      output += `• **Task ID**: ${result || 'N/A'}\n\n`;
      output += `**Size format examples**:\n`;
      output += `  - +10G: Add 10GB to current size\n`;
      output += `  - 50G: Set absolute size to 50GB\n\n`;
      output += `**Valid disk names**: rootfs, mp0, mp1, mp2, etc.\n\n`;
      output += `**Note**: Disks can only be expanded, not shrunk. Container may need to be stopped.\n`;

      return {
        content: [{ type: 'text', text: output }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `❌ **Failed to resize LXC disk**\n\nError: ${error.message}\n\n**Common issues**:\n- Disk doesn't exist\n- Trying to shrink disk (not supported)\n- Insufficient storage space\n- Invalid size format\n- Container is locked or in use`
        }]
      };
    }
  }

  async removeDiskVM(node, vmid, disk) {
    if (!this.allowElevated) {
      return {
        content: [{
          type: 'text',
          text: `⚠️  **Disk Management Requires Elevated Permissions**\n\nTo remove disks from VMs, set \`PROXMOX_ALLOW_ELEVATED=true\` in your .env file.\n\n**Current permissions**: Basic (read-only)`
        }]
      };
    }

    try {
      // Validate inputs
      const safeNode = this.validateNodeName(node);
      const safeVMID = this.validateVMID(vmid);

      const body = {
        delete: disk
      };

      const result = await this.proxmoxRequest(`/nodes/${safeNode}/qemu/${safeVMID}/config`, 'PUT', body);

      let output = `➖ **VM Disk Removal Started**\n\n`;
      output += `• **VM ID**: ${safeVMID}\n`;
      output += `• **Node**: ${safeNode}\n`;
      output += `• **Disk**: ${disk}\n`;
      output += `• **Task ID**: ${result || 'N/A'}\n\n`;
      output += `**Warning**: This will permanently delete the disk and all its data.\n`;
      output += `**Note**: The VM should be stopped for this operation.\n`;

      return {
        content: [{ type: 'text', text: output }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `❌ **Failed to remove disk from VM**\n\nError: ${error.message}\n\n**Common issues**:\n- Disk doesn't exist\n- VM is running (must be stopped)\n- Cannot remove boot disk\n- VM is locked or in use`
        }]
      };
    }
  }

  async removeMountPointLXC(node, vmid, mp) {
    if (!this.allowElevated) {
      return {
        content: [{
          type: 'text',
          text: `⚠️  **Disk Management Requires Elevated Permissions**\n\nTo remove mount points from containers, set \`PROXMOX_ALLOW_ELEVATED=true\` in your .env file.\n\n**Current permissions**: Basic (read-only)`
        }]
      };
    }

    try {
      // Validate inputs
      const safeNode = this.validateNodeName(node);
      const safeVMID = this.validateVMID(vmid);

      const body = {
        delete: mp
      };

      const result = await this.proxmoxRequest(`/nodes/${safeNode}/lxc/${safeVMID}/config`, 'PUT', body);

      let output = `➖ **LXC Mount Point Removal Started**\n\n`;
      output += `• **Container ID**: ${safeVMID}\n`;
      output += `• **Node**: ${safeNode}\n`;
      output += `• **Mount Point**: ${mp}\n`;
      output += `• **Task ID**: ${result || 'N/A'}\n\n`;
      output += `**Warning**: This will permanently delete the mount point and all its data.\n`;
      output += `**Note**: The container should be stopped for this operation.\n`;

      return {
        content: [{ type: 'text', text: output }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `❌ **Failed to remove mount point from container**\n\nError: ${error.message}\n\n**Common issues**:\n- Mount point doesn't exist\n- Container is running (must be stopped)\n- Cannot remove rootfs\n- Container is locked or in use`
        }]
      };
    }
  }

  async moveDiskVM(node, vmid, disk, storage, deleteSource = true) {
    if (!this.allowElevated) {
      return {
        content: [{
          type: 'text',
          text: `⚠️  **Disk Management Requires Elevated Permissions**\n\nTo move VM disks, set \`PROXMOX_ALLOW_ELEVATED=true\` in your .env file.\n\n**Current permissions**: Basic (read-only)`
        }]
      };
    }

    try {
      // Validate inputs
      const safeNode = this.validateNodeName(node);
      const safeVMID = this.validateVMID(vmid);

      const body = {
        disk: disk,
        storage: storage,
        delete: deleteSource ? 1 : 0
      };

      const result = await this.proxmoxRequest(`/nodes/${safeNode}/qemu/${safeVMID}/move_disk`, 'POST', body);

      let output = `📦 **VM Disk Move Started**\n\n`;
      output += `• **VM ID**: ${safeVMID}\n`;
      output += `• **Node**: ${safeNode}\n`;
      output += `• **Disk**: ${disk}\n`;
      output += `• **Target Storage**: ${storage}\n`;
      output += `• **Delete Source**: ${deleteSource ? 'Yes' : 'No'}\n`;
      output += `• **Task ID**: ${result || 'N/A'}\n\n`;
      output += `**Note**: Disk move operation may take several minutes depending on disk size.\n`;
      output += `**Tip**: The VM should be stopped for this operation in most configurations.\n`;

      return {
        content: [{ type: 'text', text: output }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `❌ **Failed to move VM disk**\n\nError: ${error.message}\n\n**Common issues**:\n- Disk doesn't exist\n- Target storage doesn't exist\n- Insufficient space on target storage\n- VM is running (may need to be stopped)\n- VM is locked or in use`
        }]
      };
    }
  }

  async moveDiskLXC(node, vmid, disk, storage, deleteSource = true) {
    if (!this.allowElevated) {
      return {
        content: [{
          type: 'text',
          text: `⚠️  **Disk Management Requires Elevated Permissions**\n\nTo move LXC disks, set \`PROXMOX_ALLOW_ELEVATED=true\` in your .env file.\n\n**Current permissions**: Basic (read-only)`
        }]
      };
    }

    try {
      // Validate inputs
      const safeNode = this.validateNodeName(node);
      const safeVMID = this.validateVMID(vmid);

      const body = {
        volume: disk,
        storage: storage,
        delete: deleteSource ? 1 : 0
      };

      const result = await this.proxmoxRequest(`/nodes/${safeNode}/lxc/${safeVMID}/move_volume`, 'POST', body);

      let output = `📦 **LXC Disk Move Started**\n\n`;
      output += `• **Container ID**: ${safeVMID}\n`;
      output += `• **Node**: ${safeNode}\n`;
      output += `• **Volume**: ${disk}\n`;
      output += `• **Target Storage**: ${storage}\n`;
      output += `• **Delete Source**: ${deleteSource ? 'Yes' : 'No'}\n`;
      output += `• **Task ID**: ${result || 'N/A'}\n\n`;
      output += `**Valid volumes**: rootfs, mp0, mp1, mp2, etc.\n\n`;
      output += `**Note**: Volume move operation may take several minutes depending on volume size.\n`;
      output += `**Tip**: The container should be stopped for this operation.\n`;

      return {
        content: [{ type: 'text', text: output }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `❌ **Failed to move LXC volume**\n\nError: ${error.message}\n\n**Common issues**:\n- Volume doesn't exist\n- Target storage doesn't exist\n- Insufficient space on target storage\n- Container is running (may need to be stopped)\n- Container is locked or in use`
        }]
      };
    }
  }

  async addNetworkVM(node, vmid, net, bridge, model = 'virtio', macaddr, vlan, firewall) {
    if (!this.allowElevated) {
      return {
        content: [{
          type: 'text',
          text: `⚠️  **Network Management Requires Elevated Permissions**\n\nTo add VM network interfaces, set \`PROXMOX_ALLOW_ELEVATED=true\` in your .env file.\n\n**Current permissions**: Basic (read-only)`
        }]
      };
    }

    try {
      // Validate inputs
      const safeNode = this.validateNodeName(node);
      const safeVMID = this.validateVMID(vmid);

      // Build network configuration string
      let netConfig = `${model || 'virtio'},bridge=${bridge}`;

      if (macaddr) {
        netConfig += `,macaddr=${macaddr}`;
      }

      if (vlan !== undefined && vlan !== null) {
        netConfig += `,tag=${vlan}`;
      }

      if (firewall) {
        netConfig += `,firewall=1`;
      }

      const body = {
        [net]: netConfig
      };

      await this.proxmoxRequest(`/nodes/${safeNode}/qemu/${safeVMID}/config`, 'PUT', body);

      let output = `🌐 **VM Network Interface Added**\n\n`;
      output += `• **VM ID**: ${safeVMID}\n`;
      output += `• **Node**: ${safeNode}\n`;
      output += `• **Interface**: ${net}\n`;
      output += `• **Bridge**: ${bridge}\n`;
      output += `• **Model**: ${model || 'virtio'}\n`;
      if (macaddr) output += `• **MAC Address**: ${macaddr}\n`;
      if (vlan !== undefined && vlan !== null) output += `• **VLAN Tag**: ${vlan}\n`;
      if (firewall) output += `• **Firewall**: Enabled\n`;
      output += `\n**Valid interfaces**: net0, net1, net2, etc.\n`;
      output += `**Valid models**: virtio (recommended), e1000, rtl8139, vmxnet3\n`;
      output += `**Valid bridges**: vmbr0, vmbr1, vmbr2, etc.\n\n`;
      output += `**Tip**: Use virtio model for best performance with modern guests.\n`;

      return {
        content: [{ type: 'text', text: output }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `❌ **Failed to add VM network interface**\n\nError: ${error.message}\n\n**Common issues**:\n- Network interface already exists\n- Bridge doesn't exist\n- Invalid MAC address format\n- Invalid VLAN tag (must be 1-4094)\n- VM is locked or in use`
        }]
      };
    }
  }

  async addNetworkLXC(node, vmid, net, bridge, ip, gw, firewall) {
    if (!this.allowElevated) {
      return {
        content: [{
          type: 'text',
          text: `⚠️  **Network Management Requires Elevated Permissions**\n\nTo add LXC network interfaces, set \`PROXMOX_ALLOW_ELEVATED=true\` in your .env file.\n\n**Current permissions**: Basic (read-only)`
        }]
      };
    }

    try {
      // Validate inputs
      const safeNode = this.validateNodeName(node);
      const safeVMID = this.validateVMID(vmid);

      // Extract interface number (e.g., net0 -> 0, net1 -> 1)
      const netNum = net.replace('net', '');

      // Build network configuration string
      let netConfig = `name=eth${netNum},bridge=${bridge}`;

      if (ip) {
        netConfig += `,ip=${ip}`;
      }

      if (gw) {
        netConfig += `,gw=${gw}`;
      }

      if (firewall) {
        netConfig += `,firewall=1`;
      }

      const body = {
        [net]: netConfig
      };

      await this.proxmoxRequest(`/nodes/${safeNode}/lxc/${safeVMID}/config`, 'PUT', body);

      let output = `🌐 **LXC Network Interface Added**\n\n`;
      output += `• **Container ID**: ${safeVMID}\n`;
      output += `• **Node**: ${safeNode}\n`;
      output += `• **Interface**: ${net} (eth${netNum})\n`;
      output += `• **Bridge**: ${bridge}\n`;
      if (ip) output += `• **IP Address**: ${ip}\n`;
      if (gw) output += `• **Gateway**: ${gw}\n`;
      if (firewall) output += `• **Firewall**: Enabled\n`;
      output += `\n**Valid interfaces**: net0, net1, net2, etc.\n`;
      output += `**Valid bridges**: vmbr0, vmbr1, vmbr2, etc.\n`;
      output += `**IP formats**: dhcp, 192.168.1.100/24, auto\n\n`;
      output += `**Tip**: Use DHCP for automatic IP assignment or specify static IP with CIDR notation.\n`;

      return {
        content: [{ type: 'text', text: output }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `❌ **Failed to add LXC network interface**\n\nError: ${error.message}\n\n**Common issues**:\n- Network interface already exists\n- Bridge doesn't exist\n- Invalid IP address format\n- Invalid gateway address\n- Container is locked or in use`
        }]
      };
    }
  }

  async updateNetworkVM(node, vmid, net, bridge, model, macaddr, vlan, firewall) {
    if (!this.allowElevated) {
      return {
        content: [{
          type: 'text',
          text: `⚠️  **Network Management Requires Elevated Permissions**\n\nTo update VM network interfaces, set \`PROXMOX_ALLOW_ELEVATED=true\` in your .env file.\n\n**Current permissions**: Basic (read-only)`
        }]
      };
    }

    try {
      // Validate inputs
      const safeNode = this.validateNodeName(node);
      const safeVMID = this.validateVMID(vmid);

      // Get current VM configuration
      const config = await this.proxmoxRequest(`/nodes/${safeNode}/qemu/${safeVMID}/config`, 'GET');

      if (!config[net]) {
        return {
          content: [{
            type: 'text',
            text: `❌ **Network interface ${net} does not exist**\n\nPlease add the interface first using proxmox_add_network_vm.\n\n**Existing interfaces**: ${Object.keys(config).filter(k => k.startsWith('net')).join(', ') || 'None'}`
          }]
        };
      }

      // Parse current configuration
      const currentConfig = config[net];
      const configParts = {};
      currentConfig.split(',').forEach(part => {
        const [key, value] = part.split('=');
        configParts[key] = value;
      });

      // Update only provided parameters
      if (model !== undefined) {
        // Extract MAC if present, remove old model
        const mac = configParts.macaddr || configParts[Object.keys(configParts).find(k => k.match(/^[0-9A-F]{2}:/i))];
        configParts[model] = mac || '';
        // Remove old model keys
        ['virtio', 'e1000', 'rtl8139', 'vmxnet3'].forEach(m => {
          if (m !== model) delete configParts[m];
        });
      }

      if (bridge !== undefined) {
        configParts.bridge = bridge;
      }

      if (macaddr !== undefined) {
        configParts.macaddr = macaddr;
      }

      if (vlan !== undefined && vlan !== null) {
        configParts.tag = vlan;
      } else if (vlan === null) {
        delete configParts.tag;
      }

      if (firewall !== undefined) {
        if (firewall) {
          configParts.firewall = '1';
        } else {
          delete configParts.firewall;
        }
      }

      // Rebuild configuration string
      const netConfig = Object.entries(configParts)
        .map(([key, value]) => value ? `${key}=${value}` : key)
        .join(',');

      const body = {
        [net]: netConfig
      };

      await this.proxmoxRequest(`/nodes/${safeNode}/qemu/${safeVMID}/config`, 'PUT', body);

      let output = `🔧 **VM Network Interface Updated**\n\n`;
      output += `• **VM ID**: ${safeVMID}\n`;
      output += `• **Node**: ${safeNode}\n`;
      output += `• **Interface**: ${net}\n`;
      output += `• **New Configuration**: ${netConfig}\n\n`;
      output += `**Changes applied**:\n`;
      if (bridge !== undefined) output += `- Bridge: ${bridge}\n`;
      if (model !== undefined) output += `- Model: ${model}\n`;
      if (macaddr !== undefined) output += `- MAC Address: ${macaddr}\n`;
      if (vlan !== undefined) output += `- VLAN Tag: ${vlan !== null ? vlan : 'Removed'}\n`;
      if (firewall !== undefined) output += `- Firewall: ${firewall ? 'Enabled' : 'Disabled'}\n`;

      return {
        content: [{ type: 'text', text: output }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `❌ **Failed to update VM network interface**\n\nError: ${error.message}\n\n**Common issues**:\n- Network interface doesn't exist\n- Bridge doesn't exist\n- Invalid MAC address format\n- Invalid VLAN tag (must be 1-4094)\n- VM is locked or in use`
        }]
      };
    }
  }

  async updateNetworkLXC(node, vmid, net, bridge, ip, gw, firewall) {
    if (!this.allowElevated) {
      return {
        content: [{
          type: 'text',
          text: `⚠️  **Network Management Requires Elevated Permissions**\n\nTo update LXC network interfaces, set \`PROXMOX_ALLOW_ELEVATED=true\` in your .env file.\n\n**Current permissions**: Basic (read-only)`
        }]
      };
    }

    try {
      // Validate inputs
      const safeNode = this.validateNodeName(node);
      const safeVMID = this.validateVMID(vmid);

      // Get current container configuration
      const config = await this.proxmoxRequest(`/nodes/${safeNode}/lxc/${safeVMID}/config`, 'GET');

      if (!config[net]) {
        return {
          content: [{
            type: 'text',
            text: `❌ **Network interface ${net} does not exist**\n\nPlease add the interface first using proxmox_add_network_lxc.\n\n**Existing interfaces**: ${Object.keys(config).filter(k => k.startsWith('net')).join(', ') || 'None'}`
          }]
        };
      }

      // Parse current configuration
      const currentConfig = config[net];
      const configParts = {};
      currentConfig.split(',').forEach(part => {
        const [key, value] = part.split('=');
        configParts[key] = value;
      });

      // Update only provided parameters
      if (bridge !== undefined) {
        configParts.bridge = bridge;
      }

      if (ip !== undefined) {
        configParts.ip = ip;
      }

      if (gw !== undefined) {
        configParts.gw = gw;
      }

      if (firewall !== undefined) {
        if (firewall) {
          configParts.firewall = '1';
        } else {
          delete configParts.firewall;
        }
      }

      // Rebuild configuration string
      const netConfig = Object.entries(configParts)
        .map(([key, value]) => `${key}=${value}`)
        .join(',');

      const body = {
        [net]: netConfig
      };

      await this.proxmoxRequest(`/nodes/${safeNode}/lxc/${safeVMID}/config`, 'PUT', body);

      let output = `🔧 **LXC Network Interface Updated**\n\n`;
      output += `• **Container ID**: ${safeVMID}\n`;
      output += `• **Node**: ${safeNode}\n`;
      output += `• **Interface**: ${net}\n`;
      output += `• **New Configuration**: ${netConfig}\n\n`;
      output += `**Changes applied**:\n`;
      if (bridge !== undefined) output += `- Bridge: ${bridge}\n`;
      if (ip !== undefined) output += `- IP Address: ${ip}\n`;
      if (gw !== undefined) output += `- Gateway: ${gw}\n`;
      if (firewall !== undefined) output += `- Firewall: ${firewall ? 'Enabled' : 'Disabled'}\n`;

      return {
        content: [{ type: 'text', text: output }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `❌ **Failed to update LXC network interface**\n\nError: ${error.message}\n\n**Common issues**:\n- Network interface doesn't exist\n- Bridge doesn't exist\n- Invalid IP address format\n- Invalid gateway address\n- Container is locked or in use`
        }]
      };
    }
  }

  async removeNetworkVM(node, vmid, net) {
    if (!this.allowElevated) {
      return {
        content: [{
          type: 'text',
          text: `⚠️  **Network Management Requires Elevated Permissions**\n\nTo remove VM network interfaces, set \`PROXMOX_ALLOW_ELEVATED=true\` in your .env file.\n\n**Current permissions**: Basic (read-only)`
        }]
      };
    }

    try {
      // Validate inputs
      const safeNode = this.validateNodeName(node);
      const safeVMID = this.validateVMID(vmid);

      const body = {
        delete: net
      };

      await this.proxmoxRequest(`/nodes/${safeNode}/qemu/${safeVMID}/config`, 'PUT', body);

      let output = `➖ **VM Network Interface Removed**\n\n`;
      output += `• **VM ID**: ${safeVMID}\n`;
      output += `• **Node**: ${safeNode}\n`;
      output += `• **Interface Removed**: ${net}\n\n`;
      output += `**Note**: The network interface has been removed from the VM configuration.\n`;
      output += `**Tip**: If the VM is running, you may need to restart it for changes to take effect.\n`;

      return {
        content: [{ type: 'text', text: output }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `❌ **Failed to remove VM network interface**\n\nError: ${error.message}\n\n**Common issues**:\n- Network interface doesn't exist\n- VM is locked or in use\n- Invalid interface name`
        }]
      };
    }
  }

  async removeNetworkLXC(node, vmid, net) {
    if (!this.allowElevated) {
      return {
        content: [{
          type: 'text',
          text: `⚠️  **Network Management Requires Elevated Permissions**\n\nTo remove LXC network interfaces, set \`PROXMOX_ALLOW_ELEVATED=true\` in your .env file.\n\n**Current permissions**: Basic (read-only)`
        }]
      };
    }

    try {
      // Validate inputs
      const safeNode = this.validateNodeName(node);
      const safeVMID = this.validateVMID(vmid);

      const body = {
        delete: net
      };

      await this.proxmoxRequest(`/nodes/${safeNode}/lxc/${safeVMID}/config`, 'PUT', body);

      let output = `➖ **LXC Network Interface Removed**\n\n`;
      output += `• **Container ID**: ${safeVMID}\n`;
      output += `• **Node**: ${safeNode}\n`;
      output += `• **Interface Removed**: ${net}\n\n`;
      output += `**Note**: The network interface has been removed from the container configuration.\n`;
      output += `**Tip**: If the container is running, you may need to restart it for changes to take effect.\n`;

      return {
        content: [{ type: 'text', text: output }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `❌ **Failed to remove LXC network interface**\n\nError: ${error.message}\n\n**Common issues**:\n- Network interface doesn't exist\n- Container is locked or in use\n- Invalid interface name`
        }]
      };
    }
  }

  formatUptime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    
    if (days > 0) {
      return `${days}d ${hours}h ${minutes}m`;
    } else if (hours > 0) {
      return `${hours}h ${minutes}m`;
    } else {
      return `${minutes}m`;
    }
  }

  formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Proxmox MCP server running on stdio');
  }
}

const server = new ProxmoxServer();
server.run().catch(console.error);
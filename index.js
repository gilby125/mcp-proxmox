#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
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

export class ProxmoxServer {
  constructor() {
    this.server = new Server(
      {
        name: 'proxmox-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
          resources: {},
          prompts: {},
        },
      }
    );
    
    this.proxmoxHost = process.env.PROXMOX_HOST;
    if (!this.proxmoxHost) {
      throw new Error('PROXMOX_HOST environment variable is required');
    }
    this.proxmoxUser = process.env.PROXMOX_USER || 'root@pam';
    this.proxmoxTokenName = process.env.PROXMOX_TOKEN_NAME || 'mcpserver';
    this.proxmoxTokenValue = process.env.PROXMOX_TOKEN_VALUE;
    if (!this.proxmoxTokenValue) {
      throw new Error('PROXMOX_TOKEN_VALUE environment variable is required');
    }
    this.proxmoxPort = process.env.PROXMOX_PORT || '8006';
    this.allowElevated = process.env.PROXMOX_ALLOW_ELEVATED === 'true';

    // TLS verification. Proxmox ships with a self-signed certificate, so the
    // default stays off for out-of-the-box compatibility, but operators with a
    // proper CA-signed cert can opt into verification with PROXMOX_VERIFY_TLS=true.
    this.verifyTls = process.env.PROXMOX_VERIFY_TLS === 'true';
    this.httpsAgent = new https.Agent({
      rejectUnauthorized: this.verifyTls
    });

    // Optional allowlists scope which nodes / VMIDs the server may touch.
    // Comma-separated; empty means "no restriction".
    this.nodeAllowlist = this.parseAllowlist(process.env.PROXMOX_NODE_ALLOWLIST);
    this.vmidAllowlist = this.parseAllowlist(process.env.PROXMOX_VMID_ALLOWLIST);

    this.fetch = fetch;

    this.setupToolHandlers();
    this.setupResourceHandlers();
    this.setupPromptHandlers();
  }

  // Browsable, read-only views of the cluster. Resources let clients pull
  // structured cluster state without invoking a tool.
  setupResourceHandlers() {
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: [
        {
          uri: 'proxmox://nodes',
          name: 'Cluster nodes',
          description: 'All Proxmox nodes with status and resource usage (JSON)',
          mimeType: 'application/json',
        },
        {
          uri: 'proxmox://vms',
          name: 'All guests',
          description: 'Every VM and container across the cluster with node placement (JSON)',
          mimeType: 'application/json',
        },
        {
          uri: 'proxmox://storage',
          name: 'Storage pools',
          description: 'Storage pools and usage across the cluster (JSON)',
          mimeType: 'application/json',
        },
      ],
    }));

    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const uri = request.params.uri;
      let payload;
      try {
        payload = await this.readResourcePayload(uri);
      } catch (error) {
        payload = { error: error.message };
      }
      return {
        contents: [{
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(payload ?? null, null, 2),
        }],
      };
    });
  }

  async readResourcePayload(uri) {
    if (uri === 'proxmox://nodes') {
      return this.proxmoxRequest('/nodes');
    }
    if (uri === 'proxmox://vms') {
      return this.proxmoxRequest('/cluster/resources?type=vm');
    }
    if (uri === 'proxmox://storage') {
      return this.proxmoxRequest('/cluster/resources?type=storage');
    }
    throw new Error(`Unknown resource: ${uri}`);
  }

  // Templated workflows exposed as MCP prompts.
  setupPromptHandlers() {
    const prompts = [
      {
        name: 'provision_lxc',
        description: 'Guided workflow to provision a new LXC container end to end',
        arguments: [
          { name: 'distro', description: 'Distribution, e.g. debian-12 or ubuntu-22.04', required: false },
          { name: 'purpose', description: 'What the container is for (sizing hint)', required: false },
        ],
      },
      {
        name: 'health_check',
        description: 'Review overall cluster health and flag anything concerning',
        arguments: [],
      },
      {
        name: 'diagnose_permissions',
        description: 'Diagnose an "elevated permissions" or access error for the current token',
        arguments: [],
      },
    ];

    this.promptDefinitions = prompts;

    this.server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts }));

    this.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      const { name, arguments: pArgs = {} } = request.params;
      const text = this.getPromptText(name, pArgs);
      return {
        messages: [{ role: 'user', content: { type: 'text', text } }],
      };
    });
  }

  getPromptText(name, pArgs = {}) {
    let text;
    {
      if (name === 'provision_lxc') {
        const distro = pArgs.distro || 'debian-12';
        const purpose = pArgs.purpose ? ` intended for ${pArgs.purpose}` : '';
        text = `Provision a new LXC container${purpose} running ${distro}.\n\n` +
          `Steps:\n` +
          `1. Call proxmox_get_nodes and pick a node with free capacity.\n` +
          `2. Call proxmox_list_templates on that node; confirm a ${distro} template exists (download it if not).\n` +
          `3. Call proxmox_get_next_vmid for a free ID.\n` +
          `4. Call proxmox_create_lxc with sensible cores/memory/disk for the purpose.\n` +
          `5. Call proxmox_start_lxc, then poll proxmox_get_task_status until it finishes.\n` +
          `6. Report the container ID, node, and how to reach it.`;
      } else if (name === 'health_check') {
        text = `Perform a Proxmox cluster health check.\n\n` +
          `1. proxmox_get_cluster_status and proxmox_get_nodes — flag any node not online or with high CPU/memory.\n` +
          `2. proxmox_get_storage — flag any pool above 85% usage.\n` +
          `3. proxmox_get_vms — note stopped guests that are expected to run.\n` +
          `4. proxmox_get_ha_resources — confirm HA resources are in their desired state.\n` +
          `Summarize findings with concrete numbers and a short prioritized action list.`;
      } else if (name === 'diagnose_permissions') {
        text = `The user hit a permissions error. Diagnose it:\n\n` +
          `1. Call proxmox_whoami to see the token's user and effective permissions.\n` +
          `2. Compare the required privilege for the failed action against what the token has.\n` +
          `3. State exactly which privilege/path is missing and whether PROXMOX_ALLOW_ELEVATED needs to be set.\n` +
          `4. Give the precise pveum command or UI steps to grant it.`;
      } else {
        throw new Error(`Unknown prompt: ${name}`);
      }
    }
    return text;
  }

  parseAllowlist(raw) {
    if (!raw || typeof raw !== 'string') {
      return null;
    }
    const entries = raw.split(',').map(s => s.trim()).filter(Boolean);
    return entries.length > 0 ? new Set(entries) : null;
  }

  // Pause execution; overridable in tests so polling loops resolve instantly.
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
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
    if (this.nodeAllowlist && !this.nodeAllowlist.has(node)) {
      throw new Error(
        `Node "${node}" is not in PROXMOX_NODE_ALLOWLIST. ` +
        `Allowed nodes: ${[...this.nodeAllowlist].join(', ')}`
      );
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
    const idStr = id.toString();
    if (this.vmidAllowlist && !this.vmidAllowlist.has(idStr)) {
      throw new Error(
        `VMID ${idStr} is not in PROXMOX_VMID_ALLOWLIST. ` +
        `Allowed VMIDs: ${[...this.vmidAllowlist].join(', ')}`
      );
    }
    return idStr;
  }

  validateGuestType(type, fallback = 'qemu') {
    const value = type === undefined || type === null ? fallback : type;
    if (value !== 'qemu' && value !== 'lxc') {
      throw new Error("Invalid guest type. Must be 'qemu' or 'lxc'");
    }
    return value;
  }

  validateStorageName(storage) {
    if (!storage || typeof storage !== 'string') {
      throw new Error('Storage name is required and must be a string');
    }
    // Proxmox storage IDs: alphanumeric, hyphens, underscores, dots
    if (!/^[a-zA-Z0-9\-_.]+$/.test(storage)) {
      throw new Error('Invalid storage name format. Only alphanumeric, hyphens, underscores, and dots allowed');
    }
    if (storage.length > 64) {
      throw new Error('Storage name too long (max 64 characters)');
    }
    return storage;
  }

  validateSnapshotName(snapname) {
    if (!snapname || typeof snapname !== 'string') {
      throw new Error('Snapshot name is required and must be a string');
    }
    // Proxmox snapshot names: alphanumeric, hyphens, underscores
    if (!/^[a-zA-Z0-9\-_]+$/.test(snapname)) {
      throw new Error('Invalid snapshot name format. Only alphanumeric, hyphens, and underscores allowed');
    }
    if (snapname.length > 40) {
      throw new Error('Snapshot name too long (max 40 characters)');
    }
    return snapname;
  }

  validateDiskName(disk) {
    if (!disk || typeof disk !== 'string') {
      throw new Error('Disk name is required and must be a string');
    }

    if (disk === 'rootfs' || disk === 'efidisk0' || disk === 'tpmstate0') {
      return disk;
    }

    const match = disk.match(/^(scsi|virtio|sata|ide|mp|unused)(\d+)$/);
    if (!match) {
      throw new Error('Invalid disk name format. Expected: scsi0-30, virtio0-15, sata0-5, ide0-3, efidisk0, tpmstate0, rootfs, mp0-255, or unusedN');
    }

    const [, prefix, numStr] = match;
    const num = parseInt(numStr, 10);
    if (!Number.isFinite(num) || num < 0) {
      throw new Error('Invalid disk number');
    }

    const maxByPrefix = {
      scsi: 30,
      virtio: 15,
      sata: 5,
      ide: 3,
      mp: 255,
      unused: Number.POSITIVE_INFINITY,
    };

    const max = maxByPrefix[prefix];
    if (Number.isFinite(max) && num > max) {
      throw new Error(`Disk number out of range for ${prefix} (max: ${prefix}${max})`);
    }

    return disk;
  }

  validateNetworkName(net) {
    if (!net || typeof net !== 'string') {
      throw new Error('Network interface name is required and must be a string');
    }
    const match = net.match(/^net(\d{1,2})$/);
    if (!match) {
      throw new Error('Invalid network interface name. Expected: net0-31');
    }
    const num = parseInt(match[1], 10);
    if (!Number.isFinite(num) || num < 0 || num > 31) {
      throw new Error('Network interface number out of range (max: net31)');
    }
    return `net${num}`;
  }

  validateBridgeName(bridge) {
    if (!bridge || typeof bridge !== 'string') {
      throw new Error('Bridge name is required and must be a string');
    }
    // Proxmox bridge identifiers may also contain dots, e.g. vmbr0.100.
    if (!/^[a-zA-Z0-9._-]+$/.test(bridge)) {
      throw new Error('Invalid bridge name format. Only alphanumeric, periods, hyphens, and underscores allowed');
    }
    if (bridge.length > 32) {
      throw new Error('Bridge name too long (max 32 characters)');
    }
    return bridge;
  }

  validateMountPoint(mp) {
    if (!mp || typeof mp !== 'string') {
      throw new Error('Mount point name is required and must be a string');
    }
    if (mp === 'rootfs') {
      return mp;
    }
    const match = mp.match(/^mp(\d{1,3})$/);
    if (!match) {
      throw new Error('Invalid mount point name. Expected: mp0-255 or rootfs');
    }
    const num = parseInt(match[1], 10);
    if (!Number.isFinite(num) || num < 0 || num > 255) {
      throw new Error('Mount point number out of range (max: mp255)');
    }
    return `mp${num}`;
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

  validateUPID(upid) {
    if (!upid || typeof upid !== 'string') {
      throw new Error('UPID is required and must be a string');
    }
    // Proxmox task UPIDs look like:
    // UPID:node:0000ABCD:12345678:5F3A1B2C:vzdump:100:root@pam:
    // Allow the documented character set only, so it is safe to interpolate
    // into the tasks path.
    if (!/^UPID:[^:]+:[0-9A-Fa-f]+:[0-9A-Fa-f]+:[0-9A-Fa-f]+:[^:]+:[^:]*:[^:]+:$/.test(upid)) {
      throw new Error('Invalid UPID format');
    }
    if (upid.length > 256) {
      throw new Error('UPID too long (max 256 characters)');
    }
    return upid;
  }

  // Build an MCP tool result carrying both human-readable text and a machine
  // readable structuredContent payload, so agents can chain on the data
  // instead of regex-parsing prose. Older MCP clients simply ignore the extra
  // field and render the text.
  respond(text, structured = undefined, isError = false) {
    const result = { content: [{ type: 'text', text }] };
    if (structured !== undefined) {
      result.structuredContent = structured;
    }
    if (isError) {
      result.isError = true;
    }
    return result;
  }

  // Extract a UPID from a mutating-endpoint response. Proxmox returns the UPID
  // either as a bare string or wrapped in an object.
  extractUPID(result) {
    if (typeof result === 'string' && result.startsWith('UPID:')) {
      return result;
    }
    if (result && typeof result === 'object') {
      for (const key of ['upid', 'UPID', 'data']) {
        const val = result[key];
        if (typeof val === 'string' && val.startsWith('UPID:')) {
          return val;
        }
      }
    }
    return null;
  }

  generateSecurePassword() {
    // Generate a secure random password using Node.js crypto
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
    let password = '';

    for (let i = 0; i < 16; i++) {
      password += chars[crypto.randomInt(chars.length)];
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
      const response = await this.fetch(url, options);

      if (!response.ok) {
        const errorText = await response.text();
        if (response.status === 596 && /no such cluster node/i.test(errorText)) {
          const nodeMatch = endpoint.match(/^\/nodes\/([^/]+)/);
          if (nodeMatch) {
            const requestedNode = nodeMatch[1];
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000);

            try {
              const nodesResponse = await this.fetch(`${baseUrl}/nodes`, {
                method: 'GET',
                headers,
                agent: this.httpsAgent,
                signal: controller.signal
              });

              if (nodesResponse.ok) {
                const nodesBody = JSON.parse(await nodesResponse.text());
                const knownNodes = (nodesBody.data || [])
                  .map((node) => node?.node)
                  .filter((node) => typeof node === 'string');
                const canonicalNode = knownNodes.find(
                  (node) => node.toLowerCase() === requestedNode.toLowerCase()
                );

                if (canonicalNode && canonicalNode !== requestedNode) {
                  throw new Error(
                    `Proxmox returned 596 proxying to node "${requestedNode}". ` +
                    `Node name does not match a cluster member ` +
                    `(lookup is case-sensitive). ` +
                    `Did you mean "${canonicalNode}"? ` +
                    `Known nodes: ${knownNodes.join(', ')}.`
                  );
                }

                if (!canonicalNode) {
                  throw new Error(
                    `Proxmox returned 596 proxying to node "${requestedNode}". ` +
                    `The node is unknown to the cluster. ` +
                    `Known nodes: ${knownNodes.join(', ')}. ` +
                    `Other 596 causes include proxy timeouts and cert issues.`
                  );
                }
              }
            } catch (lookupError) {
              if (lookupError.message?.startsWith('Proxmox returned 596')) {
                throw lookupError;
              }
            } finally {
              clearTimeout(timeoutId);
            }
          }
        }

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
      const isNetworkError =
        ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNRESET', 'EHOSTUNREACH']
          .includes(error.code) ||
        error.name === 'FetchError' ||
        (error.name === 'TypeError' && /fetch failed/i.test(error.message));

      if (isNetworkError) {
        throw new Error(`Failed to connect to Proxmox: ${error.message}`);
      }

      throw error;
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
              type: { type: 'string', enum: ['qemu', 'lxc'], description: 'VM type', default: 'qemu' },
              wait: { type: 'boolean', description: 'Poll the guest agent for the result (stdout/exit code) instead of only returning the PID (default: true)', default: true }
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
        },
        {
          name: 'proxmox_generate_terraform',
          description: 'Generate Terraform/OpenTofu HCL (bpg/proxmox provider) from existing VMs and containers, including import blocks to adopt them without recreation',
          inputSchema: {
            type: 'object',
            properties: {
              node: { type: 'string', description: 'Optional: only export guests on this node' },
              vmid: { type: 'string', description: 'Optional: only export this VM/container ID' },
              type: { type: 'string', enum: ['qemu', 'lxc', 'all'], description: 'Guest type filter', default: 'all' },
              include_provider: { type: 'boolean', description: 'Include terraform/provider scaffolding block (default: true)', default: true }
            }
          }
        },
        {
          name: 'proxmox_get_task_status',
          description: 'Get the status of a Proxmox task by UPID (the identifier returned by mutating operations like create/clone/backup/migrate). Optionally wait for the task to finish and report its exit status.',
          inputSchema: {
            type: 'object',
            properties: {
              node: { type: 'string', description: 'Node the task is running on' },
              upid: { type: 'string', description: 'Task UPID, e.g. UPID:pve1:0000ABCD:...:vzdump:100:root@pam:' },
              wait: { type: 'boolean', description: 'Poll until the task finishes (default: false)', default: false },
              timeout: { type: 'number', description: 'Max seconds to wait when wait=true (default: 60, max: 600)', default: 60 }
            },
            required: ['node', 'upid']
          }
        },
        {
          name: 'proxmox_get_vm_config',
          description: 'Get the full configuration of a VM or LXC container (cores, memory, disks, network, cloud-init, etc.)',
          inputSchema: {
            type: 'object',
            properties: {
              node: { type: 'string', description: 'Node where the guest is located' },
              vmid: { type: 'string', description: 'VM/container ID' },
              type: { type: 'string', enum: ['qemu', 'lxc'], description: 'Guest type', default: 'qemu' }
            },
            required: ['node', 'vmid']
          }
        },
        {
          name: 'proxmox_whoami',
          description: 'Show the identity the server authenticates as and the permissions the API token actually has. Use this to diagnose "requires elevated permissions" errors.',
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Optional: check permissions for a specific ACL path (e.g. /vms/100)' }
            }
          }
        },
        {
          name: 'proxmox_migrate_vm',
          description: 'Migrate a VM or LXC container to another node (requires elevated permissions)',
          inputSchema: {
            type: 'object',
            properties: {
              node: { type: 'string', description: 'Current node hosting the guest' },
              vmid: { type: 'string', description: 'VM/container ID' },
              target: { type: 'string', description: 'Destination node' },
              type: { type: 'string', enum: ['qemu', 'lxc'], description: 'Guest type', default: 'qemu' },
              online: { type: 'boolean', description: 'QEMU: live-migrate a running VM. LXC: use restart migration.', default: false },
              wait: { type: 'boolean', description: 'Wait for the migration task to finish (default: false)', default: false }
            },
            required: ['node', 'vmid', 'target']
          }
        },
        {
          name: 'proxmox_get_guest_ips',
          description: "Discover a running VM's real IP addresses via the QEMU guest agent (qemu only; requires elevated permissions and a running guest agent)",
          inputSchema: {
            type: 'object',
            properties: {
              node: { type: 'string', description: 'Node where the VM is located' },
              vmid: { type: 'string', description: 'VM ID' }
            },
            required: ['node', 'vmid']
          }
        },
        {
          name: 'proxmox_convert_to_template',
          description: 'Convert a VM or LXC container into a template (irreversible; requires elevated permissions). Pairs with the clone tools for a golden-image workflow.',
          inputSchema: {
            type: 'object',
            properties: {
              node: { type: 'string', description: 'Node where the guest is located' },
              vmid: { type: 'string', description: 'VM/container ID' },
              type: { type: 'string', enum: ['qemu', 'lxc'], description: 'Guest type', default: 'qemu' }
            },
            required: ['node', 'vmid']
          }
        },
        {
          name: 'proxmox_set_cloudinit',
          description: 'Set cloud-init options on a QEMU VM (user, password, SSH keys, IP config, DNS). Requires a cloud-init drive on the VM and elevated permissions.',
          inputSchema: {
            type: 'object',
            properties: {
              node: { type: 'string', description: 'Node where the VM is located' },
              vmid: { type: 'string', description: 'VM ID' },
              ciuser: { type: 'string', description: 'Default cloud-init user' },
              cipassword: { type: 'string', description: 'Password for the cloud-init user' },
              sshkeys: { type: 'string', description: 'One or more public SSH keys (newline separated)' },
              ipconfig0: { type: 'string', description: 'IP config for net0, e.g. ip=192.168.1.50/24,gw=192.168.1.1 or ip=dhcp' },
              nameserver: { type: 'string', description: 'DNS nameserver(s)' },
              searchdomain: { type: 'string', description: 'DNS search domain' }
            },
            required: ['node', 'vmid']
          }
        },
        {
          name: 'proxmox_get_rrd_data',
          description: 'Get historical performance metrics (CPU, memory, disk, network time series) for a VM/container or a node, for capacity planning.',
          inputSchema: {
            type: 'object',
            properties: {
              node: { type: 'string', description: 'Node name' },
              vmid: { type: 'string', description: 'Optional: VM/container ID. Omit for node-level metrics.' },
              type: { type: 'string', enum: ['qemu', 'lxc'], description: 'Guest type (when vmid is given)', default: 'qemu' },
              timeframe: { type: 'string', enum: ['hour', 'day', 'week', 'month', 'year'], description: 'Time window', default: 'day' }
            },
            required: ['node']
          }
        },
        {
          name: 'proxmox_get_pools',
          description: 'List resource pools and their members (read-only observability)',
          inputSchema: {
            type: 'object',
            properties: {
              poolid: { type: 'string', description: 'Optional: show members of a specific pool' }
            }
          }
        },
        {
          name: 'proxmox_get_ha_resources',
          description: 'List High Availability resources and their configured state (read-only observability)',
          inputSchema: {
            type: 'object',
            properties: {}
          }
        },
        {
          name: 'proxmox_get_firewall_rules',
          description: 'List firewall rules at the cluster level, a node, or a specific guest (read-only observability)',
          inputSchema: {
            type: 'object',
            properties: {
              level: { type: 'string', enum: ['cluster', 'node', 'guest'], description: 'Which firewall ruleset to read', default: 'cluster' },
              node: { type: 'string', description: 'Node name (required for level=node or level=guest)' },
              vmid: { type: 'string', description: 'VM/container ID (required for level=guest)' },
              type: { type: 'string', enum: ['qemu', 'lxc'], description: 'Guest type (for level=guest)', default: 'qemu' }
            }
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
            return await this.executeVMCommand(args.node, args.vmid, args.command, args.type, args.wait);
            
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

          case 'proxmox_generate_terraform':
            return await this.generateTerraform(args.node, args.vmid, args.type, args.include_provider);

          case 'proxmox_get_task_status':
            return await this.getTaskStatus(args.node, args.upid, args.wait, args.timeout);

          case 'proxmox_get_vm_config':
            return await this.getVMConfig(args.node, args.vmid, args.type);

          case 'proxmox_whoami':
            return await this.whoami(args.path);

          case 'proxmox_migrate_vm':
            return await this.migrateGuest(args.node, args.vmid, args.target, args.type, args.online, args.wait);

          case 'proxmox_get_guest_ips':
            return await this.getGuestIPs(args.node, args.vmid);

          case 'proxmox_convert_to_template':
            return await this.convertToTemplate(args.node, args.vmid, args.type);

          case 'proxmox_set_cloudinit':
            return await this.setCloudInit(args);

          case 'proxmox_get_rrd_data':
            return await this.getRRDData(args.node, args.vmid, args.type, args.timeframe);

          case 'proxmox_get_pools':
            return await this.getPools(args.poolid);

          case 'proxmox_get_ha_resources':
            return await this.getHAResources();

          case 'proxmox_get_firewall_rules':
            return await this.getFirewallRules(args.level, args.node, args.vmid, args.type);

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

    return this.respond(output, {
      count: nodes.length,
      nodes: nodes.map(n => ({
        node: n.node,
        status: n.status,
        uptime: n.uptime ?? null,
        cpu: typeof n.cpu === 'number' ? n.cpu : null,
        maxcpu: n.maxcpu ?? null,
        mem: n.mem ?? null,
        maxmem: n.maxmem ?? null,
      })),
    });
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

      return this.respond(output, { node: safeNode, status });
    } catch (error) {
      return this.respond(
        `❌ **Failed to get node status**\n\nError: ${error.message}`,
        { error: error.message },
        true
      );
    }
  }

  // Enumerate guests one node at a time. Used as a fallback when
  // /cluster/resources is unavailable (restricted token, older API).
  async collectGuestsPerNode(nodeFilter, wantQemu, wantLxc) {
    const vms = [];
    const nodeNames = nodeFilter
      ? [nodeFilter]
      : (await this.proxmoxRequest('/nodes') || []).map(n => n.node);

    for (const nodeName of nodeNames) {
      if (wantQemu) {
        const nodeVMs = await this.proxmoxRequest(`/nodes/${nodeName}/qemu`);
        vms.push(...(nodeVMs || []).map(vm => ({ ...vm, type: 'qemu', node: nodeName })));
      }
      if (wantLxc) {
        const nodeLXCs = await this.proxmoxRequest(`/nodes/${nodeName}/lxc`);
        vms.push(...(nodeLXCs || []).map(vm => ({ ...vm, type: 'lxc', node: nodeName })));
      }
    }
    return vms;
  }

  async getVMs(nodeFilter = null, typeFilter = 'all') {
    const safeNodeFilter = nodeFilter ? this.validateNodeName(nodeFilter) : null;
    const wantQemu = typeFilter === 'all' || typeFilter === 'qemu';
    const wantLxc = typeFilter === 'all' || typeFilter === 'lxc';

    let vms = [];
    try {
      // One round-trip returns every guest with its node placement — the same
      // call the Proxmox web UI uses, instead of looping node-by-node.
      const resources = await this.proxmoxRequest('/cluster/resources?type=vm');
      vms = (resources || [])
        .filter(r => r && (r.type === 'qemu' || r.type === 'lxc'))
        .map(r => ({ ...r, type: r.type, node: r.node }));
    } catch (clusterError) {
      vms = await this.collectGuestsPerNode(safeNodeFilter, wantQemu, wantLxc);
    }

    vms = vms.filter(vm => {
      if (safeNodeFilter && vm.node !== safeNodeFilter) return false;
      if (vm.type === 'qemu' && !wantQemu) return false;
      if (vm.type === 'lxc' && !wantLxc) return false;
      return true;
    });

    vms.sort((a, b) => parseInt(a.vmid) - parseInt(b.vmid));

    let output = '💻 **Virtual Machines**\n\n';

    if (vms.length === 0) {
      output += 'No virtual machines found.\n';
    } else {
      for (const vm of vms) {
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

    const structured = {
      count: vms.length,
      vms: vms.map(vm => ({
        vmid: parseInt(vm.vmid, 10),
        name: vm.name || null,
        type: vm.type,
        node: vm.node,
        status: vm.status || null,
        cpu: typeof vm.cpu === 'number' ? vm.cpu : null,
        maxcpu: vm.maxcpu ?? null,
        mem: vm.mem ?? null,
        maxmem: vm.maxmem ?? null,
        uptime: vm.uptime ?? null,
      })),
    };

    return this.respond(output, structured);
  }

  async getVMStatus(node, vmid, type = 'qemu') {
    try {
      // Validate inputs
      const safeNode = this.validateNodeName(node);
      const safeVMID = this.validateVMID(vmid);
      const safeType = this.validateGuestType(type, 'qemu');

      const vmStatus = await this.proxmoxRequest(`/nodes/${safeNode}/${safeType}/${safeVMID}/status/current`);

      const status = vmStatus.status === 'running' ? '🟢' : vmStatus.status === 'stopped' ? '🔴' : '🟡';
      const typeIcon = safeType === 'qemu' ? '🖥️' : '📦';

      let output = `${status} ${typeIcon} **${vmStatus.name || `VM-${safeVMID}`}** (ID: ${safeVMID})\n\n`;
      output += `• **Node**: ${safeNode}\n`;
    output += `• **Status**: ${vmStatus.status}\n`;
    output += `• **Type**: ${safeType.toUpperCase()}\n`;
    
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

      return this.respond(output, {
        node: safeNode,
        vmid: parseInt(safeVMID, 10),
        type: safeType,
        status: vmStatus.status ?? null,
        raw: vmStatus,
      });
    } catch (error) {
      return this.respond(`❌ Failed to get VM status: ${error.message}`, { error: error.message }, true);
    }
  }

  async executeVMCommand(node, vmid, command, type = 'qemu', wait = true) {
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
      const safeType = this.validateGuestType(type, 'qemu');

      // The Proxmox HTTP API has no exec endpoint for LXC containers; commands
      // can only be run via the QEMU guest agent. Fail clearly instead of
      // POSTing to a path that does not exist.
      if (safeType !== 'qemu') {
        return {
          content: [{
            type: 'text',
            text: `⚠️  **Command execution is not supported for LXC containers**\n\nThe Proxmox API only exposes command execution for QEMU VMs (via the guest agent). There is no equivalent HTTP endpoint for containers.\n\n**Alternatives**: run the command over SSH, or use \`pct exec ${safeVMID} -- <command>\` on the Proxmox host.`
          }]
        };
      }

      const safeCommand = this.validateCommand(command);

      // The guest agent expects the command as a list of program + arguments,
      // not a single string. validateCommand already rejects shell
      // metacharacters, so a whitespace split yields a safe argv.
      const commandArgv = safeCommand.trim().split(/\s+/);

      const result = await this.proxmoxRequest(`/nodes/${safeNode}/qemu/${safeVMID}/agent/exec`, 'POST', {
        command: commandArgv
      });

      const pid = result && (result.pid ?? result.PID);

      // Without a PID we cannot poll; return what we have.
      if (wait === false || pid === undefined || pid === null) {
        let output = `💻 **Command executed on VM ${safeVMID}**\n\n`;
        output += `**Command**: \`${safeCommand}\`\n`;
        output += `**Result**: Command submitted to guest agent\n`;
        output += `**PID**: ${pid ?? 'N/A'}\n\n`;
        output += `*Note: pass wait=true (default) to poll exec-status for stdout and exit code.*`;
        return this.respond(output, {
          node: safeNode, vmid: parseInt(safeVMID, 10), command: safeCommand,
          pid: pid ?? null, exited: false,
        });
      }

      // Poll the guest agent for completion, then report the real result.
      // The command has already been launched (we have a PID), so a transient
      // polling failure must NOT be reported as "command failed" — surface the
      // PID so the caller can follow up.
      const statusPath = `/nodes/${safeNode}/qemu/${safeVMID}/agent/exec-status?pid=${encodeURIComponent(String(pid))}`;
      const maxMs = 30000;
      const start = Date.now();
      let execStatus;
      try {
        execStatus = await this.proxmoxRequest(statusPath);
        // The `exited` field is a boolean in the API schema but historically
        // serializes as 0/1 — accept both truthy forms.
        while (execStatus && !execStatus.exited && (Date.now() - start) < maxMs) {
          await this.sleep(1000);
          execStatus = await this.proxmoxRequest(statusPath);
        }
      } catch (pollError) {
        return this.respond(
          `⚠️ **Command launched on VM ${safeVMID}, but reading its result failed**\n\n` +
          `**Command**: \`${safeCommand}\`\n**PID**: ${pid}\n\n` +
          `Error while polling exec-status: ${pollError.message}\n\n` +
          `The command is running; query exec-status for PID ${pid} to retrieve the result.`,
          { node: safeNode, vmid: parseInt(safeVMID, 10), command: safeCommand, pid, exited: false, pollError: pollError.message },
          false
        );
      }
      execStatus = execStatus || {};

      const exited = !!execStatus.exited;
      const exitcode = execStatus.exitcode ?? null;
      const stdout = execStatus['out-data'] ?? '';
      const stderr = execStatus['err-data'] ?? '';
      // Only assert failure when we actually have a non-zero numeric exit code.
      // A signaled process reports `signal` with no exitcode — flag that too.
      const failed = exited && ((typeof exitcode === 'number' && exitcode !== 0) || (exitcode === null && execStatus.signal != null));
      const icon = !exited ? '⏳' : (failed ? '❌' : '✅');

      let output = `${icon} **Command on VM ${safeVMID}**\n\n`;
      output += `**Command**: \`${safeCommand}\`\n`;
      output += `**PID**: ${pid}\n`;
      if (!exited) {
        output += `**Status**: still running after ${maxMs / 1000}s (partial result)\n`;
      } else if (exitcode !== null) {
        output += `**Exit code**: ${exitcode}\n`;
      } else if (execStatus.signal != null) {
        output += `**Terminated by signal**: ${execStatus.signal}\n`;
      }
      if (stdout) output += `\n**stdout**:\n\`\`\`\n${stdout}\n\`\`\`\n`;
      if (stderr) output += `\n**stderr**:\n\`\`\`\n${stderr}\n\`\`\`\n`;
      if (!stdout && !stderr && exited) output += `\n_(no output)_\n`;

      return this.respond(output, {
        node: safeNode, vmid: parseInt(safeVMID, 10), command: safeCommand,
        pid, exited, exitcode, stdout, stderr,
        signal: execStatus.signal ?? null,
      }, failed);
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `❌ **Failed to execute command on VM ${vmid}**\n\nError: ${error.message}\n\n*Note: Make sure the VM has guest agent installed and running*`
        }],
        isError: true
      };
    }
  }

  async getStorage(nodeFilter = null) {
    let storages = [];
    
    if (nodeFilter) {
      const safeNodeFilter = this.validateNodeName(nodeFilter);
      storages = await this.proxmoxRequest(`/nodes/${safeNodeFilter}/storage`);
      storages = storages.map(storage => ({ ...storage, node: safeNodeFilter }));
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
      // Each row is a distinct storage/node pairing; the API does not return
      // duplicates, so we list every pairing (shared storage appears once per
      // node, which is intentional — usage is reported per node).
      for (const storage of storages.sort((a, b) => a.storage.localeCompare(b.storage))) {
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

    return this.respond(output, {
      count: storages.length,
      storages: storages.map(s => ({
        storage: s.storage,
        node: s.node,
        type: s.type ?? null,
        content: s.content ?? null,
        enabled: !!s.enabled,
        total: s.total ?? null,
        used: s.used ?? null,
        avail: s.avail ?? null,
      })),
    });
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
      const safeStorage = this.validateStorageName(storage);

      const templates = await this.proxmoxRequest(`/nodes/${safeNode}/storage/${safeStorage}/content?content=vztmpl`);

      let output = '📦 **Available LXC Templates**\n\n';

      if (!templates || templates.length === 0) {
        output += `No templates found on storage \`${safeStorage}\`.\n\n`;
        output += `**Tip**: Download templates in Proxmox:\n`;
        output += `1. Go to your node → Storage → ${safeStorage}\n`;
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
      // Extract the leading number, preserving decimals (e.g. "8G" -> "8",
      // "1.5G" -> "1.5"). A blind digit-strip would turn "1.5G" into "15".
      const sizeMatch = String(diskSize).match(/^(\d+(?:\.\d+)?)/);
      if (!sizeMatch) {
        throw new Error(`Invalid disk size "${diskSize}". Expected a number optionally followed by a unit (e.g. "8G").`);
      }
      const sizeValue = sizeMatch[1];
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
      const safeType = this.validateGuestType(type, 'lxc');

      // Safety rail: refuse to delete a guest that has the protection flag set,
      // mirroring the Proxmox UI. The operator must clear `protection` first.
      try {
        const config = await this.proxmoxRequest(`/nodes/${safeNode}/${safeType}/${safeVMID}/config`);
        if (config && (config.protection === 1 || config.protection === '1' || config.protection === true)) {
          return this.respond(
            `🛡️ **Deletion blocked — guest ${safeVMID} is protected**\n\n` +
            `The \`protection\` flag is set on this ${safeType.toUpperCase()}. ` +
            `Clear it in the Proxmox UI (Options → Protection) or via the API before deleting.`,
            { error: 'protected', node: safeNode, vmid: parseInt(safeVMID, 10), type: safeType, protection: true },
            true
          );
        }
      } catch (configError) {
        // If we cannot read the config (e.g. permissions), fall through and let
        // the DELETE itself enforce whatever the API allows.
      }

      const result = await this.proxmoxRequest(`/nodes/${safeNode}/${safeType}/${safeVMID}`, 'DELETE');

      let output = `🗑️  **VM/Container Deletion Started**\n\n`;
      output += `• **VM/Container ID**: ${safeVMID}\n`;
      output += `• **Type**: ${safeType.toUpperCase()}\n`;
      output += `• **Node**: ${safeNode}\n`;
      output += `• **Task ID**: ${result || 'N/A'}\n\n`;
      output += `**Note**: Deletion may take a moment to complete.\n`;

      return this.respond(output, {
        node: safeNode, vmid: parseInt(safeVMID, 10), type: safeType, upid: this.extractUPID(result),
      });
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
      const safeSnapname = this.validateSnapshotName(snapname);

      const result = await this.proxmoxRequest(`/nodes/${safeNode}/${type}/${safeVMID}/snapshot`, 'POST', {
        snapname: safeSnapname
      });

      let output = `📸 **Snapshot Creation Started**\n\n`;
      output += `• **VM ID**: ${safeVMID}\n`;
      output += `• **Snapshot Name**: ${safeSnapname}\n`;
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
      const safeSnapname = this.validateSnapshotName(snapname);

      const result = await this.proxmoxRequest(`/nodes/${safeNode}/${type}/${safeVMID}/snapshot/${safeSnapname}/rollback`, 'POST', {});

      let output = `⏮️  **Snapshot Rollback Started**\n\n`;
      output += `• **VM ID**: ${safeVMID}\n`;
      output += `• **Snapshot Name**: ${safeSnapname}\n`;
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
      const safeSnapname = this.validateSnapshotName(snapname);

      const result = await this.proxmoxRequest(`/nodes/${safeNode}/${type}/${safeVMID}/snapshot/${safeSnapname}`, 'DELETE');

      let output = `🗑️  **Snapshot Deletion Started**\n\n`;
      output += `• **VM ID**: ${safeVMID}\n`;
      output += `• **Snapshot Name**: ${safeSnapname}\n`;
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
      const safeStorage = this.validateStorageName(storage);

      const result = await this.proxmoxRequest(`/nodes/${safeNode}/vzdump`, 'POST', {
        vmid: safeVMID,
        storage: safeStorage,
        mode: mode,
        compress: compress
      });

      let output = `💾 **Backup Creation Started**\n\n`;
      output += `• **VM ID**: ${safeVMID}\n`;
      output += `• **Type**: ${type.toUpperCase()}\n`;
      output += `• **Node**: ${safeNode}\n`;
      output += `• **Storage**: ${safeStorage}\n`;
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
      const safeStorage = this.validateStorageName(storage);

      const backups = await this.proxmoxRequest(`/nodes/${safeNode}/storage/${safeStorage}/content?content=backup`);

      let output = `📦 **Backups on ${safeStorage}**\n\n`;

      if (!backups || backups.length === 0) {
        output += `No backups found on storage \`${safeStorage}\`.\n\n`;
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
      const safeType = this.validateGuestType(type, 'lxc');

      // The two create endpoints take the backup differently:
      //   QEMU: POST /nodes/{node}/qemu  with { archive } (no "restore" key)
      //   LXC:  POST /nodes/{node}/lxc   with { ostemplate: <archive>, restore: 1 }
      // Sending the wrong shape makes Proxmox reject the unknown parameter.
      const body = { vmid: safeVMID };
      if (safeType === 'qemu') {
        body.archive = archive;
      } else {
        body.ostemplate = archive;
        body.restore = 1;
      }

      if (storage) {
        body.storage = this.validateStorageName(storage);
      }

      const result = await this.proxmoxRequest(`/nodes/${safeNode}/${safeType}`, 'POST', body);

      let output = `♻️  **Backup Restore Started**\n\n`;
      output += `• **New VM ID**: ${safeVMID}\n`;
      output += `• **Type**: ${safeType.toUpperCase()}\n`;
      output += `• **Node**: ${safeNode}\n`;
      output += `• **Archive**: ${archive}\n`;
      if (storage) {
        output += `• **Storage**: ${body.storage}\n`;
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
      const safeStorage = this.validateStorageName(storage);

      const encodedVolume = encodeURIComponent(volume);
      const result = await this.proxmoxRequest(`/nodes/${safeNode}/storage/${safeStorage}/content/${encodedVolume}`, 'DELETE');

      let output = `🗑️  **Backup Deletion Started**\n\n`;
      output += `• **Node**: ${safeNode}\n`;
      output += `• **Storage**: ${safeStorage}\n`;
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
      const safeDisk = this.validateDiskName(disk);
      const safeStorage = this.validateStorageName(storage);

      const body = {
        [safeDisk]: `${safeStorage}:${size}`
      };

      const result = await this.proxmoxRequest(`/nodes/${safeNode}/qemu/${safeVMID}/config`, 'PUT', body);

      let output = `💿 **VM Disk Addition Started**\n\n`;
      output += `• **VM ID**: ${safeVMID}\n`;
      output += `• **Node**: ${safeNode}\n`;
      output += `• **Disk**: ${safeDisk}\n`;
      output += `• **Storage**: ${safeStorage}\n`;
      output += `• **Size**: ${size} GB\n`;
      output += `• **Task ID**: ${result || 'N/A'}\n\n`;
      output += `**Disk naming conventions**:\n`;
      output += `  - SCSI: scsi0-30\n`;
      output += `  - VirtIO: virtio0-15\n`;
      output += `  - SATA: sata0-5\n`;
      output += `  - IDE: ide0-3\n`;
      output += `  - Mount points: mp0-255\n`;
      output += `  - Special disks: rootfs, efidisk0, tpmstate0, unusedN\n\n`;
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
      const safeMp = this.validateMountPoint(mp);
      const safeStorage = this.validateStorageName(storage);

      const body = {
        [safeMp]: `${safeStorage}:${size}`
      };

      const result = await this.proxmoxRequest(`/nodes/${safeNode}/lxc/${safeVMID}/config`, 'PUT', body);

      let output = `💿 **LXC Mount Point Addition Started**\n\n`;
      output += `• **Container ID**: ${safeVMID}\n`;
      output += `• **Node**: ${safeNode}\n`;
      output += `• **Mount Point**: ${safeMp}\n`;
      output += `• **Storage**: ${safeStorage}\n`;
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
      const safeDisk = this.validateDiskName(disk);

      const body = {
        disk: safeDisk,
        size: size
      };

      const result = await this.proxmoxRequest(`/nodes/${safeNode}/qemu/${safeVMID}/resize`, 'PUT', body);

      let output = `📏 **VM Disk Resize Started**\n\n`;
      output += `• **VM ID**: ${safeVMID}\n`;
      output += `• **Node**: ${safeNode}\n`;
      output += `• **Disk**: ${safeDisk}\n`;
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
      const safeDisk = this.validateDiskName(disk);

      const body = {
        disk: safeDisk,
        size: size
      };

      const result = await this.proxmoxRequest(`/nodes/${safeNode}/lxc/${safeVMID}/resize`, 'PUT', body);

      let output = `📏 **LXC Disk Resize Started**\n\n`;
      output += `• **Container ID**: ${safeVMID}\n`;
      output += `• **Node**: ${safeNode}\n`;
      output += `• **Disk**: ${safeDisk}\n`;
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
      const safeDisk = this.validateDiskName(disk);

      const body = {
        delete: safeDisk
      };

      const result = await this.proxmoxRequest(`/nodes/${safeNode}/qemu/${safeVMID}/config`, 'PUT', body);

      let output = `➖ **VM Disk Removal Started**\n\n`;
      output += `• **VM ID**: ${safeVMID}\n`;
      output += `• **Node**: ${safeNode}\n`;
      output += `• **Disk**: ${safeDisk}\n`;
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
      const safeMp = this.validateMountPoint(mp);

      const body = {
        delete: safeMp
      };

      const result = await this.proxmoxRequest(`/nodes/${safeNode}/lxc/${safeVMID}/config`, 'PUT', body);

      let output = `➖ **LXC Mount Point Removal Started**\n\n`;
      output += `• **Container ID**: ${safeVMID}\n`;
      output += `• **Node**: ${safeNode}\n`;
      output += `• **Mount Point**: ${safeMp}\n`;
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
      const safeDisk = this.validateDiskName(disk);
      const safeStorage = this.validateStorageName(storage);

      const body = {
        disk: safeDisk,
        storage: safeStorage,
        delete: deleteSource ? 1 : 0
      };

      const result = await this.proxmoxRequest(`/nodes/${safeNode}/qemu/${safeVMID}/move_disk`, 'POST', body);

      let output = `📦 **VM Disk Move Started**\n\n`;
      output += `• **VM ID**: ${safeVMID}\n`;
      output += `• **Node**: ${safeNode}\n`;
      output += `• **Disk**: ${safeDisk}\n`;
      output += `• **Target Storage**: ${safeStorage}\n`;
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
      const safeDisk = this.validateDiskName(disk);
      const safeStorage = this.validateStorageName(storage);

      const body = {
        volume: safeDisk,
        storage: safeStorage,
        delete: deleteSource ? 1 : 0
      };

      const result = await this.proxmoxRequest(`/nodes/${safeNode}/lxc/${safeVMID}/move_volume`, 'POST', body);

      let output = `📦 **LXC Disk Move Started**\n\n`;
      output += `• **Container ID**: ${safeVMID}\n`;
      output += `• **Node**: ${safeNode}\n`;
      output += `• **Volume**: ${safeDisk}\n`;
      output += `• **Target Storage**: ${safeStorage}\n`;
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
      const safeNet = this.validateNetworkName(net);
      const safeBridge = this.validateBridgeName(bridge);

      // Build network configuration string
      let netConfig = `${model || 'virtio'},bridge=${safeBridge}`;

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
        [safeNet]: netConfig
      };

      await this.proxmoxRequest(`/nodes/${safeNode}/qemu/${safeVMID}/config`, 'PUT', body);

      let output = `🌐 **VM Network Interface Added**\n\n`;
      output += `• **VM ID**: ${safeVMID}\n`;
      output += `• **Node**: ${safeNode}\n`;
      output += `• **Interface**: ${safeNet}\n`;
      output += `• **Bridge**: ${safeBridge}\n`;
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
      const safeNet = this.validateNetworkName(net);
      const safeBridge = this.validateBridgeName(bridge);

      // Extract interface number (e.g., net0 -> 0, net1 -> 1)
      const netNum = safeNet.replace('net', '');

      // Build network configuration string
      let netConfig = `name=eth${netNum},bridge=${safeBridge}`;

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
        [safeNet]: netConfig
      };

      await this.proxmoxRequest(`/nodes/${safeNode}/lxc/${safeVMID}/config`, 'PUT', body);

      let output = `🌐 **LXC Network Interface Added**\n\n`;
      output += `• **Container ID**: ${safeVMID}\n`;
      output += `• **Node**: ${safeNode}\n`;
      output += `• **Interface**: ${safeNet} (eth${netNum})\n`;
      output += `• **Bridge**: ${safeBridge}\n`;
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
      const safeNet = this.validateNetworkName(net);

      // Get current VM configuration
      const config = await this.proxmoxRequest(`/nodes/${safeNode}/qemu/${safeVMID}/config`, 'GET');

      if (!config[safeNet]) {
        return {
          content: [{
            type: 'text',
            text: `❌ **Network interface ${safeNet} does not exist**\n\nPlease add the interface first using proxmox_add_network_vm.\n\n**Existing interfaces**: ${Object.keys(config).filter(k => k.startsWith('net')).join(', ') || 'None'}`
          }]
        };
      }

      // Parse current configuration
      const currentConfig = config[safeNet];
      const configParts = {};
      currentConfig.split(',').forEach(part => {
        const [key, value] = part.split('=');
        configParts[key] = value;
      });

      // Update only provided parameters
      const models = ['virtio', 'e1000', 'e1000e', 'rtl8139', 'vmxnet3'];
      if (model !== undefined) {
        // In QEMU NIC config the MAC is stored as the VALUE of the model key,
        // e.g. "virtio=AA:BB:CC:DD:EE:FF". Recover it from the existing model
        // key so switching models preserves the MAC instead of dropping it
        // (which would make Proxmox assign a new random MAC).
        const existingModel = models.find(m => configParts[m] !== undefined);
        const mac = configParts.macaddr || (existingModel ? configParts[existingModel] : undefined);
        // Remove all model keys, then set the new one (carrying the MAC over).
        models.forEach(m => { delete configParts[m]; });
        configParts[model] = mac || '';
      }

      if (bridge !== undefined) {
        const safeBridge = this.validateBridgeName(bridge);
        configParts.bridge = safeBridge;
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
        [safeNet]: netConfig
      };

      await this.proxmoxRequest(`/nodes/${safeNode}/qemu/${safeVMID}/config`, 'PUT', body);

      let output = `🔧 **VM Network Interface Updated**\n\n`;
      output += `• **VM ID**: ${safeVMID}\n`;
      output += `• **Node**: ${safeNode}\n`;
      output += `• **Interface**: ${safeNet}\n`;
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
      const safeNet = this.validateNetworkName(net);
      const safeBridge = bridge !== undefined ? this.validateBridgeName(bridge) : undefined;

      // Get current container configuration
      const config = await this.proxmoxRequest(`/nodes/${safeNode}/lxc/${safeVMID}/config`, 'GET');

      if (!config[safeNet]) {
        return {
          content: [{
            type: 'text',
            text: `❌ **Network interface ${safeNet} does not exist**\n\nPlease add the interface first using proxmox_add_network_lxc.\n\n**Existing interfaces**: ${Object.keys(config).filter(k => k.startsWith('net')).join(', ') || 'None'}`
          }]
        };
      }

      // Parse current configuration
      const currentConfig = config[safeNet];
      const configParts = {};
      currentConfig.split(',').forEach(part => {
        const [key, value] = part.split('=');
        configParts[key] = value;
      });

      // Update only provided parameters
      if (bridge !== undefined) {
        configParts.bridge = safeBridge;
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
        [safeNet]: netConfig
      };

      await this.proxmoxRequest(`/nodes/${safeNode}/lxc/${safeVMID}/config`, 'PUT', body);

      let output = `🔧 **LXC Network Interface Updated**\n\n`;
      output += `• **Container ID**: ${safeVMID}\n`;
      output += `• **Node**: ${safeNode}\n`;
      output += `• **Interface**: ${safeNet}\n`;
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
      const safeNet = this.validateNetworkName(net);

      const body = {
        delete: safeNet
      };

      await this.proxmoxRequest(`/nodes/${safeNode}/qemu/${safeVMID}/config`, 'PUT', body);

      let output = `➖ **VM Network Interface Removed**\n\n`;
      output += `• **VM ID**: ${safeVMID}\n`;
      output += `• **Node**: ${safeNode}\n`;
      output += `• **Interface Removed**: ${safeNet}\n\n`;
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
      const safeNet = this.validateNetworkName(net);

      const body = {
        delete: safeNet
      };

      await this.proxmoxRequest(`/nodes/${safeNode}/lxc/${safeVMID}/config`, 'PUT', body);

      let output = `➖ **LXC Network Interface Removed**\n\n`;
      output += `• **Container ID**: ${safeVMID}\n`;
      output += `• **Node**: ${safeNode}\n`;
      output += `• **Interface Removed**: ${safeNet}\n\n`;
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

  // --- Terraform / OpenTofu generation -------------------------------------

  // Parse a Proxmox property string like "virtio=AA:BB,bridge=vmbr0,firewall=1"
  // or "local-lvm:vm-100-disk-0,size=32G,ssd=1" into { leading, options }.
  parsePropertyString(value) {
    const options = {};
    let leading = null;
    for (const part of String(value).split(',')) {
      const idx = part.indexOf('=');
      if (idx === -1) {
        if (leading === null) leading = part;
      } else {
        options[part.slice(0, idx)] = part.slice(idx + 1);
      }
    }
    return { leading, options };
  }

  hclString(value) {
    return `"${String(value)
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\$\{/g, () => '$${')
      .replace(/\n/g, '\\n')}"`;
  }

  hclLabel(name, fallback) {
    const label = String(name || '')
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '');
    return label || fallback;
  }

  // Convert a Proxmox size string ("32G", "8", "512M", "1T") to whole gigabytes.
  sizeToGB(size) {
    const match = String(size).match(/^(\d+(?:\.\d+)?)([KMGT])?$/i);
    if (!match) return null;
    const value = parseFloat(match[1]);
    const unit = (match[2] || 'G').toUpperCase();
    const gb = { K: value / (1024 * 1024), M: value / 1024, G: value, T: value * 1024 }[unit];
    return Math.max(1, Math.ceil(gb));
  }

  terraformProviderBlock() {
    return [
      'terraform {',
      '  required_providers {',
      '    proxmox = {',
      '      source  = "bpg/proxmox"',
      '      version = ">= 0.60.0"',
      '    }',
      '  }',
      '}',
      '',
      'provider "proxmox" {',
      `  endpoint  = ${this.hclString(`https://${this.proxmoxHost}:${this.proxmoxPort}/`)}`,
      '  api_token = var.proxmox_api_token # format: user@realm!tokenid=uuid',
      '  insecure  = true # set to false if your API certificate is trusted',
      '}',
      '',
      'variable "proxmox_api_token" {',
      '  type      = string',
      '  sensitive = true',
      '}',
    ].join('\n');
  }

  terraformForQemu(node, vmid, config) {
    const consumed = new Set(['digest', 'vmgenid', 'meta', 'smbios1', 'pending']);
    const take = (key) => { consumed.add(key); return config[key]; };

    const label = `vm_${vmid}_${this.hclLabel(config.name, 'unnamed')}`;
    const lines = [`resource "proxmox_virtual_environment_vm" "${label}" {`];
    const push = (line) => lines.push(line ? `  ${line}` : '');

    if (take('name') !== undefined) push(`name        = ${this.hclString(config.name)}`);
    push(`node_name   = ${this.hclString(node)}`);
    push(`vm_id       = ${vmid}`);
    if (take('description') !== undefined) push(`description = ${this.hclString(config.description)}`);
    if (take('tags') !== undefined) {
      const tags = String(config.tags).split(/[;,]/).filter(Boolean);
      push(`tags        = [${tags.map(t => this.hclString(t)).join(', ')}]`);
    }
    push(`on_boot     = ${take('onboot') ? 'true' : 'false'}`);
    if (take('bios') !== undefined) push(`bios        = ${this.hclString(config.bios)}`);
    if (take('machine') !== undefined) push(`machine     = ${this.hclString(config.machine)}`);
    if (take('scsihw') !== undefined) push(`scsi_hardware = ${this.hclString(config.scsihw)}`);
    if (take('boot') !== undefined) {
      const order = this.parsePropertyString(config.boot).options.order;
      if (order) push(`boot_order  = [${order.split(';').map(d => this.hclString(d)).join(', ')}]`);
    }

    if (take('ostype') !== undefined) {
      push('');
      push('operating_system {');
      push(`  type = ${this.hclString(config.ostype)}`);
      push('}');
    }

    if (take('agent') !== undefined) {
      const agent = this.parsePropertyString(config.agent);
      push('');
      push('agent {');
      push(`  enabled = ${agent.leading === '1' || agent.options.enabled === '1' ? 'true' : 'false'}`);
      push('}');
    }

    push('');
    push('cpu {');
    push(`  cores   = ${parseInt(take('cores'), 10) || 1}`);
    push(`  sockets = ${parseInt(take('sockets'), 10) || 1}`);
    if (take('cpu') !== undefined) {
      const cpu = this.parsePropertyString(config.cpu);
      const cpuType = cpu.options.cputype || cpu.leading;
      if (cpuType) push(`  type    = ${this.hclString(cpuType)}`);
    }
    push('}');

    push('');
    push('memory {');
    push(`  dedicated = ${parseInt(take('memory'), 10) || 512}`);
    if (take('balloon') !== undefined) push(`  floating  = ${parseInt(config.balloon, 10) || 0}`);
    push('}');

    // Disks, CD-ROMs and the cloud-init drive all live on ide/sata/scsi/virtio keys
    const cloudInit = { drive: null };
    let cdromEmitted = false;
    for (const key of Object.keys(config).sort()) {
      const match = key.match(/^(ide|sata|scsi|virtio)(\d+)$/);
      if (!match) continue;
      const disk = this.parsePropertyString(config[key]);
      consumed.add(key);

      if ((disk.leading || '').includes('cloudinit')) {
        cloudInit.drive = { key, datastore: disk.leading.split(':')[0] };
        continue;
      }
      if (disk.options.media === 'cdrom') {
        if (disk.leading && disk.leading !== 'none') {
          // The bpg provider allows only one cdrom block per resource; emit the
          // first and leave any extra ISOs as a comment for manual handling.
          if (cdromEmitted) {
            push('');
            push(`# Additional CD-ROM not emitted (provider allows one cdrom block): ${key} = ${disk.leading}`);
          } else {
            push('');
            push('cdrom {');
            push(`  file_id   = ${this.hclString(disk.leading)}`);
            push(`  interface = ${this.hclString(key)}`);
            push('}');
            cdromEmitted = true;
          }
        }
        continue;
      }

      push('');
      push('disk {');
      push(`  interface    = ${this.hclString(key)}`);
      if (disk.leading) push(`  datastore_id = ${this.hclString(disk.leading.split(':')[0])}`);
      const sizeGB = disk.options.size ? this.sizeToGB(disk.options.size) : null;
      if (sizeGB) push(`  size         = ${sizeGB}`);
      if (disk.options.ssd === '1') push('  ssd          = true');
      if (disk.options.iothread === '1') push('  iothread     = true');
      if (disk.options.discard) push(`  discard      = ${this.hclString(disk.options.discard)}`);
      if (disk.options.cache) push(`  cache        = ${this.hclString(disk.options.cache)}`);
      push('}');
    }

    if (take('efidisk0') !== undefined) {
      const efi = this.parsePropertyString(config.efidisk0);
      push('');
      push('efi_disk {');
      if (efi.leading) push(`  datastore_id = ${this.hclString(efi.leading.split(':')[0])}`);
      if (efi.options.efitype) push(`  type         = ${this.hclString(efi.options.efitype)}`);
      push('}');
    }

    // Network devices
    for (const key of Object.keys(config).sort()) {
      const match = key.match(/^net(\d+)$/);
      if (!match) continue;
      const net = this.parsePropertyString(config[key]);
      consumed.add(key);
      const models = ['virtio', 'e1000', 'e1000e', 'rtl8139', 'vmxnet3'];
      const model = models.find(m => net.options[m] !== undefined);
      push('');
      push('network_device {');
      if (model) {
        push(`  model       = ${this.hclString(model)}`);
        if (net.options[model]) push(`  mac_address = ${this.hclString(net.options[model])}`);
      }
      if (net.options.macaddr) push(`  mac_address = ${this.hclString(net.options.macaddr)}`);
      if (net.options.bridge) push(`  bridge      = ${this.hclString(net.options.bridge)}`);
      if (net.options.tag) push(`  vlan_id     = ${parseInt(net.options.tag, 10)}`);
      if (net.options.firewall === '1') push('  firewall    = true');
      if (net.options.mtu) push(`  mtu         = ${parseInt(net.options.mtu, 10)}`);
      if (net.options.rate) push(`  rate_limit  = ${net.options.rate}`);
      push('}');
    }

    // Cloud-init
    const ipConfigKeys = Object.keys(config).filter(k => /^ipconfig\d+$/.test(k)).sort();
    if (cloudInit.drive || ipConfigKeys.length > 0) {
      push('');
      push('initialization {');
      if (cloudInit.drive) {
        push(`  datastore_id = ${this.hclString(cloudInit.drive.datastore)}`);
        push(`  interface    = ${this.hclString(cloudInit.drive.key)}`);
      }
      for (const key of ipConfigKeys) {
        const ip = this.parsePropertyString(config[key]).options;
        consumed.add(key);
        push('  ip_config {');
        if (ip.ip) {
          push('    ipv4 {');
          push(`      address = ${this.hclString(ip.ip)}`);
          if (ip.gw) push(`      gateway = ${this.hclString(ip.gw)}`);
          push('    }');
        }
        if (ip.ip6) {
          push('    ipv6 {');
          push(`      address = ${this.hclString(ip.ip6)}`);
          if (ip.gw6) push(`      gateway = ${this.hclString(ip.gw6)}`);
          push('    }');
        }
        push('  }');
      }
      if (config.nameserver || config.searchdomain) {
        push('  dns {');
        if (take('searchdomain') !== undefined) push(`    domain  = ${this.hclString(config.searchdomain)}`);
        if (take('nameserver') !== undefined) {
          const servers = String(config.nameserver).split(/\s+/).filter(Boolean);
          push(`    servers = [${servers.map(s => this.hclString(s)).join(', ')}]`);
        }
        push('  }');
      }
      if (take('ciuser') !== undefined) {
        push('  user_account {');
        push(`    username = ${this.hclString(config.ciuser)}`);
        push('    # password/keys are not exported by the Proxmox API; set them here if needed');
        push('  }');
      }
      consumed.add('cipassword');
      consumed.add('sshkeys');
      push('}');
    }

    const unmapped = Object.keys(config).filter(k => !consumed.has(k)).sort();
    if (unmapped.length > 0) {
      push('');
      push(`# Not mapped automatically (configure manually if needed): ${unmapped.join(', ')}`);
    }
    lines.push('}');

    lines.push('');
    lines.push(`import {`);
    lines.push(`  to = proxmox_virtual_environment_vm.${label}`);
    lines.push(`  id = ${this.hclString(`${node}/${vmid}`)}`);
    lines.push(`}`);
    return lines.join('\n');
  }

  terraformForLxc(node, vmid, config) {
    const consumed = new Set(['digest', 'pending', 'lxc']);
    const take = (key) => { consumed.add(key); return config[key]; };

    const label = `ct_${vmid}_${this.hclLabel(config.hostname, 'unnamed')}`;
    const lines = [`resource "proxmox_virtual_environment_container" "${label}" {`];
    const push = (line) => lines.push(line ? `  ${line}` : '');

    push(`node_name     = ${this.hclString(node)}`);
    push(`vm_id         = ${vmid}`);
    if (take('description') !== undefined) push(`description   = ${this.hclString(config.description)}`);
    if (take('tags') !== undefined) {
      const tags = String(config.tags).split(/[;,]/).filter(Boolean);
      push(`tags          = [${tags.map(t => this.hclString(t)).join(', ')}]`);
    }
    push(`unprivileged  = ${take('unprivileged') === 1 || config.unprivileged === '1' ? 'true' : 'false'}`);
    push(`start_on_boot = ${take('onboot') ? 'true' : 'false'}`);

    if (take('features') !== undefined) {
      const features = this.parsePropertyString(config.features).options;
      push('');
      push('features {');
      if (features.nesting === '1') push('  nesting = true');
      if (features.fuse === '1') push('  fuse    = true');
      if (features.keyctl === '1') push('  keyctl  = true');
      push('}');
    }

    push('');
    push('cpu {');
    push(`  cores = ${parseInt(take('cores'), 10) || 1}`);
    if (take('arch') !== undefined) push(`  architecture = ${this.hclString(config.arch)}`);
    push('}');

    push('');
    push('memory {');
    push(`  dedicated = ${parseInt(take('memory'), 10) || 512}`);
    push(`  swap      = ${parseInt(take('swap'), 10) || 0}`);
    push('}');

    if (take('rootfs') !== undefined) {
      const rootfs = this.parsePropertyString(config.rootfs);
      push('');
      push('disk {');
      if (rootfs.leading) push(`  datastore_id = ${this.hclString(rootfs.leading.split(':')[0])}`);
      const sizeGB = rootfs.options.size ? this.sizeToGB(rootfs.options.size) : null;
      if (sizeGB) push(`  size         = ${sizeGB}`);
      push('}');
    }

    for (const key of Object.keys(config).sort()) {
      if (!/^mp\d+$/.test(key)) continue;
      const mp = this.parsePropertyString(config[key]);
      consumed.add(key);
      push('');
      push('mount_point {');
      if (mp.leading) push(`  volume = ${this.hclString(mp.leading)}`);
      if (mp.options.size) push(`  size   = ${this.hclString(mp.options.size)}`);
      if (mp.options.mp) push(`  path   = ${this.hclString(mp.options.mp)}`);
      push('}');
    }

    const netKeys = Object.keys(config).filter(k => /^net\d+$/.test(k)).sort();
    const ipConfigs = [];
    for (const key of netKeys) {
      const net = this.parsePropertyString(config[key]).options;
      consumed.add(key);
      push('');
      push('network_interface {');
      if (net.name) push(`  name        = ${this.hclString(net.name)}`);
      if (net.bridge) push(`  bridge      = ${this.hclString(net.bridge)}`);
      if (net.hwaddr) push(`  mac_address = ${this.hclString(net.hwaddr)}`);
      if (net.tag) push(`  vlan_id     = ${parseInt(net.tag, 10)}`);
      if (net.firewall === '1') push('  firewall    = true');
      if (net.mtu) push(`  mtu         = ${parseInt(net.mtu, 10)}`);
      if (net.rate) push(`  rate_limit  = ${net.rate}`);
      push('}');
      ipConfigs.push({ ip: net.ip, gw: net.gw, ip6: net.ip6, gw6: net.gw6 });
    }

    push('');
    push('initialization {');
    if (take('hostname') !== undefined) push(`  hostname = ${this.hclString(config.hostname)}`);
    for (const ip of ipConfigs) {
      if (!ip.ip && !ip.ip6) continue;
      push('  ip_config {');
      if (ip.ip) {
        push('    ipv4 {');
        push(`      address = ${this.hclString(ip.ip)}`);
        if (ip.gw) push(`      gateway = ${this.hclString(ip.gw)}`);
        push('    }');
      }
      if (ip.ip6) {
        push('    ipv6 {');
        push(`      address = ${this.hclString(ip.ip6)}`);
        if (ip.gw6) push(`      gateway = ${this.hclString(ip.gw6)}`);
        push('    }');
      }
      push('  }');
    }
    if (config.nameserver || config.searchdomain) {
      push('  dns {');
      if (take('searchdomain') !== undefined) push(`    domain  = ${this.hclString(config.searchdomain)}`);
      if (take('nameserver') !== undefined) {
        const servers = String(config.nameserver).split(/\s+/).filter(Boolean);
        push(`    servers = [${servers.map(s => this.hclString(s)).join(', ')}]`);
      }
      push('  }');
    }
    push('}');

    push('');
    push('operating_system {');
    push('  # The source template is not recorded in the container config and cannot be');
    push('  # read back from the Proxmox API. This placeholder keeps the config valid;');
    push('  # set the real template if you later recreate the container.');
    push('  template_file_id = "local:vztmpl/CHANGE_ME.tar.zst"');
    if (take('ostype') !== undefined) push(`  type             = ${this.hclString(config.ostype)}`);
    push('}');

    push('');
    push('lifecycle {');
    push('  # template_file_id is a ForceNew attribute the API cannot report, so the');
    push('  # placeholder above would otherwise force a destroy/recreate on import.');
    push('  # Ignoring it lets you adopt the running container in place.');
    push('  ignore_changes = [operating_system]');
    push('}');

    const unmapped = Object.keys(config).filter(k => !consumed.has(k)).sort();
    if (unmapped.length > 0) {
      push('');
      push(`# Not mapped automatically (configure manually if needed): ${unmapped.join(', ')}`);
    }
    lines.push('}');

    lines.push('');
    lines.push(`import {`);
    lines.push(`  to = proxmox_virtual_environment_container.${label}`);
    lines.push(`  id = ${this.hclString(`${node}/${vmid}`)}`);
    lines.push(`}`);
    return lines.join('\n');
  }

  async generateTerraform(nodeFilter, vmidFilter, typeFilter = 'all', includeProvider = true) {
    try {
      const safeNode = nodeFilter ? this.validateNodeName(nodeFilter) : null;
      const safeVMID = vmidFilter ? this.validateVMID(vmidFilter) : null;
      const safeType = ['qemu', 'lxc', 'all'].includes(typeFilter) ? typeFilter : 'all';

      // Discover targets
      const targets = [];
      if (safeNode) {
        if (safeType === 'all' || safeType === 'qemu') {
          const vms = await this.proxmoxRequest(`/nodes/${safeNode}/qemu`);
          targets.push(...(vms || []).map(vm => ({ node: safeNode, vmid: String(vm.vmid), type: 'qemu' })));
        }
        if (safeType === 'all' || safeType === 'lxc') {
          const cts = await this.proxmoxRequest(`/nodes/${safeNode}/lxc`);
          targets.push(...(cts || []).map(ct => ({ node: safeNode, vmid: String(ct.vmid), type: 'lxc' })));
        }
      } else {
        const nodes = await this.proxmoxRequest('/nodes');
        for (const node of nodes || []) {
          if (safeType === 'all' || safeType === 'qemu') {
            const vms = await this.proxmoxRequest(`/nodes/${node.node}/qemu`);
            targets.push(...(vms || []).map(vm => ({ node: node.node, vmid: String(vm.vmid), type: 'qemu' })));
          }
          if (safeType === 'all' || safeType === 'lxc') {
            const cts = await this.proxmoxRequest(`/nodes/${node.node}/lxc`);
            targets.push(...(cts || []).map(ct => ({ node: node.node, vmid: String(ct.vmid), type: 'lxc' })));
          }
        }
      }

      const selected = safeVMID ? targets.filter(t => t.vmid === safeVMID) : targets;
      if (selected.length === 0) {
        return {
          content: [{
            type: 'text',
            text: safeVMID
              ? `❌ No ${safeType === 'all' ? 'VM or container' : safeType} with ID ${safeVMID} found${safeNode ? ` on node ${safeNode}` : ''}.`
              : `No guests found matching the given filters.`
          }]
        };
      }

      const blocks = [];
      if (includeProvider !== false) {
        blocks.push(this.terraformProviderBlock());
      }
      for (const target of selected.sort((a, b) => parseInt(a.vmid, 10) - parseInt(b.vmid, 10))) {
        const config = await this.proxmoxRequest(`/nodes/${target.node}/${target.type}/${target.vmid}/config`);
        blocks.push(target.type === 'qemu'
          ? this.terraformForQemu(target.node, target.vmid, config || {})
          : this.terraformForLxc(target.node, target.vmid, config || {}));
      }

      let output = `🏗️ **Terraform/OpenTofu configuration** (${selected.length} resource${selected.length === 1 ? '' : 's'}, bpg/proxmox provider)\n\n`;
      output += '```hcl\n' + blocks.join('\n\n') + '\n```\n\n';
      output += `**Usage**:\n`;
      output += `1. Save as \`main.tf\` and run \`terraform init\` (or \`tofu init\`)\n`;
      output += `2. Set the token: \`export TF_VAR_proxmox_api_token='user@realm!tokenid=uuid'\`\n`;
      output += `3. Run \`terraform plan\` — the \`import\` blocks adopt the existing guests without recreating them\n`;
      output += `4. Review the diff carefully before \`terraform apply\`; unmapped options are listed in comments\n`;

      return {
        content: [{ type: 'text', text: output }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `❌ **Failed to generate Terraform configuration**\n\nError: ${error.message}`
        }]
      };
    }
  }

  // Shared guard for operations that need elevated privileges.
  requireElevated(actionLabel) {
    if (this.allowElevated) {
      return null;
    }
    return this.respond(
      `⚠️  **${actionLabel} Requires Elevated Permissions**\n\n` +
      `Set \`PROXMOX_ALLOW_ELEVATED=true\` in your .env file and make sure the API token has the ` +
      `required privileges. Run \`proxmox_whoami\` to see exactly what this token can do.`,
      { error: 'elevated_permissions_required', action: actionLabel, allowElevated: false },
      true
    );
  }

  async getTaskStatus(node, upid, wait = false, timeout = 60) {
    try {
      const safeNode = this.validateNodeName(node);
      const safeUPID = this.validateUPID(upid);
      const path = `/nodes/${safeNode}/tasks/${encodeURIComponent(safeUPID)}/status`;

      let status = await this.proxmoxRequest(path);

      if (wait && status && status.status === 'running') {
        const maxMs = Math.min(Math.max(Number(timeout) || 60, 1), 600) * 1000;
        const start = Date.now();
        while (status && status.status === 'running' && (Date.now() - start) < maxMs) {
          await this.sleep(2000);
          status = await this.proxmoxRequest(path);
        }
      }

      status = status || {};
      const running = status.status === 'running';
      const finished = status.status === 'stopped';
      const success = finished && status.exitstatus === 'OK';
      const icon = running ? '⏳' : success ? '✅' : finished ? '❌' : 'ℹ️';

      let output = `${icon} **Task Status**\n\n`;
      output += `• **UPID**: \`${safeUPID}\`\n`;
      output += `• **Node**: ${safeNode}\n`;
      output += `• **Type**: ${status.type || 'N/A'}\n`;
      output += `• **State**: ${status.status || 'unknown'}\n`;
      if (finished) {
        output += `• **Exit status**: ${status.exitstatus || 'N/A'}\n`;
      }
      if (running && wait) {
        output += `• **Note**: still running after waiting ${Math.min(Math.max(Number(timeout) || 60, 1), 600)}s\n`;
      } else if (running) {
        output += `• **Note**: task is still running; pass wait=true to block until it finishes\n`;
      }

      const structured = {
        node: safeNode,
        upid: safeUPID,
        type: status.type ?? null,
        status: status.status ?? null,
        exitstatus: status.exitstatus ?? null,
        finished,
        running,
        success,
        pid: status.pid ?? null,
        starttime: status.starttime ?? null,
      };

      return this.respond(output, structured, finished && !success);
    } catch (error) {
      return this.respond(
        `❌ **Failed to get task status**\n\nError: ${error.message}`,
        { error: error.message },
        true
      );
    }
  }

  async getVMConfig(node, vmid, type = 'qemu') {
    try {
      const safeNode = this.validateNodeName(node);
      const safeVMID = this.validateVMID(vmid);
      const safeType = this.validateGuestType(type, 'qemu');

      const config = await this.proxmoxRequest(`/nodes/${safeNode}/${safeType}/${safeVMID}/config`) || {};
      const typeIcon = safeType === 'qemu' ? '🖥️' : '📦';

      let output = `${typeIcon} **Configuration — ${config.name || config.hostname || `guest ${safeVMID}`}** (ID: ${safeVMID}, ${safeType.toUpperCase()} on ${safeNode})\n\n`;
      const keys = Object.keys(config).filter(k => k !== 'digest').sort();
      for (const key of keys) {
        const value = config[key];
        output += `• **${key}**: ${typeof value === 'object' ? JSON.stringify(value) : value}\n`;
      }
      if (keys.length === 0) {
        output += '_No configuration returned._\n';
      }

      return this.respond(output, { node: safeNode, vmid: parseInt(safeVMID, 10), type: safeType, config });
    } catch (error) {
      return this.respond(
        `❌ **Failed to get guest config**\n\nError: ${error.message}`,
        { error: error.message },
        true
      );
    }
  }

  async whoami(path = undefined) {
    try {
      const endpoint = path
        ? `/access/permissions?path=${encodeURIComponent(path)}`
        : '/access/permissions';
      const permissions = await this.proxmoxRequest(endpoint) || {};

      let output = `🔑 **Proxmox API Identity**\n\n`;
      output += `• **User**: ${this.proxmoxUser}\n`;
      output += `• **Token**: ${this.proxmoxTokenName}\n`;
      output += `• **Elevated tools enabled**: ${this.allowElevated ? 'yes (PROXMOX_ALLOW_ELEVATED=true)' : 'no'}\n`;
      output += `• **TLS verification**: ${this.verifyTls ? 'on' : 'off'}\n\n`;

      const paths = Object.keys(permissions).sort();
      if (paths.length === 0) {
        output += '_No permissions returned. The token may have no ACLs assigned._\n';
      } else {
        output += `**Effective permissions** (${paths.length} path${paths.length === 1 ? '' : 's'}):\n\n`;
        for (const p of paths) {
          const privs = Object.keys(permissions[p] || {})
            .filter(priv => permissions[p][priv])
            .sort();
          output += `• \`${p}\`: ${privs.length ? privs.join(', ') : '(none)'}\n`;
        }
      }

      return this.respond(output, {
        user: this.proxmoxUser,
        token: this.proxmoxTokenName,
        allowElevated: this.allowElevated,
        verifyTls: this.verifyTls,
        permissions,
      });
    } catch (error) {
      return this.respond(
        `❌ **Failed to read permissions**\n\nError: ${error.message}`,
        { error: error.message },
        true
      );
    }
  }

  async migrateGuest(node, vmid, target, type = 'qemu', online = false, wait = false) {
    const guard = this.requireElevated('Migration');
    if (guard) return guard;

    try {
      const safeNode = this.validateNodeName(node);
      const safeVMID = this.validateVMID(vmid);
      const safeTarget = this.validateNodeName(target);
      const safeType = this.validateGuestType(type, 'qemu');

      if (safeTarget === safeNode) {
        return this.respond(
          `❌ Source and target node are the same (${safeNode}). Nothing to migrate.`,
          { error: 'same_node' },
          true
        );
      }

      const body = { target: safeTarget };
      if (safeType === 'qemu') {
        if (online) body.online = 1;
      } else {
        // LXC cannot live-migrate; "online" maps to restart migration.
        if (online) body.restart = 1;
      }

      const result = await this.proxmoxRequest(`/nodes/${safeNode}/${safeType}/${safeVMID}/migrate`, 'POST', body);
      const upid = this.extractUPID(result);

      let output = `🚚 **Migration started** — ${safeType.toUpperCase()} ${safeVMID}: ${safeNode} → ${safeTarget}\n\n`;
      output += `• **Mode**: ${online ? (safeType === 'qemu' ? 'online (live)' : 'restart') : 'offline'}\n`;
      output += `• **Task**: ${upid || 'N/A'}\n`;

      let taskStructured = null;
      if (wait && upid) {
        const taskResult = await this.getTaskStatus(safeNode, upid, true);
        taskStructured = taskResult.structuredContent || null;
        output += `\n${taskResult.content[0].text}`;
      } else if (upid) {
        output += `\n_Use \`proxmox_get_task_status\` with this UPID to confirm completion._`;
      }

      // When we waited on the task, a failed task must surface as an error at
      // the top level, not only in the nested task payload.
      const taskFailed = taskStructured ? taskStructured.finished === true && taskStructured.success === false : false;

      return this.respond(output, {
        node: safeNode,
        target: safeTarget,
        vmid: parseInt(safeVMID, 10),
        type: safeType,
        online: !!online,
        upid: upid || null,
        task: taskStructured,
      }, taskFailed);
    } catch (error) {
      return this.respond(
        `❌ **Migration failed**\n\nError: ${error.message}`,
        { error: error.message },
        true
      );
    }
  }

  async getGuestIPs(node, vmid) {
    const guard = this.requireElevated('Guest IP discovery');
    if (guard) return guard;

    try {
      const safeNode = this.validateNodeName(node);
      const safeVMID = this.validateVMID(vmid);

      const result = await this.proxmoxRequest(`/nodes/${safeNode}/qemu/${safeVMID}/agent/network-get-interfaces`);
      const interfaces = (result && result.result) || [];

      let output = `🌐 **Network interfaces — VM ${safeVMID} on ${safeNode}**\n\n`;
      const structuredIfaces = [];
      if (interfaces.length === 0) {
        output += '_No interfaces reported by the guest agent._\n';
      } else {
        for (const iface of interfaces) {
          const mac = iface['hardware-address'] || 'N/A';
          const addrs = (iface['ip-addresses'] || []).map(a => ({
            type: a['ip-address-type'],
            address: a['ip-address'],
            prefix: a.prefix,
          }));
          output += `• **${iface.name}** (${mac})\n`;
          if (addrs.length === 0) {
            output += `   • (no addresses)\n`;
          }
          for (const a of addrs) {
            output += `   • ${a.type}: ${a.address}/${a.prefix}\n`;
          }
          structuredIfaces.push({ name: iface.name, mac, addresses: addrs });
        }
      }

      return this.respond(output, { node: safeNode, vmid: parseInt(safeVMID, 10), interfaces: structuredIfaces });
    } catch (error) {
      return this.respond(
        `❌ **Failed to get guest IPs**\n\nError: ${error.message}\n\n_The VM must be running with the QEMU guest agent installed and enabled._`,
        { error: error.message },
        true
      );
    }
  }

  async convertToTemplate(node, vmid, type = 'qemu') {
    const guard = this.requireElevated('Template conversion');
    if (guard) return guard;

    try {
      const safeNode = this.validateNodeName(node);
      const safeVMID = this.validateVMID(vmid);
      const safeType = this.validateGuestType(type, 'qemu');

      await this.proxmoxRequest(`/nodes/${safeNode}/${safeType}/${safeVMID}/template`, 'POST', {});

      const output = `📎 **Converted ${safeType.toUpperCase()} ${safeVMID} to a template** on ${safeNode}.\n\n` +
        `This is irreversible. Use the clone tools to provision new guests from it.`;

      return this.respond(output, { node: safeNode, vmid: parseInt(safeVMID, 10), type: safeType, template: true });
    } catch (error) {
      return this.respond(
        `❌ **Failed to convert to template**\n\nError: ${error.message}`,
        { error: error.message },
        true
      );
    }
  }

  async setCloudInit(args = {}) {
    const guard = this.requireElevated('Cloud-init configuration');
    if (guard) return guard;

    try {
      const safeNode = this.validateNodeName(args.node);
      const safeVMID = this.validateVMID(args.vmid);

      const body = {};
      const applied = [];
      for (const key of ['ciuser', 'cipassword', 'sshkeys', 'ipconfig0', 'nameserver', 'searchdomain']) {
        if (args[key] !== undefined && args[key] !== null && args[key] !== '') {
          body[key] = key === 'sshkeys' ? encodeURIComponent(args[key]) : args[key];
          applied.push(key);
        }
      }

      if (applied.length === 0) {
        return this.respond(
          `❌ No cloud-init fields supplied. Provide at least one of: ciuser, cipassword, sshkeys, ipconfig0, nameserver, searchdomain.`,
          { error: 'no_fields' },
          true
        );
      }

      await this.proxmoxRequest(`/nodes/${safeNode}/qemu/${safeVMID}/config`, 'PUT', body);

      let output = `☁️ **Cloud-init updated — VM ${safeVMID} on ${safeNode}**\n\n`;
      output += `Fields set: ${applied.join(', ')}\n\n`;
      output += `_The VM must have a cloud-init drive; changes apply on next reboot._`;

      // Don't echo the password back in structured output.
      const safeApplied = applied.filter(k => k !== 'cipassword');
      return this.respond(output, {
        node: safeNode,
        vmid: parseInt(safeVMID, 10),
        applied,
        values: Object.fromEntries(safeApplied.map(k => [k, k === 'sshkeys' ? '(set)' : args[k]])),
      });
    } catch (error) {
      return this.respond(
        `❌ **Failed to set cloud-init options**\n\nError: ${error.message}`,
        { error: error.message },
        true
      );
    }
  }

  async getRRDData(node, vmid = null, type = 'qemu', timeframe = 'day') {
    try {
      const safeNode = this.validateNodeName(node);
      const safeTimeframe = ['hour', 'day', 'week', 'month', 'year'].includes(timeframe) ? timeframe : 'day';

      let endpoint;
      let label;
      if (vmid) {
        const safeVMID = this.validateVMID(vmid);
        const safeType = this.validateGuestType(type, 'qemu');
        endpoint = `/nodes/${safeNode}/${safeType}/${safeVMID}/rrddata?timeframe=${safeTimeframe}`;
        label = `${safeType.toUpperCase()} ${safeVMID}`;
      } else {
        endpoint = `/nodes/${safeNode}/rrddata?timeframe=${safeTimeframe}`;
        label = `node ${safeNode}`;
      }

      const data = (await this.proxmoxRequest(endpoint)) || [];
      const points = data.filter(p => p && typeof p === 'object');

      const avg = (...fields) => {
        for (const field of fields) {
          const vals = points.map(p => p[field]).filter(v => typeof v === 'number');
          if (vals.length) return vals.reduce((a, b) => a + b, 0) / vals.length;
        }
        return null;
      };
      // The trailing RRD bucket is frequently empty/partial, so "latest" is the
      // last point that actually carries a cpu sample.
      const latestCpuPoint = [...points].reverse().find(p => typeof p.cpu === 'number');
      // Memory total differs by scope: guests report `maxmem`, nodes `memtotal`.
      const memMax = avg('maxmem', 'memtotal');

      let output = `📈 **Historical metrics — ${label}** (timeframe: ${safeTimeframe}, ${points.length} data points)\n\n`;
      if (points.length === 0) {
        output += '_No data returned._\n';
      } else {
        const cpuAvg = avg('cpu');
        if (cpuAvg !== null) output += `• **CPU (avg)**: ${(cpuAvg * 100).toFixed(1)}%\n`;
        if (latestCpuPoint) output += `• **CPU (latest)**: ${(latestCpuPoint.cpu * 100).toFixed(1)}%\n`;
        const memAvg = avg('mem', 'memused');
        if (memAvg !== null) output += `• **Memory (avg)**: ${this.formatBytes(memAvg)}\n`;
        if (memMax !== null) output += `• **Memory (total)**: ${this.formatBytes(memMax)}\n`;
        const netin = avg('netin');
        const netout = avg('netout');
        if (netin !== null) output += `• **Net in (avg)**: ${this.formatBytes(netin)}/s\n`;
        if (netout !== null) output += `• **Net out (avg)**: ${this.formatBytes(netout)}/s\n`;
      }

      return this.respond(output, {
        node: safeNode,
        vmid: vmid ? parseInt(vmid, 10) : null,
        timeframe: safeTimeframe,
        count: points.length,
        data: points,
      });
    } catch (error) {
      return this.respond(
        `❌ **Failed to get historical metrics**\n\nError: ${error.message}`,
        { error: error.message },
        true
      );
    }
  }

  async getPools(poolid = undefined) {
    try {
      if (poolid) {
        if (!/^[A-Za-z0-9._-]+$/.test(poolid) || poolid.length > 64) {
          throw new Error('Invalid pool id format');
        }
        const pool = await this.proxmoxRequest(`/pools/${encodeURIComponent(poolid)}`) || {};
        const members = pool.members || [];
        let output = `🗂️ **Pool ${poolid}**${pool.comment ? ` — ${pool.comment}` : ''}\n\n`;
        if (members.length === 0) {
          output += '_No members._\n';
        } else {
          for (const m of members) {
            output += `• ${m.type}${m.vmid ? ` ${m.vmid}` : ''}${m.storage ? ` ${m.storage}` : ''} — ${m.node || ''} ${m.status || ''}\n`;
          }
        }
        return this.respond(output, { poolid, comment: pool.comment ?? null, members });
      }

      const pools = await this.proxmoxRequest('/pools') || [];
      let output = `🗂️ **Resource Pools** (${pools.length})\n\n`;
      if (pools.length === 0) {
        output += '_No pools defined._\n';
      } else {
        for (const p of pools) {
          output += `• **${p.poolid}**${p.comment ? ` — ${p.comment}` : ''}\n`;
        }
      }
      return this.respond(output, { count: pools.length, pools });
    } catch (error) {
      return this.respond(
        `❌ **Failed to list pools**\n\nError: ${error.message}`,
        { error: error.message },
        true
      );
    }
  }

  async getHAResources() {
    try {
      const resources = await this.proxmoxRequest('/cluster/ha/resources') || [];
      let output = `🛟 **HA Resources** (${resources.length})\n\n`;
      if (resources.length === 0) {
        output += '_No HA resources configured._\n';
      } else {
        for (const r of resources) {
          output += `• **${r.sid}** — state: ${r.state || 'N/A'}, group: ${r.group || 'none'}, max_restart: ${r.max_restart ?? 'N/A'}\n`;
        }
      }
      return this.respond(output, { count: resources.length, resources });
    } catch (error) {
      return this.respond(
        `❌ **Failed to list HA resources**\n\nError: ${error.message}`,
        { error: error.message },
        true
      );
    }
  }

  async getFirewallRules(level = 'cluster', node = undefined, vmid = undefined, type = 'qemu') {
    try {
      let endpoint;
      let label;
      if (level === 'node') {
        const safeNode = this.validateNodeName(node);
        endpoint = `/nodes/${safeNode}/firewall/rules`;
        label = `node ${safeNode}`;
      } else if (level === 'guest') {
        const safeNode = this.validateNodeName(node);
        const safeVMID = this.validateVMID(vmid);
        const safeType = this.validateGuestType(type, 'qemu');
        endpoint = `/nodes/${safeNode}/${safeType}/${safeVMID}/firewall/rules`;
        label = `${safeType.toUpperCase()} ${safeVMID} on ${safeNode}`;
      } else {
        endpoint = '/cluster/firewall/rules';
        label = 'cluster';
      }

      const rules = await this.proxmoxRequest(endpoint) || [];
      let output = `🧱 **Firewall rules — ${label}** (${rules.length})\n\n`;
      if (rules.length === 0) {
        output += '_No rules defined._\n';
      } else {
        for (const r of rules) {
          const parts = [
            r.type,
            r.action,
            r.proto ? `proto ${r.proto}` : null,
            r.source ? `src ${r.source}` : null,
            r.dest ? `dst ${r.dest}` : null,
            r.dport ? `dport ${r.dport}` : null,
            r.enable === 0 ? '(disabled)' : null,
          ].filter(Boolean);
          output += `• #${r.pos}: ${parts.join(' ')}${r.comment ? ` — ${r.comment}` : ''}\n`;
        }
      }
      return this.respond(output, { level, count: rules.length, rules });
    } catch (error) {
      return this.respond(
        `❌ **Failed to list firewall rules**\n\nError: ${error.message}`,
        { error: error.message },
        true
      );
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = new ProxmoxServer();
  server.run().catch(console.error);
}

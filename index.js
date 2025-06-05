#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import fetch from 'node-fetch';
import https from 'https';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Load environment variables from .env file
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const envPath = join(__dirname, '../../.env');

try {
  const envFile = readFileSync(envPath, 'utf8');
  const envVars = envFile.split('\n').filter(line => line.includes('='));
  for (const line of envVars) {
    const [key, ...values] = line.split('=');
    if (key && values.length > 0) {
      process.env[key.trim()] = values.join('=').trim();
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
    
    const status = await this.proxmoxRequest(`/nodes/${node}/status`);
    
    let output = `🖥️  **Node ${node} Status**\n\n`;
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
    const vmStatus = await this.proxmoxRequest(`/nodes/${node}/${type}/${vmid}/status/current`);
    
    const status = vmStatus.status === 'running' ? '🟢' : vmStatus.status === 'stopped' ? '🔴' : '🟡';
    const typeIcon = type === 'qemu' ? '🖥️' : '📦';
    
    let output = `${status} ${typeIcon} **${vmStatus.name || `VM-${vmid}`}** (ID: ${vmid})\n\n`;
    output += `• **Node**: ${node}\n`;
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
      // For QEMU VMs, we need to use the guest agent
      if (type === 'qemu') {
        const result = await this.proxmoxRequest(`/nodes/${node}/qemu/${vmid}/agent/exec`, 'POST', {
          command: command
        });
        
        let output = `💻 **Command executed on VM ${vmid}**\n\n`;
        output += `**Command**: \`${command}\`\n`;
        output += `**Result**: Command submitted to guest agent\n`;
        output += `**PID**: ${result.pid || 'N/A'}\n\n`;
        output += `*Note: Use guest agent status to check command completion*`;
        
        return {
          content: [{ type: 'text', text: output }]
        };
      } else {
        // For LXC containers, we can execute directly
        const result = await this.proxmoxRequest(`/nodes/${node}/lxc/${vmid}/exec`, 'POST', {
          command: command
        });
        
        let output = `📦 **Command executed on LXC ${vmid}**\n\n`;
        output += `**Command**: \`${command}\`\n`;
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
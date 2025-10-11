import { ProxmoxManager } from '../core/proxmox.js';

export function getVmTools(proxmoxManager: ProxmoxManager) {
    const listTools = () => {
        return [
            {
                name: 'get_vms',
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
                name: 'get_vm_status',
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
                name: 'execute_vm_command',
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
        ];
    };

    const getTool = (name: string) => {
        switch (name) {
            case 'get_vms':
                return getVms;
            case 'get_vm_status':
                return getVmStatus;
            case 'execute_vm_command':
                return executeVmCommand;
            default:
                return null;
        }
    };

    const getVms = async (args: { node?: string, type?: string }) => {
        let vms: any[] = [];
        const typeFilter = args.type || 'all';

        if (args.node) {
            if (typeFilter === 'all' || typeFilter === 'qemu') {
                const nodeVMs = await proxmoxManager.proxmoxRequest(`/nodes/${args.node}/qemu`);
                vms.push(...nodeVMs.map((vm: any) => ({ ...vm, type: 'qemu', node: args.node })));
            }
            if (typeFilter === 'all' || typeFilter === 'lxc') {
                const nodeLXCs = await proxmoxManager.proxmoxRequest(`/nodes/${args.node}/lxc`);
                vms.push(...nodeLXCs.map((vm: any) => ({ ...vm, type: 'lxc', node: args.node })));
            }
        } else {
            const nodes = await proxmoxManager.proxmoxRequest('/nodes');
            for (const node of nodes) {
                if (typeFilter === 'all' || typeFilter === 'qemu') {
                    const nodeVMs = await proxmoxManager.proxmoxRequest(`/nodes/${node.node}/qemu`);
                    vms.push(...nodeVMs.map((vm: any) => ({ ...vm, type: 'qemu', node: node.node })));
                }
                if (typeFilter === 'all' || typeFilter === 'lxc') {
                    const nodeLXCs = await proxmoxManager.proxmoxRequest(`/nodes/${node.node}/lxc`);
                    vms.push(...nodeLXCs.map((vm: any) => ({ ...vm, type: 'lxc', node: node.node })));
                }
            }
        }

        return {
            content: [{ type: 'text', text: JSON.stringify(vms, null, 2) }]
        };
    };

    const getVmStatus = async (args: any) => {
        const type = args.type || 'qemu';
        const vmStatus = await proxmoxManager.proxmoxRequest(`/nodes/${args.node}/${type}/${args.vmid}/status/current`);
        return {
            content: [{ type: 'text', text: JSON.stringify(vmStatus, null, 2) }]
        };
    };

    const executeVmCommand = async (args: any) => {
        const type = args.type || 'qemu';
        const result = await proxmoxManager.proxmoxRequest(`/nodes/${args.node}/${type}/${args.vmid}/agent/exec`, 'POST', {
            command: args.command
        });
        return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        };
    };

    return {
        listTools,
        getTool,
    };
}
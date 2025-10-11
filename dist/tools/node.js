export function getNodeTools(proxmoxManager) {
    const listTools = () => {
        return [
            {
                name: 'get_nodes',
                description: 'List all Proxmox cluster nodes with their status and resources',
                inputSchema: {
                    type: 'object',
                    properties: {}
                }
            },
            {
                name: 'get_node_status',
                description: 'Get detailed status information for a specific Proxmox node',
                inputSchema: {
                    type: 'object',
                    properties: {
                        node: { type: 'string', description: 'Node name (e.g., pve1, proxmox-node2)' }
                    },
                    required: ['node']
                }
            },
        ];
    };
    const getTool = (name) => {
        switch (name) {
            case 'get_nodes':
                return getNodes;
            case 'get_node_status':
                return getNodeStatus;
            default:
                return null;
        }
    };
    const getNodes = async () => {
        const nodes = await proxmoxManager.proxmoxRequest('/nodes');
        return {
            content: [{ type: 'text', text: JSON.stringify(nodes, null, 2) }]
        };
    };
    const getNodeStatus = async (args) => {
        const status = await proxmoxManager.proxmoxRequest(`/nodes/${args.node}/status`);
        return {
            content: [{ type: 'text', text: JSON.stringify(status, null, 2) }]
        };
    };
    return {
        listTools,
        getTool,
    };
}

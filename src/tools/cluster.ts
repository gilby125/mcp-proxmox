import { ProxmoxManager } from '../core/proxmox.js';

export function getClusterTools(proxmoxManager: ProxmoxManager) {
    const listTools = () => {
        return [
            {
                name: 'get_cluster_status',
                description: 'Get overall cluster status including nodes and resource usage',
                inputSchema: {
                    type: 'object',
                    properties: {}
                }
            },
        ];
    };

    const getTool = (name: string) => {
        switch (name) {
            case 'get_cluster_status':
                return getClusterStatus;
            default:
                return null;
        }
    };

    const getClusterStatus = async () => {
        const status = await proxmoxManager.proxmoxRequest('/cluster/status');
        return {
            content: [{ type: 'text', text: JSON.stringify(status, null, 2) }]
        };
    };

    return {
        listTools,
        getTool,
    };
}
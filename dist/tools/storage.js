export function getStorageTools(proxmoxManager) {
    const listTools = () => {
        return [
            {
                name: 'get_storage',
                description: 'List all storage pools and their usage across the cluster',
                inputSchema: {
                    type: 'object',
                    properties: {
                        node: { type: 'string', description: 'Optional: filter by specific node' }
                    }
                }
            },
        ];
    };
    const getTool = (name) => {
        switch (name) {
            case 'get_storage':
                return getStorage;
            default:
                return null;
        }
    };
    const getStorage = async (args) => {
        let storages = [];
        if (args.node) {
            storages = await proxmoxManager.proxmoxRequest(`/nodes/${args.node}/storage`);
            storages = storages.map(storage => ({ ...storage, node: args.node }));
        }
        else {
            const nodes = await proxmoxManager.proxmoxRequest('/nodes');
            for (const node of nodes) {
                const nodeStorages = await proxmoxManager.proxmoxRequest(`/nodes/${node.node}/storage`);
                storages.push(...nodeStorages.map((storage) => ({ ...storage, node: node.node })));
            }
        }
        return {
            content: [{ type: 'text', text: JSON.stringify(storages, null, 2) }]
        };
    };
    return {
        listTools,
        getTool,
    };
}

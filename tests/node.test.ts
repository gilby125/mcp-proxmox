import { getNodeTools } from '../src/tools/node.js';
import { ProxmoxManager } from '../src/core/proxmox.js';
import { ProxmoxConfig, AuthConfig } from '../src/types/index.js';

describe('NodeTools', () => {
    let proxmoxManager: ProxmoxManager;
    let nodeTools: any;

    beforeEach(() => {
        const proxmoxConfig: ProxmoxConfig = {
            host: 'localhost',
            port: 8006,
            verify_ssl: false,
        };
        const authConfig: AuthConfig = {
            user: 'root@pam',
            token_name: 'test',
            token_value: 'test',
        };
        const config = { ...proxmoxConfig, ...authConfig };
        proxmoxManager = new ProxmoxManager(config);
        nodeTools = getNodeTools(proxmoxManager);
    });

    it('should list nodes', async () => {
        const mockNodes = [{ node: 'pve1' }];
        const proxmoxRequest = jest.spyOn(proxmoxManager, 'proxmoxRequest').mockResolvedValue(mockNodes);
        const getNodes = nodeTools.getTool('get_nodes');
        const result = await getNodes();
        expect(result.content[0].text).toEqual(JSON.stringify(mockNodes, null, 2));
        expect(proxmoxRequest).toHaveBeenCalledWith('/nodes');
    });

    it('should get node status', async () => {
        const mockStatus = { status: 'online' };
        const proxmoxRequest = jest.spyOn(proxmoxManager, 'proxmoxRequest').mockResolvedValue(mockStatus);
        const getNodeStatus = nodeTools.getTool('get_node_status');
        const result = await getNodeStatus({ node: 'pve1' });
        expect(result.content[0].text).toEqual(JSON.stringify(mockStatus, null, 2));
        expect(proxmoxRequest).toHaveBeenCalledWith('/nodes/pve1/status');
    });
});
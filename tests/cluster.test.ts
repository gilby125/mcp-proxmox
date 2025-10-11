import { getClusterTools } from '../src/tools/cluster.js';
import { ProxmoxManager } from '../src/core/proxmox.js';
import { ProxmoxConfig, AuthConfig } from '../src/types/index.js';

describe('ClusterTools', () => {
    let proxmoxManager: ProxmoxManager;
    let clusterTools: any;

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
        clusterTools = getClusterTools(proxmoxManager);
    });

    it('should get cluster status', async () => {
        const mockStatus = { status: 'OK' };
        const proxmoxRequest = jest.spyOn(proxmoxManager, 'proxmoxRequest').mockResolvedValue(mockStatus);
        const getClusterStatus = clusterTools.getTool('get_cluster_status');
        const result = await getClusterStatus();
        expect(result.content[0].text).toEqual(JSON.stringify(mockStatus, null, 2));
        expect(proxmoxRequest).toHaveBeenCalledWith('/cluster/status');
    });
});
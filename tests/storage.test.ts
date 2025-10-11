import { getStorageTools } from '../src/tools/storage.js';
import { ProxmoxManager } from '../src/core/proxmox.js';
import { ProxmoxConfig, AuthConfig } from '../src/types/index.js';

describe('StorageTools', () => {
    let proxmoxManager: ProxmoxManager;
    let storageTools: any;

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
        storageTools = getStorageTools(proxmoxManager);
    });

    it('should list storage', async () => {
        const mockNodes = [{ node: 'pve1' }];
        const mockStorage = [{ storage: 'local' }];
        const proxmoxRequest = jest.spyOn(proxmoxManager, 'proxmoxRequest')
            .mockResolvedValueOnce(mockNodes)
            .mockResolvedValueOnce(mockStorage);
        const getStorage = storageTools.getTool('get_storage');
        const result = await getStorage({});
        expect(result.content[0].text).toEqual(JSON.stringify([...mockStorage.map(s => ({ ...s, node: 'pve1' }))], null, 2));
        expect(proxmoxRequest).toHaveBeenCalledWith('/nodes');
        expect(proxmoxRequest).toHaveBeenCalledWith('/nodes/pve1/storage');
    });
});
import { getVmTools } from '../src/tools/vm.js';
import { ProxmoxManager } from '../src/core/proxmox.js';
import { ProxmoxConfig, AuthConfig } from '../src/types/index.js';

describe('VmTools', () => {
    let proxmoxManager: ProxmoxManager;
    let vmTools: any;

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
        vmTools = getVmTools(proxmoxManager);
    });

    it('should list vms', async () => {
        const mockNodes = [{ node: 'pve1' }];
        const mockVms = [{ vmid: '100' }];
        const proxmoxRequest = jest.spyOn(proxmoxManager, 'proxmoxRequest')
            .mockResolvedValueOnce(mockNodes)
            .mockResolvedValueOnce(mockVms)
            .mockResolvedValueOnce([]);
        const getVms = vmTools.getTool('get_vms');
        const result = await getVms({});
        expect(result.content[0].text).toEqual(JSON.stringify([...mockVms.map(vm => ({ ...vm, type: 'qemu', node: 'pve1' }))], null, 2));
        expect(proxmoxRequest).toHaveBeenCalledWith('/nodes');
        expect(proxmoxRequest).toHaveBeenCalledWith('/nodes/pve1/qemu');
        expect(proxmoxRequest).toHaveBeenCalledWith('/nodes/pve1/lxc');
    });

    it('should get vm status', async () => {
        const mockStatus = { status: 'running' };
        const proxmoxRequest = jest.spyOn(proxmoxManager, 'proxmoxRequest').mockResolvedValue(mockStatus);
        const getVmStatus = vmTools.getTool('get_vm_status');
        const result = await getVmStatus({ node: 'pve1', vmid: '100' });
        expect(result.content[0].text).toEqual(JSON.stringify(mockStatus, null, 2));
        expect(proxmoxRequest).toHaveBeenCalledWith('/nodes/pve1/qemu/100/status/current');
    });

    it('should execute vm command', async () => {
        const mockResult = { pid: 1234 };
        const proxmoxRequest = jest.spyOn(proxmoxManager, 'proxmoxRequest').mockResolvedValue(mockResult);
        const executeVmCommand = vmTools.getTool('execute_vm_command');
        const result = await executeVmCommand({ node: 'pve1', vmid: '100', command: 'ls' });
        expect(result.content[0].text).toEqual(JSON.stringify(mockResult, null, 2));
        expect(proxmoxRequest).toHaveBeenCalledWith('/nodes/pve1/qemu/100/agent/exec', 'POST', { command: 'ls' });
    });
});
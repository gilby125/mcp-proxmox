import { ProxmoxServer } from '../index.js';
import { jest } from '@jest/globals';

describe('ProxmoxServer getVMs', () => {
  let server;

  beforeEach(() => {
    // Mock environment variables
    process.env.PROXMOX_HOST = 'testhost';
    process.env.PROXMOX_USER = 'testuser';
    process.env.PROXMOX_TOKEN_NAME = 'testtoken';
    process.env.PROXMOX_TOKEN_VALUE = 'testvalue';

    server = new ProxmoxServer();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('should correctly assign node to LXC containers', async () => {
    // Arrange
    const mockNodes = [{ node: 'pve1' }];
    const mockQemu = [];
    const mockLxc = [{ vmid: 100, name: 'test-lxc' }];

    const mockProxmoxRequest = jest.spyOn(server, 'proxmoxRequest');
    mockProxmoxRequest
      .mockResolvedValueOnce(mockNodes) // First call for nodes
      .mockResolvedValueOnce(mockQemu)  // Second call for qemu
      .mockResolvedValueOnce(mockLxc);  // Third call for lxc

    // Act
    const result = await server.getVMs();

    // Assert
    expect(mockProxmoxRequest).toHaveBeenCalledWith('/nodes');
    expect(mockProxmoxRequest).toHaveBeenCalledWith('/nodes/pve1/qemu');
    expect(mockProxmoxRequest).toHaveBeenCalledWith('/nodes/pve1/lxc');
    expect(result.content[0].text).toContain('Node: pve1');
  });
});
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ProxmoxManager } from './core/proxmox.js';
import { getNodeTools } from './tools/node.js';
import { getVmTools } from './tools/vm.js';
import { getStorageTools } from './tools/storage.js';
import { getClusterTools } from './tools/cluster.js';
class ProxmoxMCPServer {
    constructor(config) {
        this.server = new Server({
            name: 'proxmox-server',
            version: '1.0.0',
            capabilities: {
                tools: {},
            },
        });
        this.proxmoxManager = new ProxmoxManager(config);
        this.setupToolHandlers();
    }
    setupToolHandlers() {
        const nodeTools = getNodeTools(this.proxmoxManager);
        const vmTools = getVmTools(this.proxmoxManager);
        const storageTools = getStorageTools(this.proxmoxManager);
        const clusterTools = getClusterTools(this.proxmoxManager);
        this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: [
                ...nodeTools.listTools(),
                ...vmTools.listTools(),
                ...storageTools.listTools(),
                ...clusterTools.listTools(),
            ]
        }));
        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const { name, arguments: args } = request.params;
            try {
                let tool = nodeTools.getTool(name);
                if (tool) {
                    return await tool(args);
                }
                tool = vmTools.getTool(name);
                if (tool) {
                    return await tool(args);
                }
                tool = storageTools.getTool(name);
                if (tool) {
                    return await tool(args);
                }
                tool = clusterTools.getTool(name);
                if (tool) {
                    return await tool(args);
                }
                throw new Error(`Unknown tool: ${name}`);
            }
            catch (error) {
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
    async run() {
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        console.error('Proxmox MCP server running on stdio');
    }
}
// Example usage
const config = {
    host: process.env.PROXMOX_HOST || 'localhost',
    port: parseInt(process.env.PROXMOX_PORT || '8006', 10),
    verify_ssl: process.env.PROXMOX_VERIFY_SSL === 'true',
    user: process.env.PROXMOX_USER || 'root@pam',
    token_name: process.env.PROXMOX_TOKEN_NAME || 'mcp-server',
    token_value: process.env.PROXMOX_TOKEN_VALUE || '',
};
const server = new ProxmoxMCPServer(config);
server.run().catch(console.error);

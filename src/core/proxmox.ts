import fetch from 'node-fetch';
import https from 'https';
import { ProxmoxConfig, AuthConfig } from '../types/index.js';

export class ProxmoxManager {
    private readonly proxmoxHost: string;
    private readonly proxmoxUser: string;
    private readonly proxmoxTokenName: string;
    private readonly proxmoxTokenValue: string;
    private readonly proxmoxPort: number;
    private readonly httpsAgent: https.Agent;

    constructor(config: ProxmoxConfig & AuthConfig) {
        this.proxmoxHost = config.host;
        this.proxmoxPort = config.port;
        this.proxmoxUser = config.user;
        this.proxmoxTokenName = config.token_name;
        this.proxmoxTokenValue = config.token_value;

        this.httpsAgent = new https.Agent({
            rejectUnauthorized: config.verify_ssl
        });
    }

    public async proxmoxRequest(endpoint: string, method: string = 'GET', body: any = null): Promise<any> {
        const baseUrl = `https://${this.proxmoxHost}:${this.proxmoxPort}/api2/json`;
        const url = `${baseUrl}${endpoint}`;

        const headers = {
            'Authorization': `PVEAPIToken=${this.proxmoxUser}!${this.proxmoxTokenName}=${this.proxmoxTokenValue}`,
            'Content-Type': 'application/json'
        };

        const options: any = {
            method,
            headers,
            agent: this.httpsAgent
        };

        if (body) {
            options.body = JSON.stringify(body);
        }

        try {
            const response = await fetch(url, options);

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Proxmox API error: ${response.status} - ${errorText}`);
            }

            const textResponse = await response.text();
            if (!textResponse.trim()) {
                throw new Error('Empty response from Proxmox API');
            }

            const data = JSON.parse(textResponse);
            return data.data;
        } catch (error: any) {
            if (error.name === 'SyntaxError') {
                throw new Error(`Failed to parse Proxmox API response: ${error.message}`);
            }
            throw new Error(`Failed to connect to Proxmox: ${error.message}`);
        }
    }
}
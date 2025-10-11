export interface ProxmoxConfig {
    host: string;
    port: number;
    verify_ssl: boolean;
}

export interface AuthConfig {
    user: string;
    token_name: string;
    token_value: string;
}
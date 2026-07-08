# Minimal image for the Proxmox MCP server.
FROM node:22-alpine

WORKDIR /app

# Install production dependencies first for better layer caching.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Application code.
COPY index.js ./

# Configuration is supplied via environment variables at runtime:
#   PROXMOX_HOST, PROXMOX_TOKEN_VALUE (required)
#   PROXMOX_USER, PROXMOX_TOKEN_NAME, PROXMOX_PORT,
#   PROXMOX_ALLOW_ELEVATED, PROXMOX_VERIFY_TLS,
#   PROXMOX_NODE_ALLOWLIST, PROXMOX_VMID_ALLOWLIST
#
# The server speaks MCP over stdio, so run it attached:
#   docker run -i --rm -e PROXMOX_HOST=... -e PROXMOX_TOKEN_VALUE=... mcp-proxmox
ENTRYPOINT ["node", "index.js"]

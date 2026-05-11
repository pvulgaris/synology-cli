# synology-nas-mcp container.
#
# Runs the MCP server over Streamable HTTP, bound to a specific interface
# (default: tailscale0's IPv4 — Container Manager's host-network mode shares
# the DSM host's tailscale0 device with the container).
#
# Credentials live in 1Password; the container reads them at startup via
# the `op` CLI using a service-account token mounted as OP_SERVICE_ACCOUNT_TOKEN.

FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
# `prepare` script (tsc) runs during install, so tsconfig.json + src must be
# present before `npm ci`. Don't reorder these lines.
RUN npm ci

FROM node:20-alpine
WORKDIR /app

# Install 1Password CLI. Pinned at minor; bump when needed.
ARG OP_VERSION=2.30.3
RUN apk add --no-cache curl unzip ca-certificates \
 && ARCH=$(uname -m) \
 && case "$ARCH" in \
        x86_64)  OP_ARCH=amd64 ;; \
        aarch64) OP_ARCH=arm64 ;; \
        *) echo "unsupported arch $ARCH"; exit 1 ;; \
    esac \
 && curl -sSfL "https://cache.agilebits.com/dist/1P/op2/pkg/v${OP_VERSION}/op_linux_${OP_ARCH}_v${OP_VERSION}.zip" -o /tmp/op.zip \
 && unzip -d /usr/local/bin /tmp/op.zip op \
 && rm /tmp/op.zip \
 && apk del curl unzip

COPY package.json package-lock.json ./
# --ignore-scripts: skip `prepare: tsc` — tsc is a devDependency and we already
# have dist/ from the build stage. Without this, prod-only install errors.
RUN npm ci --omit=dev --ignore-scripts
COPY --from=build /app/dist ./dist

ENV NODE_ENV=production
EXPOSE 8765

# Bind defaults; override via Container Manager env.
ENV MCP_BIND_PORT=8765
ENV AUDIT_LOG_DIR=/audit

VOLUME /audit

ENTRYPOINT ["node", "dist/cli.js"]
CMD ["daemon"]

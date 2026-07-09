# synology-mcp container.
#
# Runs the MCP server over Streamable HTTP, bound to a specific interface
# (default: tailscale0's IPv4 — Container Manager's host-network mode shares
# the DSM host's tailscale0 device with the container).
#
# Credentials are read from bind-mounted `*_FILE` secrets or direct env vars
# (see auth.ts). The image ships no secret-manager client.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
# `prepare` script (tsc) runs during install, so tsconfig.json + src must be
# present before `npm ci`. Don't reorder these lines.
RUN npm ci

FROM node:22-alpine
WORKDIR /app

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

# NOTE: we deliberately do NOT set `USER node`. The compose file bind-mounts
# the host's audit/ directory to /audit, and that host directory's uid won't
# match the container's `node` user (uid 1000). The hardening we DO ship is
# `cap_drop: ALL` + `no-new-privileges` in the compose file, which neuters
# in-container root. To run as the `node` user safely, you'd also need to
# `chown -R 1000:1000` the host audit directory; left as a manual step for
# anyone who wants to take that on.

ENTRYPOINT ["node", "dist/cli.js"]
CMD ["daemon"]

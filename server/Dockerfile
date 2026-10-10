# Jarvis 3 instance server, with the app's web build (DE0CH/jarvis3-app, variant jarvis3) served
# at the root. Build context: server/. The web build must be in server/web-dist/ first:
# CI puts it there (.github/workflows/server.yml); locally run scripts/build-web.sh.
# docs/DEPLOY.md describes how an instance runs it.
FROM node:22-bookworm-slim

# git: the org-env tree is read from a bare mirror with `git archive` (src/orgenv-git.ts)
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app/server
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY src ./src
COPY web-dist /app/web

ARG APP_COMMIT=unknown
ARG SERVER_COMMIT=unknown
LABEL org.opencontainers.image.source="https://github.com/DE0CH/jarvis3" \
      org.opencontainers.image.description="Jarvis 3 instance server" \
      jarvis3.app-commit="${APP_COMMIT}" \
      jarvis3.server-commit="${SERVER_COMMIT}"

ENV NODE_ENV=production \
    PORT=8080 \
    JARVIS_DB=/data/jarvis.db \
    JARVIS_CONFIG=/etc/jarvis/config.json \
    JARVIS_WEB_DIR=/app/web

RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]

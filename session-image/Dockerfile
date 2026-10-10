# Jarvis 3 session machine: OpenCode (the agent, on OpenRouter) driven by a Paseo daemon, plus
# jarvis-agent (layers, reverse channel to the instance server, status, "remember"). One machine
# per task; nothing in it but the task owner's capped OpenRouter key (and capped proxy sub-account,
# when the instance's proxy provider has them) and its own session token.
# docs/SESSION-IMAGE.md describes the boot sequence and the contract with the server.
#
# Size matters: Fly refuses images over ~8 GB unpacked, so every trim happens in the same RUN that
# installs (a later RUN can't make an earlier layer smaller).
FROM node:22-bookworm-slim

# keep @opencode-ai/plugin in package.json at the same version (the policy plugin builds on it)
ARG OPENCODE_VERSION=1.18.35
ARG PASEO_VERSION=0.11.1

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git tini procps python3 ripgrep less \
 && rm -rf /var/lib/apt/lists/* \
 && useradd -m -u 1001 -s /bin/bash jarvis

# OpenCode + the Paseo CLI/daemon. Trims (Jarvis 3 runs OpenCode only):
#  - opencode hard-links its platform binary into bin/opencode.exe at install: the platform
#    packages (x64 and x64-baseline, 178 MB each) are spare copies
#  - Paseo bundles the Claude Agent SDK's native binary (250 MB): no Claude here
RUN npm install -g --omit=dev --no-audit --no-fund opencode-ai@${OPENCODE_VERSION} @getpaseo/cli@${PASEO_VERSION} \
 && npm cache clean --force \
 && cd /usr/local/lib/node_modules \
 && rm -rf opencode-ai/node_modules/opencode-linux-* \
 && find @getpaseo/cli/node_modules/@anthropic-ai -maxdepth 1 -name 'claude-agent-sdk-*' -exec rm -rf {} + \
 && opencode --version && paseo --version

# jarvis-agent and the helpers
WORKDIR /usr/local/lib/jarvis
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY lib ./lib
COPY bin/jarvis-boot bin/jarvis-snapshot bin/jarvis-remember bin/jarvis-web bin/jarvis-files bin/jarvis-search /usr/local/bin/
RUN chmod 755 /usr/local/bin/jarvis-boot /usr/local/bin/jarvis-snapshot /usr/local/bin/jarvis-remember /usr/local/bin/jarvis-web /usr/local/bin/jarvis-files /usr/local/bin/jarvis-search

WORKDIR /home/jarvis
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/jarvis-boot"]

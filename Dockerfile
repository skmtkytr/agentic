FROM node:22-slim

WORKDIR /app

# Install Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# Install dependencies
COPY package.json package-lock.json ./
RUN npm ci

# Install web dependencies and build
COPY web/package.json web/package-lock.json ./web/
RUN cd web && npm ci

COPY . .
RUN cd web && npm run build

EXPOSE 3001

# Default: run server. Override with "worker" for the worker container.
CMD ["npx", "tsx", "src/server.ts"]

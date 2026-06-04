# Game server image. The server is a long-lived, stateful WS process — it must
# run on a persistent host (Render/Fly/Railway/VM), NOT a serverless platform.
FROM node:22-slim

WORKDIR /app

# Install deps (workspaces) — copy lockfile + all package manifests first so
# Docker can cache the install layer when only source changes.
COPY package.json package-lock.json ./
COPY packages/engine/package.json packages/engine/
COPY packages/protocol/package.json packages/protocol/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
RUN npm install

# Build the packages the server depends on, then bring in the source.
COPY . .
RUN npm run build -w @chess-openworld/engine -w @chess-openworld/protocol

ENV NODE_ENV=production
# Hosts inject PORT; default to 8080 for local `docker run`.
ENV PORT=8080
EXPOSE 8080

CMD ["npm", "run", "start", "-w", "@chess-openworld/server"]

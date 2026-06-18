# Single-image build for the whole game: builds the shared lib, the client
# bundle and the server, then runs the server (which also serves the client).
# Works on Railway / Fly / any container host. Railway auto-detects this file.
FROM node:22-slim

WORKDIR /app

# Install all dependencies (including dev: tsc/vite are needed for the build).
# Copy manifests first so this layer is cached when only source changes.
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY client/package.json client/
COPY server/package.json server/
COPY editor/package.json editor/
RUN npm ci --include=dev

# Build shared -> client -> server (order matters: client/server import shared).
COPY . .
RUN npm run build --workspace @drunkr/shared \
 && npm run build --workspace @drunkr/client \
 && npm run build --workspace @drunkr/server

ENV NODE_ENV=production
# Railway/Fly inject $PORT; the server reads it (defaults to 2567 locally).
EXPOSE 2567
CMD ["node", "server/dist/index.js"]

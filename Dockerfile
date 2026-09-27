FROM node:22 AS build
WORKDIR /app

# Workspace manifests first so the dependency layer caches independently of source changes.
COPY package.json package-lock.json ./
COPY packages/runtime/package.json ./packages/runtime/
COPY packages/database/package.json ./packages/database/
COPY packages/mcp-client/package.json ./packages/mcp-client/
COPY packages/mcp-server/package.json ./packages/mcp-server/
RUN npm ci

COPY frontend/package.json frontend/package-lock.json ./frontend/
RUN cd frontend && npm ci

COPY . .
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
# node_modules/@mcp-llm/* are symlinks into packages/; ship their manifests and build output.
COPY --from=build /app/packages/runtime/package.json ./packages/runtime/
COPY --from=build /app/packages/runtime/dist ./packages/runtime/dist
COPY --from=build /app/packages/database/package.json ./packages/database/
COPY --from=build /app/packages/database/dist ./packages/database/dist
COPY --from=build /app/packages/mcp-client/package.json ./packages/mcp-client/
COPY --from=build /app/packages/mcp-client/dist ./packages/mcp-client/dist
COPY --from=build /app/dist ./dist

EXPOSE 3000
CMD ["node", "dist/index.js"]

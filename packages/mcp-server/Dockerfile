# Build context is the repository root (see docker-compose.yaml): the server
# depends on the @mcp-llm/runtime and @mcp-llm/database workspace packages and the root lockfile.
FROM node:22 AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/runtime/package.json ./packages/runtime/
COPY packages/database/package.json ./packages/database/
COPY packages/mcp-client/package.json ./packages/mcp-client/
COPY packages/mcp-server/package.json ./packages/mcp-server/
RUN npm ci --workspace @mcp-llm/runtime --workspace @mcp-llm/database --workspace @mcp-llm/mcp-server

COPY packages/runtime ./packages/runtime
COPY packages/database ./packages/database
COPY packages/mcp-server ./packages/mcp-server
RUN npm run build --workspace @mcp-llm/runtime --workspace @mcp-llm/database --workspace @mcp-llm/mcp-server \
  && npm prune --omit=dev --workspace @mcp-llm/runtime --workspace @mcp-llm/database --workspace @mcp-llm/mcp-server

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/runtime/package.json ./packages/runtime/
COPY --from=build /app/packages/runtime/dist ./packages/runtime/dist
COPY --from=build /app/packages/database/package.json ./packages/database/
COPY --from=build /app/packages/database/dist ./packages/database/dist
COPY --from=build /app/packages/mcp-server/package.json ./packages/mcp-server/
COPY --from=build /app/packages/mcp-server/dist ./packages/mcp-server/dist

EXPOSE 3001
CMD ["node", "packages/mcp-server/dist/index.js"]

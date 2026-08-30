FROM node:18 AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY mcp-client/package*.json ./mcp-client/
RUN cd mcp-client && npm ci

COPY frontend/package*.json ./frontend/
RUN cd frontend && npm install

COPY . .
RUN npm run build
RUN cd frontend && npm run build

FROM node:18-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/frontend/dist ./dist/frontend

EXPOSE 3000
CMD ["node", "dist/index.js"]

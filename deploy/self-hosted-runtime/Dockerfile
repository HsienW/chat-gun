ARG NODE_IMAGE=node:lts-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
# This spike must use unmodified upstream packages, including @langchain/core.
RUN npm ci --include=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force
COPY backend/src/ ./src/
COPY backend/data/commerce/synthetic-orders-v1.json ./data/commerce/synthetic-orders-v1.json
COPY backend/langgraph.json ./
COPY deploy/self-hosted-runtime/start-runtime.mjs ./start-runtime.mjs
COPY deploy/self-hosted-runtime/runtime-entrypoint.sh /usr/local/bin/runtime-entrypoint.sh
RUN mkdir -p .langgraph_api && chown -R node:node /app/backend
USER node
ENV NODE_ENV=development RUNTIME_HOST=0.0.0.0 RUNTIME_PORT=8000 RUNTIME_WORKERS=10
ENTRYPOINT ["/bin/sh", "/usr/local/bin/runtime-entrypoint.sh"]

FROM ${NODE_IMAGE} AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY frontend/ ./
COPY contracts/ /app/contracts/
RUN npm run build

FROM ${NODE_IMAGE} AS bff-builder
WORKDIR /app/bff
COPY bff/package.json bff/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY bff/ ./
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM ${NODE_IMAGE} AS bff
WORKDIR /app/bff
COPY --from=bff-builder /app/bff/dist ./dist
COPY --from=bff-builder /app/bff/node_modules ./node_modules
COPY --from=bff-builder /app/bff/package.json ./package.json
COPY --from=frontend-builder /app/frontend/dist /app/frontend/dist
USER node
ENV NODE_ENV=production BFF_PORT=8000 BFF_FRONTEND_DIST=/app/frontend/dist
CMD ["node", "dist/server.js"]

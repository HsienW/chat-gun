# Stage 1: Build React frontend.
FROM node:20-alpine AS frontend-builder

WORKDIR /app/frontend

COPY frontend/package.json ./
COPY frontend/package-lock.json ./
RUN npm install

COPY frontend/ ./
RUN npm run build

# Stage 2: LangGraph agent runtime.
FROM docker.io/langchain/langgraphjs-api:22 AS langgraph-api

USER root

RUN npm install -g @modelcontextprotocol/server-filesystem @modelcontextprotocol/server-brave-search

ADD backend/ /deps/backend
WORKDIR /deps/backend

RUN npm ci --include=dev && npm prune --omit=dev

ENV LANGSERVE_GRAPHS='{"deep_researcher": "/deps/backend/src/agents/deep-researcher.ts:deepResearcherGraph", "chatbot": "/deps/backend/src/agents/chatbot.ts:chatbotGraph", "mcp_agent": "/deps/backend/src/agents/mcp-agent.ts:mcpAgentGraph", "math_agent": "/deps/backend/src/agents/math-agent.ts:mathAgentGraph"}'

ENV MCP_FILESYSTEM_ENABLED=true
ENV MCP_FILESYSTEM_PATH=/app/workspace
ENV MCP_BRAVE_SEARCH_ENABLED=true

RUN mkdir -p /app/workspace && chmod 755 /app/workspace

WORKDIR /deps/backend

# Stage 3: BFF/API gateway. This is a separate package and the public edge.
FROM node:20-alpine AS bff

WORKDIR /app/bff

COPY bff/package.json ./
COPY bff/package-lock.json ./
RUN npm install

COPY bff/ ./
COPY --from=frontend-builder /app/frontend/dist /app/frontend/dist

RUN npm run build && npm prune --omit=dev

ENV NODE_ENV=production
ENV BFF_PORT=8000
ENV BFF_FRONTEND_DIST=/app/frontend/dist

EXPOSE 8000

CMD ["node", "dist/server.js"]

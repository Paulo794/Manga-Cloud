FROM node:22-alpine AS frontend-builder
ARG NPM_CONFIG_FETCH_RETRIES=2
ARG NPM_CONFIG_FETCH_TIMEOUT=300000
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci --no-audit
COPY frontend ./
RUN npm run build

FROM node:22-alpine AS backend-builder
ARG NPM_CONFIG_FETCH_RETRIES=2
ARG NPM_CONFIG_FETCH_TIMEOUT=300000
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci --no-audit
COPY backend/src ./src
COPY backend/tsconfig.json ./tsconfig.json
RUN npm run build && mkdir -p dist/docs && cp src/docs/openapi.yaml dist/docs/openapi.yaml

FROM node:22-alpine
ARG NPM_CONFIG_FETCH_RETRIES=2
ARG NPM_CONFIG_FETCH_TIMEOUT=300000
ENV NODE_ENV=production
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci --omit=dev --no-audit && npm cache clean --force
COPY --from=backend-builder /app/backend/dist ./dist
COPY backend/scripts ./scripts
COPY db /app/db
COPY --from=frontend-builder /app/frontend/dist /app/frontend/dist
USER node
EXPOSE 3001
CMD ["node", "dist/server.js"]

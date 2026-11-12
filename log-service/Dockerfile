FROM node:22-alpine AS builder
ARG NPM_CONFIG_FETCH_RETRIES=2
ARG NPM_CONFIG_FETCH_TIMEOUT=300000
WORKDIR /app
COPY package*.json ./
RUN npm ci --no-audit
COPY . .
RUN npm run build
FROM node:22-alpine
ARG NPM_CONFIG_FETCH_RETRIES=2
ARG NPM_CONFIG_FETCH_TIMEOUT=300000
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --no-audit && npm cache clean --force
COPY --from=builder /app/dist ./dist
USER node
CMD ["node", "dist/server.js"]

# Estágio de build do Frontend
FROM node:20-alpine AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm install
COPY frontend ./
# Executa o vite build diretamente (sem travar no tsc)
RUN npx vite build

# Estágio do Backend & Produção
FROM node:20-alpine
WORKDIR /app

# Dependências do backend
COPY backend/package*.json ./backend/
RUN cd backend && npm install

# Código do backend e scripts SQL versionados (db/)
COPY db ./db
COPY backend ./backend

# Instala tsx para rodar TypeScript diretamente
RUN npm install -g tsx

# Copia build estático do frontend
COPY --from=frontend-builder /app/frontend/dist /app/frontend/dist

EXPOSE 3001

WORKDIR /app/backend
CMD ["npx", "tsx", "src/server.ts"]

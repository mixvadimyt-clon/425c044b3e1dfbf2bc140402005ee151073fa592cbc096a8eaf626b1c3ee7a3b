# syntax=docker/dockerfile:1
# api «Продукт». Контекст — корень репозитория (нужны contracts/dist и матрица):
#   docker build -f services/api/Dockerfile -t inspector-api .
FROM node:22-bookworm-slim AS build
WORKDIR /app/services/api
COPY services/api/package.json services/api/package-lock.json ./
RUN npm ci
COPY contracts/dist /app/contracts/dist
COPY services/api/ ./
# типы из контрактов и сборка TypeScript (миграции копируются в dist/db/migrations)
RUN npm run gen && npm run build

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app/services/api
COPY services/api/package.json services/api/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/services/api/dist ./dist
# корень репозитория в контейнере — /app: контракты (роутинг и валидация) и матрица (первый сид)
COPY contracts/dist /app/contracts/dist
COPY data/matrix/params.csv /app/data/matrix/params.csv
ENV API_HOST=0.0.0.0 \
    API_PORT=3000 \
    DB_PATH=/data/inspector.sqlite \
    STORAGE_DIR=/data/storage \
    IMPORT_ROOT=/import
# uid 1000 — как у ml: общий том /data (файлы комплекта и разбор)
RUN mkdir -p /data/storage /import && chown -R node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/main.js"]

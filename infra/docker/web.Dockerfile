# syntax=docker/dockerfile:1
# Веб-клиент «Продукт» + обратный прокси с HTTPS (Caddy). Контекст — корень репозитория:
#   docker build -f infra/docker/web.Dockerfile -t inspector-web .
# Исходники — services/web, здесь только упаковка. Клиент ходит в api по относительным
# адресам (VITE_API_URL=/), Caddy отдаёт статику и проксирует /api/* в api — один адрес для всего.
FROM node:22-bookworm-slim AS build
WORKDIR /app/services/web
COPY services/web/package.json services/web/package-lock.json ./
RUN npm ci
COPY contracts/dist /app/contracts/dist
COPY services/web/ ./
ARG VITE_API_URL=/
ENV VITE_API_URL=${VITE_API_URL}
RUN npm run gen && npm run build

FROM caddy:2-alpine
COPY infra/docker/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/services/web/dist /srv
# SITE_ADDRESS: «:80» — без TLS (локально, CI); доменное имя — Caddy сам получит сертификат Let's Encrypt
ENV SITE_ADDRESS=:80
EXPOSE 80 443

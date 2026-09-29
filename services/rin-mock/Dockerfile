# Мок внешней ИС (ИАИС «РиН») — без зависимостей, только Node.js
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
ENV RIN_MOCK_HOST=0.0.0.0 \
    RIN_MOCK_PORT=4020 \
    RIN_MOCK_PACKAGES_DIR=/data/packages \
    RIN_MOCK_RESULTS_DIR=/data/results
RUN mkdir -p /data/packages /data/results && chown -R node:node /data
USER node
EXPOSE 4020
HEALTHCHECK --interval=10s --timeout=3s CMD wget -qO- http://127.0.0.1:4020/health || exit 1
CMD ["node", "src/main.mjs"]

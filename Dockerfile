# Dockerfile (na raiz do repo)
FROM node:20-bookworm-slim

# 1) Chromium + libs que o puppeteer/whatsapp-web.js precisa
RUN apt-get update && apt-get install -y --no-install-recommends \
  chromium \
  ca-certificates fonts-liberation \
  libasound2 libatk-bridge2.0-0 libatk1.0-0 libcups2 \
  libdbus-1-3 libdrm2 libxkbcommon0 libxcomposite1 \
  libxdamage1 libxfixes3 libxrandr2 libgbm1 libgtk-3-0 libnss3 \
  && rm -rf /var/lib/apt/lists/*

# 2) Variáveis dentro do container (não precisa repetir no EasyPanel)
ENV CHROME_PATH=/usr/bin/chromium \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    WWEBJS_NO_SANDBOX=1 \
    NODE_ENV=production

# 3) App
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# seu código está em /src
COPY src ./src

# 4) Start
CMD ["node", "src/index.js"]

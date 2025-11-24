# Dockerfile
FROM node:20-bookworm-slim

# Evita baixar chromium do puppeteer (não usamos puppeteer bundled)
ENV PUPPETEER_SKIP_DOWNLOAD=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    NODE_ENV=production \
    TZ=America/Sao_Paulo

# Dependências do Chromium + fontes e libs comuns a whatsapp-web.js
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    libasound2 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libatspi2.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libexpat1 \
    libgbm1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnss3 \
    libpango-1.0-0 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    xdg-utils \
    ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Garante que whatsapp-web.js ache o binário do Chrome/Chromium
ENV CHROME_PATH=/usr/bin/chromium

# App
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# Copia código
COPY src ./src

# Pasta de sessão do WhatsApp persistida via volume
RUN mkdir -p /app/.wwebjs_auth && chown -R node:node /app
VOLUME ["/app/.wwebjs_auth"]

USER node

CMD ["npm", "start"]

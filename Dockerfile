# ---- base: Debian (tem chromium via APT) ----
FROM node:18-bookworm-slim

# Evita prompts do apt
ENV DEBIAN_FRONTEND=noninteractive

# Instala Chromium e libs necessárias p/ puppeteer/whatsapp-web.js
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    ca-certificates fonts-liberation \
    libasound2 libatk-bridge2.0-0 libatk1.0-0 libcups2 \
    libdbus-1-3 libdrm2 libxkbcommon0 libxcomposite1 \
    libxdamage1 libxfixes3 libxrandr2 libgbm1 libgtk-3-0 libnss3 \
  && rm -rf /var/lib/apt/lists/*

# Informa ao seu código onde está o binário
ENV CHROME_PATH=/usr/bin/chromium
# Desarma sandbox no container (recomendado p/ WA WebJS)
ENV WWEBJS_NO_SANDBOX=1
# Não baixar chrome do puppeteer
ENV PUPPETEER_SKIP_DOWNLOAD=1

WORKDIR /app

# Instala dependências primeiro (cache melhor)
COPY package*.json ./
RUN npm ci --omit=dev

# Copia o restante do projeto
COPY . .

# (Opcional) se você quiser expor uma porta; se o bot não tem HTTP, tanto faz
EXPOSE 3000

# Sobe o bot
CMD ["npm", "run", "start"]

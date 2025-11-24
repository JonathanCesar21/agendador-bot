# Base estável com APT que tem chromium: Debian bullseye-slim
FROM node:20-bullseye-slim

# Evita prompts do apt
ENV DEBIAN_FRONTEND=noninteractive

# Instala Chromium e libs necessárias pro Puppeteer/whatsapp-web.js headless
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    ca-certificates fonts-liberation \
    libasound2 libatk-bridge2.0-0 libatk1.0-0 libcups2 \
    libdbus-1-3 libdrm2 libxkbcommon0 libxcomposite1 \
    libxdamage1 libxfixes3 libxrandr2 libgbm1 libgtk-3-0 libnss3 \
 && rm -rf /var/lib/apt/lists/*

# Define o caminho do Chromium para o whatsapp-web.js (seu código já lê CHROME_PATH)
ENV CHROME_PATH=/usr/bin/chromium
# Sem sandbox (container)
ENV WWEBJS_NO_SANDBOX=1
# Tz opcional (se quiser)
# ENV TZ=America/Sao_Paulo

WORKDIR /app

# Copia package.json primeiro para cache de dependências
COPY package*.json ./

# Instala dependências (sem dev se desejar)
RUN npm ci --only=production || npm ci

# Copia o restante do projeto
# Ajuste se seus fontes estão em /src (como você disse)
COPY . .

# Garante que a pasta de sessão do wwebjs exista e persista (você pode mapear volume no painel)
RUN mkdir -p .wwebjs_auth .wwebjs_cache
VOLUME ["/app/.wwebjs_auth", "/app/.wwebjs_cache"]

# A porta que seu index.js realmente escuta (ajuste se necessário)
EXPOSE 3000

# Saúde opcional (só se seu index tem /health)
# HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
#   CMD node -e "require('http').get('http://localhost:3000/health',r=>{if(r.statusCode!==200)process.exit(1)})"

# Start
CMD ["node", "index.js"]

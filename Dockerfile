# Dockerfile
FROM node:20-bullseye

# Instala Chromium e libs necessárias
RUN apt-get update && apt-get install -y \
    chromium \
    ca-certificates fonts-liberation \
    libasound2 libatk-bridge2.0-0 libatk1.0-0 libcups2 \
    libdbus-1-3 libdrm2 libxkbcommon0 libxcomposite1 \
    libxdamage1 libxfixes3 libxrandr2 libgbm1 libgtk-3-0 libnss3 \
  && rm -rf /var/lib/apt/lists/*

# Define o caminho do Chromium para o bot
ENV CHROME_PATH=/usr/bin/chromium

# Cria diretório da app
WORKDIR /app

# Instala dependências
COPY package*.json ./
RUN npm ci --omit=dev

# Copia o código
COPY . .

# Porta (ajuste se seu bot expõe outra)
EXPOSE 3000

# Inicia seu bot (ajuste se seu start é diferente)
CMD ["npm", "start"]

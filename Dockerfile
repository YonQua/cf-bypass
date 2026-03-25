FROM node:20-slim AS base

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:20-slim AS runtime

# 安装 Chromium 和依赖
RUN apt update && \
    # 诊断步骤：如果找不到 143 版本，打印提示并列出可用版本
    (apt-cache madison chromium | grep "143" || (echo "❌ Chromium 143 not found! Available versions:" && apt-cache madison chromium | head -n 5)) && \
    apt install -y \
    chromium=143* \
    chromium-common=143* \
    chromium-sandbox=143* \
    xvfb \
    fonts-liberation libappindicator3-1 libasound2 libatk-bridge2.0-0 \
    libatk1.0-0 libxss1 libnss3 libxcomposite1 libxdamage1 libxrandr2 libgbm1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=base /app/node_modules ./node_modules
COPY . .

EXPOSE 8080

CMD ["npm", "start"]

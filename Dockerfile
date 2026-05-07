FROM node:20-slim AS base

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:20-slim AS runtime

ENV CLOAKBROWSER_AUTO_UPDATE=false \
    CLOAKBROWSER_CACHE_DIR=/app/.cloakbrowser

# 安装 CloakBrowser 运行依赖；浏览器二进制由 cloakbrowser 包在构建阶段下载
RUN apt update && \
    apt install -y \
    xvfb \
    fonts-noto-color-emoji fonts-freefont-ttf fonts-unifont \
    fonts-ipafont-gothic fonts-wqy-zenhei fonts-tlwg-loma-otf \
    fonts-liberation libappindicator3-1 libasound2 libatk-bridge2.0-0 \
    libatk1.0-0 libxss1 libnss3 libxcomposite1 libxdamage1 libxrandr2 libgbm1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=base /app/node_modules ./node_modules
RUN node -e "import('cloakbrowser').then(({ ensureBinary }) => ensureBinary())"
COPY . .

EXPOSE 8080

CMD ["npm", "start"]

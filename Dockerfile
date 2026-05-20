# Playwright-capable image with Chromium pre-installed
FROM node:20-bookworm-slim

# Install Chromium system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    fonts-liberation \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
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
    libxshmfence1 \
    wget \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Download Chromium browser binary
RUN npx playwright install chromium

COPY server.js migrate.js ./
COPY src/ ./src/
COPY ui/ ./ui/

RUN mkdir -p /app/sessions /app/uploads /app/customers

ENV NODE_ENV=production
ENV SESSION_DIR=/app/sessions
ENV PLAYWRIGHT_HEADLESS=true
ENV PORT=4000

EXPOSE 4000
CMD ["node", "server.js"]

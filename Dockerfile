FROM mcr.microsoft.com/playwright:v1.52.0-noble

RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    x11vnc \
    novnc \
    websockify \
    zip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev
# Install the Chromium version matching the installed npm package
RUN npx playwright install chromium

COPY server.js migrate.js ./
COPY src/ ./src/
COPY ui/ ./ui/
COPY extension/ ./extension/

# Pre-zip extension so users can download and load unpacked in Chrome
RUN cd /app && zip -r extension.zip extension/

RUN mkdir -p /app/sessions /app/uploads /app/customers

ENV NODE_ENV=production
ENV SESSION_DIR=/app/sessions
# false = use Xvfb display for new users, headless auto-applies for returning users
ENV PLAYWRIGHT_HEADLESS=false
ENV NOVNC_PATH=/usr/share/novnc
ENV PORT=4000

EXPOSE 4000 6080
CMD ["node", "server.js"]

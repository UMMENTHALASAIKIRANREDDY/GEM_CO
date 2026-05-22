# Playwright base — needed by main's browser-automation feature (Chromium +
# extension probe via VNC). Ubuntu Noble underneath, so apt-get works for the
# Python data libs the Copilot/Gemini regen pipelines need.
FROM mcr.microsoft.com/playwright:v1.52.0-noble

# System packages: main's VNC/extension stack PLUS Python + libs that
# Copilot/Gemini regen code commonly imports (cairo/pango for weasyprint,
# freetype for matplotlib/Pillow, libffi for cryptography wheels).
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    x11vnc \
    novnc \
    websockify \
    zip \
    python3 python3-pip python3-venv \
    libcairo2 libpango-1.0-0 libpangocairo-1.0-0 libgdk-pixbuf-2.0-0 \
    libffi-dev libjpeg62-turbo zlib1g libxml2 libxslt1.1 \
    fonts-dejavu fonts-liberation \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/bin/python3 /usr/local/bin/python

WORKDIR /app

# Python libraries (single-purpose container, install system-wide).
# --break-system-packages required on Ubuntu Noble because of PEP 668 marker.
COPY requirements.txt ./
RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt

# Node dependencies + Playwright Chromium
COPY package*.json ./
RUN npm ci --omit=dev
RUN npx playwright install chromium

# Application source
COPY server.js migrate.js ./
COPY src/ ./src/
COPY ui/ ./ui/
COPY extension/ ./extension/

# Pre-zip extension so users can download and load unpacked in Chrome
RUN cd /app && zip -r extension.zip extension/

# Runtime dirs (also volume-mounted by docker-compose)
RUN mkdir -p /app/sessions /app/uploads /app/customers

ENV NODE_ENV=production
ENV SESSION_DIR=/app/sessions
# false = use Xvfb display for new users, headless auto-applies for returning users
ENV PLAYWRIGHT_HEADLESS=false
ENV NOVNC_PATH=/usr/share/novnc
ENV PORT=4000
# Point the regen pipeline at the Python we just installed
ENV C2C_PYTHON_BIN=/usr/local/bin/python

EXPOSE 4000 6080
CMD ["node", "server.js"]

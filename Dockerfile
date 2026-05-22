# Node 18 on Debian slim — needed instead of alpine because the Copilot/Gemini
# regen pipelines spawn Python with libraries like weasyprint/cairo that
# don't have musl wheels and are painful to build on alpine.
FROM node:18-slim

# System dependencies for Python + the runtime libraries Copilot/Gemini
# regen code commonly uses (cairo/pango for weasyprint, freetype for
# matplotlib/Pillow, libffi for cryptography wheels).
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv \
    libcairo2 libpango-1.0-0 libpangocairo-1.0-0 libgdk-pixbuf-2.0-0 \
    libffi-dev libjpeg62-turbo zlib1g libxml2 libxslt1.1 \
    fonts-dejavu fonts-liberation \
    wget ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/bin/python3 /usr/local/bin/python

WORKDIR /app

# Python libraries — installed system-wide (slim image, single-purpose container).
# --break-system-packages required on Debian Bookworm because of PEP 668 marker.
COPY requirements.txt ./
RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt

# Node dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Application source
COPY server.js migrate.js ./
COPY src/ ./src/
COPY ui/ ./ui/

# Runtime data dirs (also volume-mounted by docker-compose)
RUN mkdir -p uploads customers

# Point the regen pipeline at the Python we just installed
ENV C2C_PYTHON_BIN=/usr/local/bin/python
ENV NODE_ENV=production

EXPOSE 4000
CMD ["node", "server.js"]

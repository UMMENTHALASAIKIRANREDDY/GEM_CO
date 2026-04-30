# Use Node.js 18 Alpine for smaller image size
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy package files
COPY package.json package-lock.json ./

# Install production dependencies only
RUN npm ci --omit=dev

# Copy application source
COPY server.js migrate.js ./
COPY src/ ./src/
COPY ui/ ./ui/

# Service account key is volume-mounted at runtime via docker-compose
# (service_account.json → /app/service_account.json)

# Create directories for runtime data
RUN mkdir -p uploads customers

# Expose the application port
EXPOSE 4000

# Set NODE_ENV to production
ENV NODE_ENV=production

# Start the server
CMD ["node", "server.js"]

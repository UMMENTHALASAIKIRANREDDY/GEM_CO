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
COPY copilot/copilot/server/ ./copilot/copilot/server/
COPY copilot/copilot/service_account.json ./service_account.json

# Create directories for runtime data
RUN mkdir -p uploads customers

# Expose the application port
EXPOSE 3000

# Set NODE_ENV to production
ENV NODE_ENV=production

# Start the server
CMD ["node", "server.js"]

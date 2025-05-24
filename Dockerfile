# Use official Node.js runtime as base image
FROM node:18-alpine

# Set working directory in container
WORKDIR /app

# Copy package files first (for better caching)
COPY package*.json ./

# Install dependencies with error handling
RUN npm ci --only=production --no-audit --no-fund || \
    npm install --production --no-audit --no-fund

# Clean npm cache
RUN npm cache clean --force

# Create directories
RUN mkdir -p uploads public

# Copy application code
COPY . .

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nextjs -u 1001

# Change ownership of necessary directories
RUN chown -R nextjs:nodejs /app/uploads /app/public

# Switch to non-root user
USER nextjs

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node healthcheck.js || exit 1

# Start the application
CMD ["npm", "start"]

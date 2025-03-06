# Production stage
FROM node:18-alpine

LABEL org.opencontainers.image.description="WebSocket Multiplexer"
LABEL org.opencontainers.image.source="https://github.com/enexflow/websocket-multiplex"

# Set working directory
WORKDIR /app

# Create a non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

COPY package*.json ./

# Install only production dependencies
RUN npm ci --only=production && \
    npm cache clean --force

COPY websocket-multiplex.js ./

# Set proper permissions
RUN chown -R appuser:appgroup /app

# Switch to non-root user
USER appuser

# Expose the ports
EXPOSE 8080 8081

# Define environment variables
ENV NODE_ENV=production
ENV PORT=8080
ENV MASTER_PORT=8081
ENV UPSTREAM_URL=ws://localhost:9000
ENV LOG_LEVEL=INFO
ENV MESSAGE_QUEUE_TIMEOUT=30000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/ || exit 1

# Start the application
CMD ["node", "websocket-multiplex.js"]
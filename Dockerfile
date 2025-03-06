# Use the official Node.js image as the base
FROM node:18-alpine

# Set the working directory
WORKDIR /app

# Copy the application code
COPY websocket-multiplex.js  package.json package-lock.json ./

# Install necessary dependencies
RUN npm install

# Expose the port the app runs on
EXPOSE 8080

# Define environment variables
ENV PORT=8080
ENV UPSTREAM_URL=ws://localhost:9000

# Start the application
CMD ["node", "websocket-multiplex.js"]
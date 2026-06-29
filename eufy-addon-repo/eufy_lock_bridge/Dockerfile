FROM node:18-alpine

# Install requirements
RUN apk add --no-cache iojs-headers nodejs npm

WORKDIR /app

# Copy package management files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy application code
COPY . .

# Expose the app port
EXPOSE 8124

# Run the server directly
CMD [ "node", "server.js" ]

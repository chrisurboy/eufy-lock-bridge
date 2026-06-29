FROM node:22-alpine

WORKDIR /app

# Copy package management files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy application code
COPY . .

# Expose the app port
EXPOSE 8124

# Read configuration directly from Home Assistant's options file and run
CMD ["sh", "-c", "export EUFY_USERNAME=$(jq -r '.eufy_username' /data/options.json) && export EUFY_PASSWORD=$(jq -r '.eufy_password' /data/options.json) && export EUFY_COUNTRY=$(jq -r '.eufy_country' /data/options.json) && export LOCKS=$(jq -r '.locks' /data/options.json) && node server.js"]

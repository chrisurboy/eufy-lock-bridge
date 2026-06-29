FROM ghcr.io/home-assistant/base:latest

LABEL \
  io.hass.version="0.1.0" \
  io.hass.type="app" \
  io.hass.arch="armhf|aarch64|amd64|armv7|i386"

# Install Node.js and npm (HA base images are Alpine-based)
RUN apk add --no-cache nodejs npm

WORKDIR /app
COPY server.js package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY run.sh /
RUN chmod a+x /run.sh

CMD [ "/run.sh" ]

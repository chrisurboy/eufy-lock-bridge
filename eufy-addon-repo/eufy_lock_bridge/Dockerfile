FROM node:22-alpine

LABEL \
  io.hass.version="0.2.0" \
  io.hass.type="app" \
  io.hass.arch="armhf|aarch64|amd64|armv7|i386"

WORKDIR /app
COPY server.js package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

CMD [ "node", "server.js" ]

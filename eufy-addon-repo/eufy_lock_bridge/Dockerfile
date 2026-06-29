FROM node:22-alpine

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

EXPOSE 8124

CMD ["sh", "-c", "export EUFY_USERNAME=$(jq -r '.eufy_username' /data/options.json) && export EUFY_PASSWORD=$(jq -r '.eufy_password' /data/options.json) && export EUFY_COUNTRY=$(jq -r '.eufy_country' /data/options.json) && export LOCKS=$(jq -r '.locks' /data/options.json) && node server.js"]

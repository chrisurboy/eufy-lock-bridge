#!/usr/bin/with-contenv bashio

EUFY_USERNAME="$(bashio::config 'eufy_username')"
EUFY_PASSWORD="$(bashio::config 'eufy_password')"
EUFY_COUNTRY="$(bashio::config 'eufy_country')"
LOCKS="$(bashio::config 'locks')"

export EUFY_USERNAME
export EUFY_PASSWORD
export EUFY_COUNTRY
export LOCKS
export PORT=8124

bashio::log.info "Starting eufy-lock-bridge..."

cd /app
exec node server.js



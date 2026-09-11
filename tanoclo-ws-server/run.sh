#!/usr/bin/with-contenv bashio
# ==============================================================================
# Script: run.sh
# Description: Launch script for Home Assistant app container entrypoint.
#              Uses s6-overlay with-contenv wrapper. Spawns the main app-entrypoint.js.
# ==============================================================================
node /app/tanoclo-ws-server/app-entrypoint.js

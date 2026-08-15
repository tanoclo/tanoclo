#!/usr/bin/with-contenv bashio
# ==============================================================================
# Script: run.sh
# Description: Launch script for Home Assistant addon container entrypoint.
#              Uses s6-overlay with-contenv wrapper. Spawns the main addon-entrypoint.js.
# ==============================================================================
node /app/tanoclo-ws-server/addon-entrypoint.js

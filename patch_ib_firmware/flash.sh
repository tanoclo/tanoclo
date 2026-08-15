#!/usr/bin/env bash
# ==============================================================================
# Script: flash.sh
# Description: Uses OpenOCD tools over ST-Link adapter connection interfaces to
#              flash custom patched firmware images to the STM32F4x target.
#              Flashes internal flash image and/or external SPI flash based on
#              the parameters provided.
#
# Usage:
#   ./flash.sh <flash_internal> <flash_spi>
#     where arguments are 0 (skip) or 1 (flash)
# ==============================================================================
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 <flash_internal> <flash_spi>" >&2
  exit 1
fi

flash_internal="$1"
flash_spi="$2"

modded_spi_ca_endpoint="IB-SPI-patched-ca-endpoint.bin"
modded_internal_ca_endpoint_crc="IB-patched-ca-endpoint-crc.bin"

need() { command -v "$1" >/dev/null 2>&1 || { echo "ERROR: missing tool: $1" >&2; exit 1; }; }
need dd
need od
need awk
need stat
need mktemp
need openssl
need wc
need grep
need printf

if lsusb | grep -qi 'st-link'; then
  echo "Flash - ST-Link device detected"
else
  echo "Flash - No ST-Link device detected"
  exit 1
fi

# Check files exist in out/
out_internal="out/$modded_internal_ca_endpoint_crc"
out_spi="out/$modded_spi_ca_endpoint"

if [[ "$flash_internal" -eq 1 ]]; then
  [[ -f "$out_internal" ]] || { echo "Flash - ERROR not found in out directory: $out_internal" >&2; exit 2; }
fi
if [[ "$flash_spi" -eq 1 ]]; then
  [[ -f "$out_spi" ]] || { echo "Flash - ERROR: not found in out directory: $out_spi" >&2; exit 2; }
fi

# Copy temporarily to current directory for OpenOCD
if [[ "$flash_internal" -eq 1 ]]; then
  cp "$out_internal" "$modded_internal_ca_endpoint_crc"
fi
if [[ "$flash_spi" -eq 1 ]]; then
  cp "$out_spi" "$modded_spi_ca_endpoint"
fi

cleanup() {
  rm -f "$modded_internal_ca_endpoint_crc" "$modded_spi_ca_endpoint"
}
trap cleanup EXIT

if [[ "$flash_internal" -eq 1 ]]; then
  echo "Flash - Flashing patched binary to internal flash"
  openocd -f interface/stlink.cfg -f target/stm32f4x.cfg -f program_internal_flash.tcl
  echo "Flash - Done flashing patched binary to internal flash"
fi

if [[ "$flash_spi" -eq 1 ]]; then
  echo "Flash - Flashing patched binary to external SPI flash"
  openocd -f interface/stlink.cfg -f target/stm32f4x.cfg -f program_external_flash.tcl
  echo "Flash - Done flashing patched binary to external SPI flash"
fi

echo "Flash - Done"
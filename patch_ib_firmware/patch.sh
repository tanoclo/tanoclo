#!/usr/bin/env bash
# ==============================================================================
# Script: patch.sh
# Description: Coordinates the entire firmware patching pipeline.
#              Calls build_all_and_patch.sh to inject CA certificate, calls
#              patch_endpoint.sh to modify websocket URL endpoints, recalculates
#              internal flash segment checksums via patch_crc.sh, and overlays
#              the patched segments onto the external SPI flash image slots.
#
# Usage:
#   ./patch.sh <spi_slot> <endpoint_type>
#     where <spi_slot> is:
#       0 - Skip patching the external SPI flash
#       1 - Patch Slot A only (offset 128 KiB)
#       2 - Patch Slot B only (offset 512 KiB)
#       3 - Patch both Slot A and Slot B
#     where <endpoint_type> is:
#       1 - ws://ingress.tado.com:988
#       2 - ws://tanoclo.tado.lan:988
#       other - ws://ingress.tado.com:443 (default SSL)
# ==============================================================================
set -euo pipefail

if [[ $# -lt 2 || $# -gt 3 ]]; then
  echo "Usage: $0 <spi_slot> <endpoint_type> [reuse_certs]" >&2
  exit 1
fi

spi_slot="$1"
endpoint_type="$2"
reuse_certs="${3:-0}"

unmodded_internal="unmodded.bin"
unmodded_spi="unmodded_spi.bin"
modded_internal_ca="IB-patched-ca.bin"
modded_internal_ca_endpoint="IB-patched-ca-endpoint.bin"
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
need openocd

[[ -f "$unmodded_internal" ]] || { echo "Patch - ERROR not found: $unmodded_internal" >&2; exit 2; }

# Validate firmware is expected 512KB size
fw_size=$(wc -c < "$unmodded_internal" | tr -d ' ')
if [[ "$fw_size" -ne 524288 ]]; then
  echo "Patch - ERROR: $unmodded_internal is $fw_size bytes, expected 524288 (512KB)" >&2
  exit 2
fi

echo "Patch - Patching CA in internal flash dump and creating leaf certificates with new CA"
./build_all_and_patch.sh "$unmodded_internal" "$modded_internal_ca" "$endpoint_type" . "$reuse_certs"
echo "Patch - Done patching CA in internal flash dump and creating leaf certificates with new CA"

[[ -f "$modded_internal_ca" ]] || { echo "Patch - ERROR not found: $modded_internal_ca" >&2; exit 2; }

echo "Patch - Patching endpoint in internal flash"
./patch_endpoint.sh "$modded_internal_ca" "$modded_internal_ca_endpoint" "$endpoint_type"

[[ -f "$modded_internal_ca_endpoint" ]] || { echo "Patch - ERROR not found: $modded_internal_ca_endpoint" >&2; exit 2; }

if [ "$endpoint_type" == 1 ]; then
  echo "Patch - Endpoint set to ws://ingress.tado.com:988"
elif [ "$endpoint_type" == 2 ]; then
  echo "Patch - Endpoint set to ws://tanoclo.tado.lan:988"
else
  echo "Patch - Endpoint set to ws://ingress.tado.com:443"
fi

echo "Patch - Done patching endpoint in internal flash"

echo "Patch - Patching CRC in internal flash dump"
./patch_crc.sh "$modded_internal_ca_endpoint" "$modded_internal_ca_endpoint_crc"
[[ -f "$modded_internal_ca_endpoint_crc" ]] || { echo "Patch - ERROR not found: $modded_internal_ca_endpoint_crc" >&2; exit 2; }
echo "Patch - Done patching CRC in internal flash dump"

if [[ "$spi_slot" != 0 ]]; then
  [[ -f "$unmodded_spi" ]] || { echo "Patch - ERROR: not found: $unmodded_spi" >&2; exit 2; }

  cp "$unmodded_spi" "$modded_spi_ca_endpoint"
  echo "Patch - Patching external SPI flash"
  if [[ "$spi_slot" == 1 ]]; then
    dd if="$modded_internal_ca_endpoint_crc" of="$modded_spi_ca_endpoint" bs=1k skip=128 seek=128 count=384 conv=notrunc status=none
  elif [[ "$spi_slot" == 2 ]]; then
    dd if="$modded_internal_ca_endpoint_crc" of="$modded_spi_ca_endpoint" bs=1k skip=128 seek=512 count=384 conv=notrunc status=none
  elif [[ "$spi_slot" == 3 ]]; then
    dd if="$modded_internal_ca_endpoint_crc" of="$modded_spi_ca_endpoint" bs=1k skip=128 seek=128 count=384 conv=notrunc status=none
    dd if="$modded_internal_ca_endpoint_crc" of="$modded_spi_ca_endpoint" bs=1k skip=128 seek=512 count=384 conv=notrunc status=none
  fi
  echo "Patch - Done patching external SPI flash"
else
  echo "Patch - Skipping patch of external SPI flash"
fi

echo "Patch - Done"
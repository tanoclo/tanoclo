#!/usr/bin/env bash
# ==============================================================================
# Script: read.sh
# Description: Uses OpenOCD tools over ST-Link adapter connection interfaces to
#              dump the STM32 internal flash (512 KiB) and external SPI flash
#              memory. Recombines 4KB SPI page dumps back into a unified 2MB
#              unmodded_spi.bin image.
#
# Usage:
#   ./read.sh
# ==============================================================================
set -euo pipefail

unmodded_internal="unmodded.bin"
unmodded_spi="unmodded_spi.bin"

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

if lsusb | grep -qi 'st-link'; then
  echo "Read - ST-Link device detected"
else
  echo "Read - No ST-Link device detected"
  exit 1
fi

echo "Read - Dumping internal flash"
openocd -f interface/stlink.cfg -f target/stm32f4x.cfg -f dump_internal_flash.tcl
echo "Read - Done dumping internal flash"

[[ -f "$unmodded_internal" ]] || { echo "Read - ERROR not found: $unmodded_internal" >&2; exit 2; }

echo "Read: Dumping external SPI flash"
openocd -f interface/stlink.cfg -f target/stm32f4x.cfg -f dump_external_flash.tcl
echo "Read - Done dumping external SPI flash"

echo "Read: Combining SPI chunks into 1 binary and removing chunks"
ls -1 spi_[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F].bin | sort | xargs cat > $unmodded_spi
rm -f spi_[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F].bin
echo "Read - Done combining SPI chunks into 1 binary and removing chunks"

[[ -f "$unmodded_spi" ]] || { echo "Read - ERROR: not found: $unmodded_spi" >&2; exit 2; }

echo "Read - Done"
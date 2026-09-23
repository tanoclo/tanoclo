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

# Detect ST-Link: lsusb on Linux, ioreg on macOS (brew lsusb is broken on macOS 26+)
if [[ "$(uname -s)" == "Darwin" ]]; then
  stlink_present() { ioreg -p IOUSB -l 2>/dev/null | grep -qiE 'st-?link'; }
else
  stlink_present() { lsusb | grep -qiE 'st-?link'; }
fi

if stlink_present; then
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
rm -f spi_[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F].bin spi_[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F].chk "$unmodded_spi"
# Don't let set -e abort on an OpenOCD failure: fall through so partial chunks are cleaned up below.
openocd_rc=0
openocd -f interface/stlink.cfg -f target/stm32f4x.cfg -f dump_external_flash.tcl || openocd_rc=$?
echo "Read - Done dumping external SPI flash"

# A full 2 MiB dump is exactly 512 chunks of 4 KiB. Anything else means the stub aborted mid-way.
# nullglob array rather than ls|wc: with zero chunks, ls fails and pipefail would abort the script here.
shopt -s nullglob
chunks=(spi_[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F].bin)
shopt -u nullglob
chunk_count=${#chunks[@]}
if [[ "$openocd_rc" -ne 0 || "$chunk_count" -ne 512 ]]; then
  echo "Read - ERROR: SPI dump incomplete ($chunk_count of 512 chunks, OpenOCD exit $openocd_rc). Not combining; see OpenOCD errors above." >&2
  rm -f spi_[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F].bin spi_[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F].chk
  rm -f "$unmodded_spi"
  exit 4
fi

echo "Read: Combining SPI chunks into 1 binary and removing chunks"
cat "${chunks[@]}" > "$unmodded_spi"  # glob expansion is already sorted
rm -f spi_[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F].bin
echo "Read - Done combining SPI chunks into 1 binary and removing chunks"

spi_size=$(wc -c < "$unmodded_spi" | tr -d ' ')
[[ "$spi_size" -eq 2097152 ]] || { echo "Read - ERROR: $unmodded_spi is $spi_size bytes, expected 2097152" >&2; exit 4; }

echo "Read - Done"
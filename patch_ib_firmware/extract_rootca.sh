#!/usr/bin/env bash
# ==============================================================================
# Script: extract_rootca.sh
# Description: Extracts the embedded Root CA DER certificate from the firmware
#              at offset 0x59FF0 (length 639 bytes) and validates it via OpenSSL.
#
# Arguments:
#   $1 - Path to input firmware binary
#   $2 - Path to write the output extracted Root CA DER file
# ==============================================================================
set -euo pipefail

ROOT_OFFSET=$((0x00059FF0))
ROOT_LEN=639

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 <firmware.bin> <output_rootca.der>" >&2
  exit 1
fi

FW="$1"
OUT="$2"

[[ -f "$FW" ]] || { echo "Extract RootCA - ERROR: firmware not found: $FW" >&2; exit 2; }

FW_SIZE=$(wc -c < "$FW" | tr -d ' ')
if (( ROOT_OFFSET + ROOT_LEN > FW_SIZE )); then
  echo "Extract RootCA - ERROR: firmware too small to contain RootCA at 0x$(printf '%X' "$ROOT_OFFSET")" >&2
  exit 3
fi

dd if="$FW" of="$OUT" bs=1 skip="$ROOT_OFFSET" count="$ROOT_LEN" status=none

# Validate extracted bytes are a valid DER certificate
if ! openssl x509 -in "$OUT" -inform DER -noout 2>/dev/null; then
  echo "Extract RootCA - ERROR: extracted data at offset 0x$(printf '%X' "$ROOT_OFFSET") is not a valid DER certificate" >&2
  exit 4
fi

echo "Extract RootCA - RootCA extracted"
echo "    Offset : 0x$(printf '%X' "$ROOT_OFFSET")"
echo "    Length : $ROOT_LEN bytes"
echo "    Output : $OUT"

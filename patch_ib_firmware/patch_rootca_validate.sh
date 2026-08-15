#!/usr/bin/env bash
# ==============================================================================
# Script: patch_rootca_validate.sh
# Description: Patches the embedded root CA certificate inside the firmware
#              at offset 0x59FF0 (length 639 bytes) and verifies the patch
#              by comparing the SHA-256 hash of the written region against the source.
#
# Arguments:
#   $1 - Path to input firmware binary
#   $2 - Path to source certificate in DER format
#   $3 - Path to output patched firmware binary
# ==============================================================================
set -euo pipefail

CERT_OFFSET=$((0x00059FF0))
CERT_LEN=639

if [[ $# -ne 3 ]]; then
  echo "Usage: $0 <input_fw.bin> <cert.der> <output_fw.bin>" >&2
  exit 1
fi

IN_FW="$1"
CERT="$2"
OUT_FW="$3"

cp "$IN_FW" "$OUT_FW"

# ---- Patch certificate ----
dd if="$CERT" of="$OUT_FW" bs=1 seek="$CERT_OFFSET" count="$CERT_LEN" conv=notrunc status=none
echo "Patch RootCA - RootCA patched at 0x$(printf '%X' "$CERT_OFFSET")"

# ---- Validate patch ----
PATCH_SHA=$(dd if="$OUT_FW" bs=1 skip="$CERT_OFFSET" count="$CERT_LEN" status=none | sha256sum | awk '{print $1}')
CERT_SHA=$(sha256sum "$CERT" | awk '{print $1}')
if [[ "$PATCH_SHA" != "$CERT_SHA" ]]; then
  echo "Patch RootCA - ERROR: verification failed - embedded cert hash does not match source cert" >&2
  echo "  expected: $CERT_SHA" >&2
  echo "  got:      $PATCH_SHA" >&2
  exit 2
fi
echo "Patch RootCA - Verification passed (SHA-256 match)"

echo "Patch RootCA - Output firmware: $OUT_FW"
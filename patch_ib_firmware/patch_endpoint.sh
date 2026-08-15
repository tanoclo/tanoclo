#!/usr/bin/env bash
# ==============================================================================
# Script: patch_endpoint.sh
# Description: Replaces the hardcoded websocket endpoint URL string inside the
#              firmware binary with the selected custom destination endpoint.
#              Enforces that the destination string matches the exact 25-character
#              length requirements of the original 'ws://ingress.tado.com:443'.
#
# Arguments:
#   $1 - Path to input firmware binary
#   $2 - Path to output patched firmware binary
#   $3 - Endpoint selection type (1 for port 988, 2 for tanoclo, other for default)
# ==============================================================================
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "Usage: $0 <input.bin> <output.bin> <endpoint_type>" >&2
  exit 1
fi

in="$1"
out="$2"
endpoint_type="$3"
start_arg=367865
count=1

src='ws://ingress.tado.com:443'

if [ "$endpoint_type" == 1 ]; then
  dst='ws://ingress.tado.com:988'
elif [ "$endpoint_type" == 2 ]; then  
  dst='ws://tanoclo.tado.lan:988'
else
  dst='ws://ingress.tado.com:443'
fi

parse_num() {
  local s="$1"
  if [[ "$s" == 0x* || "$s" == 0X* ]]; then
    printf '%u' "$((16#${s:2}))"
  else
    printf '%u' "$s"
  fi
}

# Endpoint strings must be exactly 25 chars (26 bytes in firmware including NULL terminator)
REQUIRED_LEN=25
src_len=${#src}
dst_len=${#dst}
if [ "$src_len" -ne "$REQUIRED_LEN" ]; then
  echo "Patch endpoint - ERROR: source endpoint must be exactly $REQUIRED_LEN chars (got $src_len)" >&2
  exit 1
fi
if [ "$dst_len" -ne "$REQUIRED_LEN" ]; then
  echo "Patch endpoint - ERROR: destination endpoint must be exactly $REQUIRED_LEN chars (got $dst_len)" >&2
  exit 1
fi

file_size="$(wc -c < "$in" | tr -d ' ')"
start="$(parse_num "$start_arg")"

if [ "$start" -gt "$file_size" ]; then
  echo "Patch endpoint - ERROR: start_offset beyond EOF (start=$start size=$file_size)" >&2
  exit 1
fi

cp -- "$in" "$out"

# Verify a known endpoint string exists at expected offset before patching
existing=$(dd if="$in" bs=1 skip="$start_arg" count=${#src} status=none)
if [[ "$existing" != "$src" && "$existing" != 'ws://ingress.tado.com:443' && "$existing" != 'ws://ingress.tado.com:988' && "$existing" != 'ws://tanoclo.tado.lan:988' ]]; then
  echo "Patch endpoint - ERROR: expected a known endpoint at offset $start_arg but found '$existing'" >&2
  echo "Patch endpoint - This firmware version may have the endpoint at a different offset" >&2
  exit 1
fi

echo "Patch endpoint - Patching at offset $start_arg (0x$(printf '%x' "$start_arg"))"
printf '%s' "$dst" | dd of="$out" bs=1 seek="$start_arg" conv=notrunc status=none

tmp_verify="$(mktemp)"
trap 'rm -f "$tmp_verify"' EXIT
verify_len=$(( ${#dst} + 1 ))  # +1 for NULL terminator = 26 bytes
dd if="$out" of="$tmp_verify" bs=1 skip="$start_arg" count=$verify_len status=none

after_count="$(grep -aobU -- "$dst" "$tmp_verify" | wc -l | tr -d ' ')"
echo "Patch endpoint - After patch, occurrences of destination string in range: $after_count"

if [ "$after_count" -ne "$count" ]; then
  echo "Patch endpoint - ERROR: verification failed (expected $count occurrences of dst in range, got $after_count)" >&2
  exit 1
fi

echo "Patch endpoint - OK: patched binary written to $out"

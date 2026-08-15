#!/usr/bin/env bash
# ==============================================================================
# Script: patch_crc.sh
# Description: Computes and updates the 16-bit CRC-CCITT checksum over the active
#              internal firmware segment (384 KiB starting at offset 0x20000).
#              Injects the computed CRC into the active internal descriptor
#              (default location offset 0x8D04) to prevent bootloader check failures.
#
# Arguments:
#   $1 - Path to input unchecksummed firmware binary
#   $2 - Path to write the output checksummed firmware binary
# ==============================================================================
set -euo pipefail

IN="$1"
OUT="$2"

# Internal flash parameters
CRC_START=$((0x00020000))
CRC_LEN=$((0x00060000))   # 384 KiB
PATCH_OFF=$((0x00008D04)) # expected CRC halfword location (little-endian)

hex32() { printf "0x%08x" "$1"; }
hex16() { printf "0x%04x" "$1"; }

# --- helpers to read/write a 16-bit little-endian halfword at file offset ---
read_u16_le() {
  local file="$1" off="$2"
  dd if="$file" bs=1 skip="$off" count=2 2>/dev/null \
    | od -An -tx1 \
    | awk '{ b0=$1; b1=$2; if (b0==""||b1=="") { print "0xffff"; exit } printf "0x%s%s\n", b1, b0 }'
}

write_u16_le() {
  local file="$1" off="$2" value="$3"
  # value is 0..65535
  local lo=$(( value        & 0xFF ))
  local hi=$(( (value >> 8) & 0xFF ))
  local tmp
  tmp="$(mktemp)"
  # Create 2-byte file: LO, HI
  printf "%b" "$(printf '\\%03o\\%03o' "$lo" "$hi")" > "$tmp"
  dd if="$tmp" of="$file" bs=1 seek="$off" conv=notrunc status=none
  rm -f "$tmp"
}

# --- CRC16 core---
crc16_fw_core() {
  local file="$1" start="$2" len="$3"
  local end=$((start + len))

  # Stream bytes as decimals
  dd if="$file" bs=1 skip="$start" count="$len" 2>/dev/null \
  | od -An -tu1 -v \
  | awk '
    BEGIN {
      crc = 0xFFFF
      poly = 0x1020  # CRC-16-CCITT variant: 0x1021 decomposed as 0x1020 with XOR 1 on MSB set
    }
    {
      for (i=1; i<=NF; i++) {
        b = $i
        crc = bxor(crc, blshift(b, 8))
        for (k=0; k<8; k++) {
          if (band(crc, 0x8000) != 0) {
            crc = blshift(crc, 1)
            crc = bxor(crc, poly)
            crc = bxor(crc, 1)
          } else {
            crc = blshift(crc, 1)
          }
          crc = band(crc, 0xFFFF)
        }
      }
    }
    END { printf "0x%04x\n", band(crc, 0xFFFF) }

    # ---- bitwise helpers (portable awk) ----
    function band(a,b,   r,p,abit,bbit) {
      r=0; p=1
      while (a>0 || b>0) {
        abit = a % 2
        bbit = b % 2
        if (abit==1 && bbit==1) r += p
        a = int(a/2); b = int(b/2); p *= 2
      }
      return r
    }
    function bxor(a,b,   r,p,abit,bbit) {
      r=0; p=1
      while (a>0 || b>0) {
        abit = a % 2
        bbit = b % 2
        if ((abit==1 && bbit==0) || (abit==0 && bbit==1)) r += p
        a = int(a/2); b = int(b/2); p *= 2
      }
      return r
    }
    function blshift(a,n) { return a * (2^n) }
  '
}

# --- sanity checks ---
SIZE=$(wc -c < "$IN" | tr -d ' ')
REQ_MIN=$((CRC_START + CRC_LEN))
if (( SIZE < REQ_MIN )); then
  echo "Patch CRC - ERROR: input too small. size=$(hex32 "$SIZE") needs at least $(hex32 "$REQ_MIN")" >&2
  exit 1
fi
if (( PATCH_OFF + 2 > SIZE )); then
  echo "Patch CRC - ERROR: patch offset beyond EOF: PATCH_OFF=$(hex32 "$PATCH_OFF") size=$(hex32 "$SIZE")" >&2
  exit 1
fi

echo "== Patch CRC =="
echo "== Internal flash image =="
echo "  input : $IN"
echo "  output: $OUT"
echo "  crc_start = $(hex32 "$CRC_START")"
echo "  crc_len   = $(hex32 "$CRC_LEN")"
echo "  patch_off = $(hex32 "$PATCH_OFF")"

cp -f "$IN" "$OUT"

BEFORE=$(read_u16_le "$OUT" "$PATCH_OFF")
echo "  stored expected (before) = $BEFORE"

COMPUTED_HEX=$(crc16_fw_core "$OUT" "$CRC_START" "$CRC_LEN")
COMPUTED=$((COMPUTED_HEX))
echo "  computed CRC             = $(hex16 "$COMPUTED")"

write_u16_le "$OUT" "$PATCH_OFF" "$COMPUTED"

AFTER=$(read_u16_le "$OUT" "$PATCH_OFF")
echo "  stored expected (after)  = $AFTER"

if (( (AFTER) != COMPUTED )); then
  echo "Patch CRC - ERROR: patch write failed (expected $(hex16 "$COMPUTED"), read back $AFTER)" >&2
  exit 3
fi

echo "Patch CRC - OK: patched internal image -> $OUT"

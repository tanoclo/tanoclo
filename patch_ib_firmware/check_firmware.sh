#!/usr/bin/env bash
# ==============================================================================
# Script: check_firmware.sh
# Description: Checks internal flash firmware version. If it is already 92.1,
#              verifies active descriptor offset. If not 92.1, scans SPI flash
#              active descriptor table to locate version 92.1 in Slot A or B,
#              extracts the 384 KiB firmware image, overwrites the internal slot,
#              and commits a new active internal descriptor at 0x8D00.
#
# Arguments:
#   $1 - Path to internal flash binary image
#   $2 - Path to SPI external flash binary image
# ==============================================================================
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 <internal_fw.bin> <spi_fw.bin>" >&2
  exit 1
fi

internal_fw="$1"
spi_fw="$2"

# 1. Scan internal descriptor table at 0x8000-0xC000 step 0x100 (256 bytes)
# Reads sequence number to identify the latest active firmware record.
max_seq=0
active_offset=0
for ((off=32768; off<49152; off+=256)); do
  seq_hex=$(dd if="$internal_fw" bs=1 skip="$off" count=4 2>/dev/null | od -An -tx4 | tr -d '[:space:]')
  if [[ -z "$seq_hex" || "$seq_hex" == "ffffffff" ]]; then
    continue
  fi
  seq=$(( 16#$seq_hex ))
  if (( seq > max_seq )); then
    max_seq=$seq
    active_offset=$off
  fi
done

running_ver=""
running_magic=""
if (( max_seq > 0 )); then
  running_magic=$(dd if="$internal_fw" bs=1 skip=$((active_offset + 4)) count=2 2>/dev/null | od -An -tx2 | tr -d '[:space:]')
  running_ver=$(dd if="$internal_fw" bs=1 skip=$((active_offset + 6)) count=2 2>/dev/null | od -An -tx2 | tr -d '[:space:]')
fi

echo "Internal: active_offset=0x$(printf '%X' $active_offset), seq=$max_seq, version_hex=$running_ver, magic_hex=$running_magic"

# Check if running version is 92.1 (which is 1701 in hex)
if [[ "$running_ver" == "1701" ]]; then
  echo "Running firmware version is already 92.1 (OK)."
  
  if [[ "$active_offset" -eq 36096 ]]; then
    echo "Active descriptor is already at 0x8D00. No write needed."
    exit 0
  fi
  
  # Write new descriptor at 0x8D00 to ensure patch_crc.sh behaves correctly
  new_seq=$(( max_seq + 1 ))
  b0=$(( new_seq & 0xFF ))
  b1=$(( (new_seq >> 8) & 0xFF ))
  b2=$(( (new_seq >> 16) & 0xFF ))
  b3=$(( (new_seq >> 24) & 0xFF ))
  
  m_lo=$(( 16#${running_magic:2:2} ))
  m_hi=$(( 16#${running_magic:0:2} ))
  
  v_lo=$(( 16#01 ))
  v_hi=$(( 16#17 ))
  
  tmp_desc=$(mktemp)
  printf "\\$(printf '%03o' $b0)\\$(printf '%03o' $b1)\\$(printf '%03o' $b2)\\$(printf '%03o' $b3)\\$(printf '%03o' $m_lo)\\$(printf '%03o' $m_hi)\\$(printf '%03o' $v_lo)\\$(printf '%03o' $v_hi)\\000\\000\\000\\000\\000\\000\\000\\000" > "$tmp_desc"
  
  dd if="$tmp_desc" of="$internal_fw" bs=1 seek=$((0x8D00)) conv=notrunc status=none
  rm -f "$tmp_desc"
  echo "Wrote descriptor at 0x8D00: seq=$new_seq, version=92.1, magic=$running_magic"
  exit 0
fi

echo "Running version is NOT 92.1. Checking SPI flash..."

# 2. Check SPI flash
# Scans SPI descriptor table at 0x100000 - 0x104000 (1048576 to 1064960 bytes)
if [[ ! -f "$spi_fw" ]]; then
  echo "ERROR: SPI flash file not found: $spi_fw" >&2
  exit 1
fi

max_spi_seq=0
active_spi_offset=0
for ((off=1048576; off<1064960; off+=256)); do
  seq_hex=$(dd if="$spi_fw" bs=1 skip="$off" count=4 2>/dev/null | od -An -tx4 | tr -d '[:space:]')
  if [[ -z "$seq_hex" || "$seq_hex" == "ffffffff" ]]; then
    continue
  fi
  seq=$(( 16#$seq_hex ))
  if (( seq > max_spi_seq )); then
    max_spi_seq=$seq
    active_spi_offset=$off
  fi
done

if (( max_spi_seq == 0 )); then
  echo "ERROR: No active SPI descriptor found." >&2
  exit 1
fi

# Decodes magic bytes and version for both Slot A and Slot B
# SPI active descriptor contains offsets:
#   offset+4: Slot A magic, offset+6: Slot A version
#   offset+8: Slot B magic, offset+10: Slot B version
slotA_magic=$(dd if="$spi_fw" bs=1 skip=$((active_spi_offset + 4)) count=2 2>/dev/null | od -An -tx2 | tr -d '[:space:]')
slotA_ver=$(dd if="$spi_fw" bs=1 skip=$((active_spi_offset + 6)) count=2 2>/dev/null | od -An -tx2 | tr -d '[:space:]')
slotB_magic=$(dd if="$spi_fw" bs=1 skip=$((active_spi_offset + 8)) count=2 2>/dev/null | od -An -tx2 | tr -d '[:space:]')
slotB_ver=$(dd if="$spi_fw" bs=1 skip=$((active_spi_offset + 10)) count=2 2>/dev/null | od -An -tx2 | tr -d '[:space:]')

echo "SPI Active Descriptor: Slot A ver=$slotA_ver magic=$slotA_magic, Slot B ver=$slotB_ver magic=$slotB_magic"

target_slot=""
target_magic=""

# Checks if version is 92.1 (hex 1701) in Slot A or Slot B
if [[ "$slotA_ver" == "1701" ]]; then
  target_slot="A"
  target_magic="$slotA_magic"
elif [[ "$slotB_ver" == "1701" ]]; then
  target_slot="B"
  target_magic="$slotB_magic"
else
  echo "ERROR: Version 92.1 not found in SPI Slot A or Slot B." >&2
  exit 1
fi

echo "Found 92.1 in SPI Slot $target_slot. Extracting..."

# Extract 384 KiB and overwrite internal firmware slot (at seek=128 in internal_fw)
# Slot A starts at 128 KiB, Slot B starts at 512 KiB.
if [[ "$target_slot" == "A" ]]; then
  dd if="$spi_fw" of="$internal_fw" bs=1k skip=128 seek=128 count=384 conv=notrunc status=none
else
  dd if="$spi_fw" of="$internal_fw" bs=1k skip=512 seek=128 count=384 conv=notrunc status=none
fi

# Write new internal descriptor at 0x8D00 to set sequence ID active
new_seq=$(( max_seq + 1 ))
b0=$(( new_seq & 0xFF ))
b1=$(( (new_seq >> 8) & 0xFF ))
b2=$(( (new_seq >> 16) & 0xFF ))
b3=$(( (new_seq >> 24) & 0xFF ))

m_lo=$(( 16#${target_magic:2:2} ))
m_hi=$(( 16#${target_magic:0:2} ))

v_lo=$(( 16#01 ))
v_hi=$(( 16#17 ))

tmp_desc=$(mktemp)
printf "\\$(printf '%03o' $b0)\\$(printf '%03o' $b1)\\$(printf '%03o' $b2)\\$(printf '%03o' $b3)\\$(printf '%03o' $m_lo)\\$(printf '%03o' $m_hi)\\$(printf '%03o' $v_lo)\\$(printf '%03o' $v_hi)\\000\\000\\000\\000\\000\\000\\000\\000" > "$tmp_desc"

dd if="$tmp_desc" of="$internal_fw" bs=1 seek=$((0x8D00)) conv=notrunc status=none
rm -f "$tmp_desc"

echo "Success: Extracted 92.1 from SPI Slot $target_slot and wrote internal descriptor at 0x8D00 (seq=$new_seq, magic=$target_magic)."
exit 0

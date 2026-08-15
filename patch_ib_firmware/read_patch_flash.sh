#!/usr/bin/env bash
set -euo pipefail

unmodded_internal="unmodded.bin"
unmodded_spi="unmodded_spi.bin"
overwrite_both_spi_slots=1
endpoint_type=2

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

# Parse command line options
flash_internal=0
flash_spi_a=0
flash_spi_b=0
no_flash=0
reuse_certs=0
revert=0
explicit_slots=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --flash-internal)
      flash_internal=1
      explicit_slots=1
      shift
      ;;
    --flash-spi-a)
      flash_spi_a=1
      explicit_slots=1
      shift
      ;;
    --flash-spi-b)
      flash_spi_b=1
      explicit_slots=1
      shift
      ;;
    --no-flash)
      no_flash=1
      explicit_slots=1
      shift
      ;;
    --reuse-certs)
      reuse_certs=1
      shift
      ;;
    --revert)
      revert=1
      shift
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

echo "Read Patch Flash - Removing old files"
# Keep unmodded.bin and unmodded_spi.bin in root directory if they exist (allows patching to proceed even if ST-Link is offline)
rm -f IB-*.bin
if [[ "$reuse_certs" -eq 0 ]]; then
  rm -f *.key
  rm -f *.pem
  rm -f *.cer
  rm -f *.der
fi

if [[ -d out ]]; then
  mkdir -p out_old
  cp -rf out/* out_old/ 2>/dev/null || true
  rm -rf out
fi
echo "Read Patch Flash - Done removing old files"

if [[ "$reuse_certs" -eq 1 ]]; then
  if ! [[ -d out_old ]]; then
    echo "ERROR: --reuse-certs specified but out_old directory does not exist." >&2
    exit 1
  fi
  echo "Read Patch Flash - Reusing existing certificates from out_old"
  mkdir -p out
  cp -f out_old/*.pem out/ 2>/dev/null || true
  cp -f out_old/*.key out/ 2>/dev/null || true
  cp -f out_old/*.cer out/ 2>/dev/null || true
  cp -f out_old/*.der out/ 2>/dev/null || true
  # Copy to root directory so that patching scripts can locate/use them
  cp -f out/*.pem . 2>/dev/null || true
  cp -f out/*.key . 2>/dev/null || true
  cp -f out/*.cer . 2>/dev/null || true
  cp -f out/*.der . 2>/dev/null || true
fi

echo "Read Patch Flash - Dumping flash"
if ! ./read.sh; then
  if [[ ! -f "$unmodded_internal" && -f "out_old/$unmodded_internal" ]]; then
    cp -f "out_old/$unmodded_internal" . 2>/dev/null || true
  fi
  if [[ ! -f "$unmodded_spi" && -f "out_old/$unmodded_spi" ]]; then
    cp -f "out_old/$unmodded_spi" . 2>/dev/null || true
  fi
  if [[ -f "$unmodded_internal" && -f "$unmodded_spi" ]]; then
    echo "WARNING: Flash dumping failed. Using existing unmodded.bin and unmodded_spi.bin as fallback." >&2
  else
    echo "ERROR: Flash dumping process failed and no local fallback binaries were found." >&2
    exit 3
  fi
fi
echo "Read Patch Flash - Done dumping/verifying raw binaries"

# Save timestamped copies of raw dumps to original directory
mkdir -p original
timestamp=$(date +"%Y%m%d_%H%M%S")
if [[ -f "$unmodded_internal" ]]; then
  cp -f "$unmodded_internal" "original/dump_internal_$timestamp.bin"
  echo "Read Patch Flash - Saved timestamped internal dump: dump_internal_$timestamp.bin"
fi
if [[ -f "$unmodded_spi" ]]; then
  cp -f "$unmodded_spi" "original/dump_spi_$timestamp.bin"
  echo "Read Patch Flash - Saved timestamped SPI dump: dump_spi_$timestamp.bin"
fi

if [[ "$revert" -eq 1 ]]; then
  echo "Read Patch Flash - Revert mode selected. Restoring original factory firmware..."
  
  orig_internal_path="original/$unmodded_internal"
  orig_spi_path="original/$unmodded_spi"
  
  if ! [[ -f "$orig_internal_path" ]] || ! [[ -f "$orig_spi_path" ]]; then
    echo "ERROR: Cannot revert. Backup files '$orig_internal_path' and/or '$orig_spi_path' do not exist." >&2
    exit 1
  fi
  
  write_internal="$flash_internal"
  write_spi_a="$flash_spi_a"
  write_spi_b="$flash_spi_b"
  skip_flash="$no_flash"
  
  if [[ "$explicit_slots" -eq 0 ]]; then
    write_internal=1
    write_spi_a=1
    write_spi_b=1
  fi
  
  mkdir -p out
  cp -f "$orig_internal_path" "out/IB-patched-ca-endpoint-crc.bin"
  cp -f "$orig_spi_path" "out/IB-SPI-patched-ca-endpoint.bin"
  
  # Preserve unmodded fallback binaries
  cp -f "$orig_internal_path" "out/$unmodded_internal"
  cp -f "$orig_spi_path" "out/$unmodded_spi"
  
  # Preserve existing certificates from out_old or root directory
  if [[ -d out_old ]]; then
    cp -f out_old/*.pem out/ 2>/dev/null || true
    cp -f out_old/*.key out/ 2>/dev/null || true
    cp -f out_old/*.cer out/ 2>/dev/null || true
    cp -f out_old/*.der out/ 2>/dev/null || true
  fi
  cp -f *.pem out/ 2>/dev/null || true
  cp -f *.key out/ 2>/dev/null || true
  cp -f *.cer out/ 2>/dev/null || true
  cp -f *.der out/ 2>/dev/null || true
  
  if [[ "$skip_flash" -eq 0 ]]; then
    echo "Read Patch Flash - Flashing original factory binaries"
    flash_spi=0
    if [[ "$write_spi_a" -eq 1 ]] || [[ "$write_spi_b" -eq 1 ]]; then
      flash_spi=1
    fi
    ./flash.sh "$write_internal" "$flash_spi"
    echo "Read Patch Flash - Done flashing original factory binaries"
  else
    echo "Read Patch Flash - Skipping flashing step (flash nothing selected)"
  fi
  
  echo "Read Patch Flash - Revert process completed successfully."
  exit 0
fi

echo "Read Patch Flash - Checking firmware version..."
bash check_firmware.sh "$unmodded_internal" "$unmodded_spi"
echo "Read Patch Flash - Done checking firmware version"

write_internal=0
write_spi_a=0
write_spi_b=0
skip_flash=0

if [[ "$no_flash" -eq 1 ]]; then
  skip_flash=1
  # Still patch based on overwrite_both_spi_slots so files are generated correctly
  write_spi_a="$overwrite_both_spi_slots"
  write_spi_b="$overwrite_both_spi_slots"
fi

if [[ "$explicit_slots" -eq 0 ]]; then
  write_internal=1
  if [[ "$overwrite_both_spi_slots" -eq 1 ]]; then
    write_spi_a=1
    write_spi_b=1
  else
    tmp1=$(mktemp)
    tmp2=$(mktemp)
    tmp3=$(mktemp)
    trap 'rm -f "$tmp1" "$tmp2" "$tmp3"' EXIT

    dd if="$unmodded_internal" of="$tmp1" bs=1k skip=128 count=384 status=none
    dd if="$unmodded_spi" of="$tmp2" bs=1k skip=128 count=384 status=none
    dd if="$unmodded_spi" of="$tmp3" bs=1k skip=512 count=384 status=none

    if cmp "$tmp1" "$tmp2"; then
      echo "Read Patch Flash - Matching SPI slot found, selecting slot A"
      write_spi_a=1
    elif cmp "$tmp1" "$tmp3"; then
      echo "Read Patch Flash - Matching SPI slot found, selecting slot B"
      write_spi_b=1
    else
      echo "Read Patch Flash - No matching SPI slot found, defaulting to slot B"
      write_spi_b=1
    fi
  fi
elif [[ "$no_flash" -eq 0 ]]; then
  write_internal="$flash_internal"
  write_spi_a="$flash_spi_a"
  write_spi_b="$flash_spi_b"
fi

spi_slot=0
if [[ "$write_spi_a" -eq 1 ]] && [[ "$write_spi_b" -eq 1 ]]; then
  spi_slot=3
elif [[ "$write_spi_a" -eq 1 ]]; then
  spi_slot=1
elif [[ "$write_spi_b" -eq 1 ]]; then
  spi_slot=2
fi

echo "Read Patch Flash - Patching files"
./patch.sh "$spi_slot" "$endpoint_type" "$reuse_certs"

patched_internal="IB-patched-ca-endpoint-crc.bin"
patched_spi="IB-SPI-patched-ca-endpoint.bin"

if ! [ -f "$patched_internal" ]; then
  echo "Read Patch Flash - ERROR: Patched internal binary '$patched_internal' was not generated." >&2
  exit 2
fi
internal_size=$(stat -c %s "$patched_internal" 2>/dev/null || stat -f %z "$patched_internal")
if [ "$internal_size" -ne 524288 ]; then
  echo "Read Patch Flash - ERROR: Patched internal binary size is $internal_size bytes (expected 524288)." >&2
  exit 2
fi

if [ "$spi_slot" -ne 0 ]; then
  if ! [ -f "$patched_spi" ]; then
    echo "Read Patch Flash - ERROR: Patched SPI binary '$patched_spi' was not generated." >&2
    exit 2
  fi
  spi_size=$(stat -c %s "$patched_spi" 2>/dev/null || stat -f %z "$patched_spi")
  if [ "$spi_size" -ne 2097152 ]; then
    echo "Read Patch Flash - ERROR: Patched SPI binary size is $spi_size bytes (expected 2097152)." >&2
    exit 2
  fi
fi

echo "Read Patch Flash - Done patching files (All files validated)"

echo "Read Patch Flash - Moving files to out directory"
mkdir -p out
mv -f *.pem out/ 2>/dev/null || true
mv -f *.key out/ 2>/dev/null || true
mv -f *.cer out/ 2>/dev/null || true
mv -f *.der out/ 2>/dev/null || true
mv -f *.bin out/ 2>/dev/null || true
echo "Read Patch Flash - Done moving files to out directory"

# Fill original directory if the extracted RootCA matches the original hardcoded SHA256
original_root_ca_sha="1cd811ecdbdd2f127b4d67c57e9a191f46a53c70193af9c933bc9a24f379b23f"
extracted_ca_cer="out/tadoRootCA.cer"

if [[ -f "$extracted_ca_cer" ]]; then
  cer_hash=$(sha256sum "$extracted_ca_cer" | awk '{print $1}' | tr -d ' ' | tr 'A-Z' 'a-z')
  if [[ "$cer_hash" == "$original_root_ca_sha" ]]; then
    echo "Read Patch Flash - Extracted RootCA matches original Tado RootCA. Writing true unmodded backups to original directory."
    mkdir -p original
    cp -f "out/tadoRootCA.cer" "original/tadoRootCA.cer"
    cp -f "out/tadoRootCA.der" "original/tadoRootCA.der"
    cp -f "out/$unmodded_internal" "original/$unmodded_internal"
    cp -f "out/$unmodded_spi" "original/$unmodded_spi"
  else
    echo "Read Patch Flash - Extracted RootCA ($cer_hash) does not match original Tado RootCA. Skipping original directory true backup."
  fi
fi

if [[ "$skip_flash" -eq 0 ]]; then
  echo "Read Patch Flash - Flashing modded binaries"
  # Compute combined SPI flash choice for flash.sh
  flash_spi=0
  if [[ "$write_spi_a" -eq 1 ]] || [[ "$write_spi_b" -eq 1 ]]; then
    flash_spi=1
  fi
  ./flash.sh "$write_internal" "$flash_spi"
  echo "Read Patch Flash - Done flashing modded binaries"
else
  echo "Read Patch Flash - Skipping flashing step (flash nothing selected)"
fi

echo "Read Patch Flash - Copy the generated certificates to the ws-server/certs directory:"
echo "  cp original/tadoRootCA.cer ../ws-server/certs/tadoRootCA.cer"
echo "  cp out/tanoclo_key.pem ../ws-server/certs/tanoclo_key.pem"
echo "  cp out/tanoclo_cert.pem ../ws-server/certs/tanoclo_cert.pem"
echo "Read Patch Flash - Then restart the TaNoClo Docker container to load the new certificates."

if [ "$endpoint_type" != 0 ]; then
  echo "Read Patch Flash - The IB will connect to port 988. Ensure your DNS resolves the target domain to your server."
else
  echo "Read Patch Flash - The IB will connect to port 443. Ensure your DNS resolves the target domain to your server."
fi

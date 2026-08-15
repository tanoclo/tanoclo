# check_firmware.ps1
# Scan internal firmware descriptor table and check versions

if ($args.Count -ne 2) {
    throw "Usage: check_firmware.ps1 <internal_fw.bin> <spi_fw.bin>"
}

$internalFw = Resolve-Path $args[0]
$spiFw = Resolve-Path $args[1]

# 1. Scan internal descriptor table at 0x8000-0xC000 step 0x100 (256)
$internalBytes = [System.IO.File]::ReadAllBytes($internalFw)

$maxSeq = 0
$activeOffset = 0
for ($off = 32768; $off -lt 49152; $off += 256) {
    if ($off + 4 -gt $internalBytes.Length) { continue }
    $seq = [System.BitConverter]::ToUInt32($internalBytes, $off)
    if ($seq -eq [uint32]::MaxValue) {
        continue
    }
    if ($seq -gt $maxSeq) {
        $maxSeq = $seq
        $activeOffset = $off
    }
}

$runningVer = ""
$runningMagic = ""
if ($maxSeq -gt 0) {
    $runningMagicByte0 = $internalBytes[$activeOffset + 4]
    $runningMagicByte1 = $internalBytes[$activeOffset + 5]
    $runningMagic = "{0:x2}{1:x2}" -f $runningMagicByte1, $runningMagicByte0

    $runningVerByte0 = $internalBytes[$activeOffset + 6]
    $runningVerByte1 = $internalBytes[$activeOffset + 7]
    $runningVer = "{0:x2}{1:x2}" -f $runningVerByte1, $runningVerByte0
}

Write-Host "Internal: active_offset=0x$($activeOffset.ToString('X')), seq=$maxSeq, version_hex=$runningVer, magic_hex=$runningMagic"

# Check if running version is 92.1 (which is 1701 in hex)
if ($runningVer -eq "1701") {
    Write-Host "Running firmware version is already 92.1 (OK)."
    
    if ($activeOffset -eq 36096) {
        Write-Host "Active descriptor is already at 0x8D00. No write needed."
        exit 0
    }
    
    # Write new descriptor at 0x8D00 to ensure patch_crc.sh/patch_crc.ps1 behaves correctly
    $newSeq = $maxSeq + 1
    $descBytes = New-Object byte[] 16
    
    # Seq (UInt32)
    $seqBytes = [System.BitConverter]::GetBytes([UInt32]$newSeq)
    [System.Array]::Copy($seqBytes, 0, $descBytes, 0, 4)
    
    # Magic (UInt16)
    $descBytes[4] = [System.Convert]::ToByte($runningMagic.Substring(2, 2), 16)
    $descBytes[5] = [System.Convert]::ToByte($runningMagic.Substring(0, 2), 16)
    
    # Version (UInt16) for 92.1 (which is 1701, written as little endian: 01, 17)
    $descBytes[6] = 0x01
    $descBytes[7] = 0x17
    
    # Write to internal_fw at 0x8D00
    [System.Array]::Copy($descBytes, 0, $internalBytes, 0x8D00, 16)
    [System.IO.File]::WriteAllBytes($internalFw, $internalBytes)
    
    Write-Host "Wrote descriptor at 0x8D00: seq=$newSeq, version=92.1, magic=$runningMagic"
    exit 0
}

Write-Host "Running version is NOT 92.1. Checking SPI flash..."

# 2. Check SPI flash
if (-not (Test-Path $spiFw)) {
    throw "ERROR: SPI flash file not found: $spiFw"
}

$spiBytes = [System.IO.File]::ReadAllBytes($spiFw)
$maxSpiSeq = 0
$activeSpiOffset = 0
for ($off = 1048576; $off -lt 1064960; $off += 256) {
    if ($off + 4 -gt $spiBytes.Length) { continue }
    $seq = [System.BitConverter]::ToUInt32($spiBytes, $off)
    if ($seq -eq [uint32]::MaxValue) {
        continue
    }
    if ($seq -gt $maxSpiSeq) {
        $maxSpiSeq = $seq
        $activeSpiOffset = $off
    }
}

if ($maxSpiSeq -eq 0) {
    throw "ERROR: No active SPI descriptor found."
}

$slotAMagic = "{0:x2}{1:x2}" -f $spiBytes[$activeSpiOffset + 5], $spiBytes[$activeSpiOffset + 4]
$slotAVer   = "{0:x2}{1:x2}" -f $spiBytes[$activeSpiOffset + 7], $spiBytes[$activeSpiOffset + 6]
$slotBMagic = "{0:x2}{1:x2}" -f $spiBytes[$activeSpiOffset + 9], $spiBytes[$activeSpiOffset + 8]
$slotBVer   = "{0:x2}{1:x2}" -f $spiBytes[$activeSpiOffset + 11], $spiBytes[$activeSpiOffset + 10]

Write-Host "SPI Active Descriptor: Slot A ver=$slotAVer magic=$slotAMagic, Slot B ver=$slotBVer magic=$slotBMagic"

$targetSlot = ""
$targetMagic = ""

if ($slotAVer -eq "1701") {
    $targetSlot = "A"
    $targetMagic = $slotAMagic
} elseif ($slotBVer -eq "1701") {
    $targetSlot = "B"
    $targetMagic = $slotBMagic
} else {
    throw "ERROR: Version 92.1 not found in SPI Slot A or Slot B."
}

Write-Host "Found 92.1 in SPI Slot $targetSlot. Extracting..."

# Extract 384 KiB (393216 bytes) and overwrite internal fw slot (at seek=128k = 131072 in internal_fw)
$extractSize = 384 * 1024
$spiSkip = 0
if ($targetSlot -eq "A") {
    $spiSkip = 128 * 1024
} else {
    $spiSkip = 512 * 1024
}

[System.Array]::Copy($spiBytes, $spiSkip, $internalBytes, 128 * 1024, $extractSize)

# Write new internal descriptor at 0x8D00
$newSeq = $maxSeq + 1
$descBytes = New-Object byte[] 16

$seqBytes = [System.BitConverter]::GetBytes([UInt32]$newSeq)
[System.Array]::Copy($seqBytes, 0, $descBytes, 0, 4)

$descBytes[4] = [System.Convert]::ToByte($targetMagic.Substring(2, 2), 16)
$descBytes[5] = [System.Convert]::ToByte($targetMagic.Substring(0, 2), 16)
$descBytes[6] = 0x01
$descBytes[7] = 0x17

[System.Array]::Copy($descBytes, 0, $internalBytes, 0x8D00, 16)
[System.IO.File]::WriteAllBytes($internalFw, $internalBytes)

Write-Host "Success: Extracted 92.1 from SPI Slot $targetSlot and wrote internal descriptor at 0x8D00 (seq=$newSeq, magic=$targetMagic)."
exit 0

# patch_crc.ps1
# Recomputes STM32 firmware header checksum

if ($args.Count -ne 2) {
    Write-Error "Usage: patch_crc.ps1 <input.bin> <output.bin>"
    exit 1
}

$in = Resolve-Path $args[0]
$out = $args[1]

$crcStart = 0x00020000
$crcLen = 0x00060000
$patchOff = 0x00008D04

$bytes = [System.IO.File]::ReadAllBytes($in)
if ($bytes.Length -lt ($crcStart + $crcLen)) {
    Write-Error "Patch CRC - ERROR: input too small. size=0x$($bytes.Length.ToString('X')) needs at least 0x$(($crcStart + $crcLen).ToString('X'))"
    exit 1
}
if ($patchOff + 2 -gt $bytes.Length) {
    Write-Error "Patch CRC - ERROR: patch offset beyond EOF: patchOff=0x$($patchOff.ToString('X')) size=0x$($bytes.Length.ToString('X'))"
    exit 1
}

Write-Host "== Patch CRC =="
Write-Host "== Internal flash image =="
Write-Host "  input : $in"
Write-Host "  output: $out"
Write-Host "  crc_start = 0x$($crcStart.ToString('X8'))"
Write-Host "  crc_len   = 0x$($crcLen.ToString('X8'))"
Write-Host "  patch_off = 0x$($patchOff.ToString('X8'))"

# Read before
$before = [System.BitConverter]::ToUInt16($bytes, $patchOff)
Write-Host "  stored expected (before) = 0x$($before.ToString('x4'))"

# Compute CRC
$crc = 0xFFFF
$poly = 0x1020
$end = $crcStart + $crcLen

for ($i = $crcStart; $i -lt $end; $i++) {
    $b = $bytes[$i]
    $crc = $crc -bxor ($b -shl 8)
    for ($k = 0; $k -lt 8; $k++) {
        if (($crc -band 0x8000) -ne 0) {
            $crc = (($crc -shl 1) -bxor $poly -bxor 1) -band 0xFFFF
        } else {
            $crc = ($crc -shl 1) -band 0xFFFF
        }
    }
}

Write-Host "  computed CRC             = 0x$($crc.ToString('x4'))"

# Modify bytes and save to output
$outBytes = [byte[]]$bytes.Clone()
$outBytes[$patchOff] = [byte]($crc -band 0xFF)
$outBytes[$patchOff + 1] = [byte](($crc -shr 8) -band 0xFF)

[System.IO.File]::WriteAllBytes($out, $outBytes)

# Verify
$afterBytes = [System.IO.File]::ReadAllBytes($out)
$after = [System.BitConverter]::ToUInt16($afterBytes, $patchOff)
Write-Host "  stored expected (after)  = 0x$($after.ToString('x4'))"

if ($after -ne $crc) {
    Write-Error "Patch CRC - ERROR: patch write failed (expected 0x$($crc.ToString('x4')), read back 0x$($after.ToString('x4')))"
    exit 3
}

Write-Host "Patch CRC - OK: patched internal image -> $out"

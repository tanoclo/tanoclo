# patch_endpoint.ps1
# Rewrites the WebSocket endpoint strings in the firmware

if ($args.Count -ne 3) {
    Write-Error "Usage: patch_endpoint.ps1 <input.bin> <output.bin> <endpoint_type>"
    exit 1
}

$in = Resolve-Path $args[0]
$out = $args[1]
if (-not [System.IO.Path]::IsPathRooted($out)) {
    $out = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) $out
}
$endpointType = $args[2]
$startArg = 367865
$count = 1

$src = "ws://ingress.tado.com:443"

if ($endpointType -eq 1) {
    $dst = "ws://ingress.tado.com:988"
}
elseif ($endpointType -eq 2) {
    $dst = "ws://tanoclo.tado.lan:988"
}
else {
    $dst = "ws://ingress.tado.com:443"
}

# Endpoint strings must be exactly 25 chars (26 bytes including null terminator)
$requiredLen = 25
if ($src.Length -ne $requiredLen) {
    Write-Error "Patch endpoint - ERROR: source endpoint must be exactly $requiredLen chars (got $($src.Length))"
    exit 1
}
if ($dst.Length -ne $requiredLen) {
    Write-Error "Patch endpoint - ERROR: destination endpoint must be exactly $requiredLen chars (got $($dst.Length))"
    exit 1
}

$inBytes = [System.IO.File]::ReadAllBytes($in)
if ($startArg -gt $inBytes.Length) {
    Write-Error "Patch endpoint - ERROR: start_offset beyond EOF (start=$startArg size=$($inBytes.Length))"
    exit 1
}

# Verify a known endpoint string exists at expected offset before patching
$existingBytes = New-Object byte[] $src.Length
[System.Array]::Copy($inBytes, $startArg, $existingBytes, 0, $src.Length)
$existing = [System.Text.Encoding]::ASCII.GetString($existingBytes)

if ($existing -ne $src -and $existing -ne "ws://ingress.tado.com:443" -and $existing -ne "ws://ingress.tado.com:988" -and $existing -ne "ws://tanoclo.tado.lan:988") {
    Write-Error "Patch endpoint - ERROR: expected a known endpoint at offset $startArg but found '$existing'"
    Write-Error "Patch endpoint - This firmware version may have the endpoint at a different offset"
    exit 1
}

Write-Host "Patch endpoint - Patching at offset $startArg (0x$($startArg.ToString('X')))"

$outBytes = [byte[]]$inBytes.Clone()
$dstBytes = [System.Text.Encoding]::ASCII.GetBytes($dst)
[System.Array]::Copy($dstBytes, 0, $outBytes, $startArg, $dst.Length)

[System.IO.File]::WriteAllBytes($out, $outBytes)

# Verify count of occurrences of $dst in the range of patched bytes (+1 for NULL terminator = 26 bytes)
$verifyLen = $requiredLen + 1
$verifyBytes = New-Object byte[] $verifyLen
[System.Array]::Copy($outBytes, $startArg, $verifyBytes, 0, $verifyLen)
$verifyStr = [System.Text.Encoding]::ASCII.GetString($verifyBytes)

# Check occurrences
$occurrences = 0
$index = $verifyStr.IndexOf($dst)
while ($index -ne -1) {
    $occurrences++
    $index = $verifyStr.IndexOf($dst, $index + $dst.Length)
}

Write-Host "Patch endpoint - After patch, occurrences of destination string in range: $occurrences"

if ($occurrences -ne $count) {
    Write-Error "Patch endpoint - ERROR: verification failed (expected $count occurrences of dst in range, got $occurrences)"
    exit 1
}

Write-Host "Patch endpoint - OK: patched binary written to $out"

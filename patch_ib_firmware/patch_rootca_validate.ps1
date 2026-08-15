# patch_rootca_validate.ps1
# Overwrites Root CA in the firmware and checks SHA-256 hashes

$certOffset = 0x00059FF0
$certLen = 639

if ($args.Count -ne 3) {
    Write-Error "Usage: patch_rootca_validate.ps1 <input_fw.bin> <cert.der> <output_fw.bin>"
    exit 1
}

$inFw = Resolve-Path $args[0]
$cert = Resolve-Path $args[1]
$outFw = $args[2]

$fwBytes = [System.IO.File]::ReadAllBytes($inFw)
$certBytes = [System.IO.File]::ReadAllBytes($cert)

if ($certBytes.Length -ne $certLen) {
    Write-Error "Patch RootCA - ERROR: cert must be exactly $certLen bytes (got $($certBytes.Length))"
    exit 1
}

$outBytes = [byte[]]$fwBytes.Clone()
[System.Array]::Copy($certBytes, 0, $outBytes, $certOffset, $certLen)

[System.IO.File]::WriteAllBytes($outFw, $outBytes)
Write-Host "Patch RootCA - RootCA patched at 0x$($certOffset.ToString('X'))"

# Validate
$sha256 = [System.Security.Cryptography.SHA256]::Create()

$embeddedBytes = New-Object byte[] $certLen
[System.Array]::Copy($outBytes, $certOffset, $embeddedBytes, 0, $certLen)

$patchSha = [System.BitConverter]::ToString($sha256.ComputeHash($embeddedBytes)).Replace("-", "").ToLower()
$certSha = [System.BitConverter]::ToString($sha256.ComputeHash($certBytes)).Replace("-", "").ToLower()

if ($patchSha -ne $certSha) {
    Write-Error "Patch RootCA - ERROR: verification failed - embedded cert hash does not match source cert"
    Write-Error "  expected: $certSha"
    Write-Error "  got:      $patchSha"
    exit 2
}

Write-Host "Patch RootCA - Verification passed (SHA-256 match)"
Write-Host "Patch RootCA - Output firmware: $outFw"

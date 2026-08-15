# extract_rootca.ps1
# Extract embedded RootCA DER

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $scriptDir "utils.ps1")
Install-RequiredCommand "openssl" "ShiningLight.OpenSSL.Light"

$rootOffset = 0x00059FF0
$rootLen = 639

if ($args.Count -ne 2) {
    Write-Error "Usage: extract_rootca.ps1 <firmware.bin> <output_rootca.der>"
    exit 1
}

$fw = Resolve-Path $args[0]
$out = $args[1]

if (-not (Test-Path $fw)) {
    Write-Error "Extract RootCA - ERROR: firmware not found: $fw"
    exit 2
}

$fwBytes = [System.IO.File]::ReadAllBytes($fw)
if ($rootOffset + $rootLen -gt $fwBytes.Length) {
    Write-Error "Extract RootCA - ERROR: firmware too small to contain RootCA at 0x$($rootOffset.ToString('X'))"
    exit 3
}

$outBytes = New-Object byte[] $rootLen
[System.Array]::Copy($fwBytes, $rootOffset, $outBytes, 0, $rootLen)
[System.IO.File]::WriteAllBytes($out, $outBytes)

# Validate extracted bytes are a valid DER certificate
$null = openssl x509 -in $out -inform DER -noout 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Error "Extract RootCA - ERROR: extracted data at offset 0x$($rootOffset.ToString('X')) is not a valid DER certificate"
    exit 4
}

Write-Host "Extract RootCA - RootCA extracted"
Write-Host "    Offset : 0x$($rootOffset.ToString('X'))"
Write-Host "    Length : $rootLen bytes"
Write-Host "    Output : $out"

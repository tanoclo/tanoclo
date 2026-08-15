# patch.ps1
# Orchestrates the firmware patching process
param(
    [Parameter(Mandatory=$true, Position=0)]
    [int]$spiSlot,
    [Parameter(Mandatory=$true, Position=1)]
    [int]$endpointType,
    [switch]$ReuseCerts
)

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

$unmoddedInternal = Join-Path $scriptDir "unmodded.bin"
$unmoddedSpi = Join-Path $scriptDir "unmodded_spi.bin"
$moddedInternalCa = Join-Path $scriptDir "IB-patched-ca.bin"
$moddedInternalCaEndpoint = Join-Path $scriptDir "IB-patched-ca-endpoint.bin"
$moddedSpiCaEndpoint = Join-Path $scriptDir "IB-SPI-patched-ca-endpoint.bin"
$moddedInternalCaEndpointCrc = Join-Path $scriptDir "IB-patched-ca-endpoint-crc.bin"

if (-not (Test-Path $unmoddedInternal)) {
    throw "Patch - ERROR not found: $unmoddedInternal"
}

$fwSize = (Get-Item $unmoddedInternal).Length
if ($fwSize -ne 524288) {
    throw "Patch - ERROR: $unmoddedInternal is $fwSize bytes, expected 524288 (512KB)"
}

Write-Host "Patch - Patching CA in internal flash dump and creating leaf certificates with new CA"
& (Join-Path $scriptDir "build_all_and_patch.ps1") $unmoddedInternal $moddedInternalCa $endpointType $scriptDir -ReuseCerts:$ReuseCerts
Write-Host "Patch - Done patching CA in internal flash dump and creating leaf certificates with new CA"

if (-not (Test-Path $moddedInternalCa)) {
    throw "Patch - ERROR not found: $moddedInternalCa"
}

Write-Host "Patch - Patching endpoint in internal flash"
& (Join-Path $scriptDir "patch_endpoint.ps1") $moddedInternalCa $moddedInternalCaEndpoint $endpointType

if (-not (Test-Path $moddedInternalCaEndpoint)) {
    throw "Patch - ERROR not found: $moddedInternalCaEndpoint"
}

if ($endpointType -eq 1) {
    Write-Host "Patch - Endpoint set to ws://ingress.tado.com:988"
} elseif ($endpointType -eq 2) {
    Write-Host "Patch - Endpoint set to ws://tanoclo.tado.lan:988"
} else {
    Write-Host "Patch - Endpoint set to ws://ingress.tado.com:443"
}

Write-Host "Patch - Done patching endpoint in internal flash"

Write-Host "Patch - Patching CRC in internal flash dump"
& (Join-Path $scriptDir "patch_crc.ps1") $moddedInternalCaEndpoint $moddedInternalCaEndpointCrc

if (-not (Test-Path $moddedInternalCaEndpointCrc)) {
    throw "Patch - ERROR not found: $moddedInternalCaEndpointCrc"
}
Write-Host "Patch - Done patching CRC in internal flash dump"

if ($spiSlot -ne 0) {
    if (-not (Test-Path $unmoddedSpi)) {
        throw "Patch - ERROR: not found: $unmoddedSpi"
    }

    Copy-Item $unmoddedSpi $moddedSpiCaEndpoint -Force
    Write-Host "Patch - Patching external SPI flash"

    $internalBytes = [System.IO.File]::ReadAllBytes($moddedInternalCaEndpointCrc)
    $spiBytes = [System.IO.File]::ReadAllBytes($moddedSpiCaEndpoint)

    $offset128k = 128 * 1024
    $count384k = 384 * 1024
    $offset512k = 512 * 1024

    if ($spiSlot -eq 1) {
        [System.Array]::Copy($internalBytes, $offset128k, $spiBytes, $offset128k, $count384k)
    } elseif ($spiSlot -eq 2) {
        [System.Array]::Copy($internalBytes, $offset128k, $spiBytes, $offset512k, $count384k)
    } elseif ($spiSlot -eq 3) {
        [System.Array]::Copy($internalBytes, $offset128k, $spiBytes, $offset128k, $count384k)
        [System.Array]::Copy($internalBytes, $offset128k, $spiBytes, $offset512k, $count384k)
    }

    [System.IO.File]::WriteAllBytes($moddedSpiCaEndpoint, $spiBytes)
    Write-Host "Patch - Done patching external SPI flash"
} else {
    Write-Host "Patch - Skipping patch of external SPI flash"
}

Write-Host "Patch - Done"

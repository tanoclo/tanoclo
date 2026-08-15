# flash.ps1
# Flash patched binary to internal/external flash using openocd
param(
    [switch]$FlashInternal,
    [switch]$FlashSpi
)

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $scriptDir "utils.ps1")
Install-RequiredCommand "openocd" "xpack-dev-tools.openocd-xpack"

$moddedSpiCaEndpoint = "IB-SPI-patched-ca-endpoint.bin"
$moddedInternalCaEndpointCrc = "IB-patched-ca-endpoint-crc.bin"

# Check files exist in out/
$outInternal = Join-Path $scriptDir "out\$moddedInternalCaEndpointCrc"
$outSpi = Join-Path $scriptDir "out\$moddedSpiCaEndpoint"

if ($FlashInternal) {
    if (-not (Test-Path $outInternal)) {
        Write-Error "Flash - ERROR not found in out directory: $outInternal"
        exit 2
    }
}

if ($FlashSpi) {
    if (-not (Test-Path $outSpi)) {
        Write-Error "Flash - ERROR not found in out directory: $outSpi"
        exit 2
    }
}

# Copy to current directory for OpenOCD
if ($FlashInternal) {
    Copy-Item $outInternal (Join-Path $scriptDir $moddedInternalCaEndpointCrc) -Force
}
if ($FlashSpi) {
    Copy-Item $outSpi (Join-Path $scriptDir $moddedSpiCaEndpoint) -Force
}

try {
    if ($FlashInternal) {
        Write-Host "Flash - Flashing patched binary to internal flash"
        openocd -f interface/stlink.cfg -f target/stm32f4x.cfg -f program_internal_flash.tcl
        if ($LASTEXITCODE -ne 0) {
            throw "Flash - ERROR: openocd failed to flash internal flash"
        }
        Write-Host "Flash - Done flashing patched binary to internal flash"
    }

    if ($FlashSpi) {
        Write-Host "Flash - Flashing patched binary to external SPI flash"
        openocd -f interface/stlink.cfg -f target/stm32f4x.cfg -f program_external_flash.tcl
        if ($LASTEXITCODE -ne 0) {
            throw "Flash - ERROR: openocd failed to flash external SPI flash"
        }
        Write-Host "Flash - Done flashing patched binary to external SPI flash"
    }
}
finally {
    # Clean up temporary files in root directory
    Remove-Item (Join-Path $scriptDir $moddedInternalCaEndpointCrc) -Force -ErrorAction SilentlyContinue
    Remove-Item (Join-Path $scriptDir $moddedSpiCaEndpoint) -Force -ErrorAction SilentlyContinue
}

Write-Host "Flash - Done"

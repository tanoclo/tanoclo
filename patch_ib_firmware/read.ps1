# read.ps1
# Detect ST-Link, dump internal flash, and dump external SPI flash via helper stub

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $scriptDir "utils.ps1")
Install-RequiredCommand "openocd" "xpack-dev-tools.openocd-xpack"

$unmoddedInternal = "unmodded.bin"
$unmoddedSpi = "unmodded_spi.bin"

Write-Host "Read - Dumping internal flash"
openocd -f interface/stlink.cfg -f target/stm32f4x.cfg -f dump_internal_flash.tcl
if ($LASTEXITCODE -ne 0) {
    throw "Read - ERROR: openocd failed to dump internal flash"
}
Write-Host "Read - Done dumping internal flash"

if (-not (Test-Path $unmoddedInternal)) {
    throw "Read - ERROR not found: $unmoddedInternal"
}

Write-Host "Read: Dumping external SPI flash"
openocd -f interface/stlink.cfg -f target/stm32f4x.cfg -f dump_external_flash.tcl
if ($LASTEXITCODE -ne 0) {
    throw "Read - ERROR: openocd failed to dump external SPI flash"
}
Write-Host "Read - Done dumping external SPI flash"

Write-Host "Read: Combining SPI chunks into 1 binary and removing chunks"
$chunks = Get-ChildItem -Filter "spi_*.bin" | Where-Object { $_.Name -match "^spi_[0-9a-fA-F]{6}\.bin$" } | Sort-Object Name
if ($chunks) {
    $outFile = [System.IO.File]::Create((Join-Path (Get-Location) $unmoddedSpi))
    foreach ($chunk in $chunks) {
        $bytes = [System.IO.File]::ReadAllBytes($chunk.FullName)
        $outFile.Write($bytes, 0, $bytes.Length)
    }
    $outFile.Close()
    $chunks | Remove-Item -Force
    Write-Host "Read - Done combining SPI chunks into 1 binary and removing chunks"
}
else {
    Write-Host "Read - No SPI chunks found to combine"
}

if (-not (Test-Path $unmoddedSpi)) {
    throw "Read - ERROR: not found: $unmoddedSpi"
}

Write-Host "Read - Done"

# read_patch_flash.ps1
# Master automation script to dump, patch, and flash STM32 and SPI flash
param(
    [switch]$FlashInternal,
    [switch]$FlashSpiA,
    [switch]$FlashSpiB,
    [switch]$NoFlash,
    [switch]$ReuseCerts,
    [switch]$Revert
)

$unmoddedInternal = "unmodded.bin"
$unmoddedSpi = "unmodded_spi.bin"
$overwriteBothSpiSlots = 1
$endpointType = 2

# Keep unmodded.bin and unmodded_spi.bin in root directory if they exist (allows patching to proceed even if ST-Link is offline)
Get-ChildItem -Filter "IB-*.bin" | Remove-Item -Force -ErrorAction SilentlyContinue
if (-not $ReuseCerts) {
    Get-ChildItem -Filter "*.key" | Remove-Item -Force -ErrorAction SilentlyContinue
    Get-ChildItem -Filter "*.pem" | Remove-Item -Force -ErrorAction SilentlyContinue
    Get-ChildItem -Filter "*.cer" | Remove-Item -Force -ErrorAction SilentlyContinue
    Get-ChildItem -Filter "*.der" | Remove-Item -Force -ErrorAction SilentlyContinue
}

if (Test-Path out) {
    if (-not (Test-Path out_old)) {
        $null = New-Item -ItemType Directory -Path out_old -Force
    }
    Get-ChildItem out | ForEach-Object {
        $target = Join-Path "out_old" $_.Name
        if (Test-Path $target) {
            Remove-Item $target -Force -ErrorAction SilentlyContinue
        }
        Move-Item $_.FullName $target -Force -ErrorAction SilentlyContinue
    }
    Remove-Item out -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Host "Read Patch Flash - Done removing old files"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# Handle certificate reuse if requested
if ($ReuseCerts) {
    if (-not (Test-Path out_old)) {
        throw "ERROR: -ReuseCerts specified but out_old directory does not exist."
    }
    Write-Host "Read Patch Flash - Reusing existing certificates from out_old"
    $null = New-Item -ItemType Directory -Path out -Force
    Copy-Item out_old/*.pem out/ -Force -ErrorAction SilentlyContinue
    Copy-Item out_old/*.key out/ -Force -ErrorAction SilentlyContinue
    Copy-Item out_old/*.cer out/ -Force -ErrorAction SilentlyContinue
    Copy-Item out_old/*.der out/ -Force -ErrorAction SilentlyContinue
    # Copy to root directory so that patching scripts can locate/use them
    Copy-Item out/*.pem . -Force -ErrorAction SilentlyContinue
    Copy-Item out/*.key . -Force -ErrorAction SilentlyContinue
    Copy-Item out/*.cer . -Force -ErrorAction SilentlyContinue
    Copy-Item out/*.der . -Force -ErrorAction SilentlyContinue
}

# Dump flash
try {
    & (Join-Path $scriptDir "read.ps1")
}
catch {
    if (-not (Test-Path $unmoddedInternal) -and (Test-Path "out_old/$unmoddedInternal")) {
        Copy-Item "out_old/$unmoddedInternal" . -Force -ErrorAction SilentlyContinue
    }
    if (-not (Test-Path $unmoddedSpi) -and (Test-Path "out_old/$unmoddedSpi")) {
        Copy-Item "out_old/$unmoddedSpi" . -Force -ErrorAction SilentlyContinue
    }
    if ((Test-Path $unmoddedInternal) -and (Test-Path $unmoddedSpi)) {
        Write-Warning "Flash dumping failed: $_. Using existing unmodded.bin and unmodded_spi.bin as fallback."
    }
    else {
        throw "ERROR: Flash dumping process failed and no local fallback binaries were found: $_"
    }
}
Write-Host "Read Patch Flash - Done dumping/verifying raw binaries"

# Save timestamped copies of raw dumps to original directory
if (-not (Test-Path "original")) {
    $null = New-Item -ItemType Directory -Path original -Force
}
$timestamp = (Get-Date).ToString("yyyyMMdd_HHmmss")
if (Test-Path $unmoddedInternal) {
    Copy-Item $unmoddedInternal "original/dump_internal_$timestamp.bin" -Force
    Write-Host "Read Patch Flash - Saved timestamped internal dump: dump_internal_$timestamp.bin"
}
if (Test-Path $unmoddedSpi) {
    Copy-Item $unmoddedSpi "original/dump_spi_$timestamp.bin" -Force
    Write-Host "Read Patch Flash - Saved timestamped SPI dump: dump_spi_$timestamp.bin"
}

if ($Revert) {
    Write-Host "Read Patch Flash - Revert mode selected. Restoring original factory firmware..."
    
    $origInternalPath = "original/$unmoddedInternal"
    $origSpiPath = "original/$unmoddedSpi"
    
    if (-not (Test-Path $origInternalPath) -or -not (Test-Path $origSpiPath)) {
        throw "ERROR: Cannot revert. Backup files '$origInternalPath' and/or '$origSpiPath' do not exist."
    }
    
    $writeInternal = $FlashInternal.IsPresent
    $writeSpiA = $FlashSpiA.IsPresent
    $writeSpiB = $FlashSpiB.IsPresent
    $skipFlash = $NoFlash.IsPresent
    
    if (-not ($FlashInternal.IsPresent -or $FlashSpiA.IsPresent -or $FlashSpiB.IsPresent -or $NoFlash.IsPresent)) {
        $writeInternal = $true
        $writeSpiA = $true
        $writeSpiB = $true
    }
    
    $null = New-Item -ItemType Directory -Path out -Force
    Copy-Item $origInternalPath "out/IB-patched-ca-endpoint-crc.bin" -Force
    Copy-Item $origSpiPath "out/IB-SPI-patched-ca-endpoint.bin" -Force
    
    # Preserve unmodded fallback binaries
    Copy-Item $origInternalPath "out/$unmoddedInternal" -Force
    Copy-Item $origSpiPath "out/$unmoddedSpi" -Force
    
    # Preserve existing certificates from out_old or root directory
    if (Test-Path out_old) {
        Copy-Item out_old/*.pem out/ -Force -ErrorAction SilentlyContinue
        Copy-Item out_old/*.key out/ -Force -ErrorAction SilentlyContinue
        Copy-Item out_old/*.cer out/ -Force -ErrorAction SilentlyContinue
        Copy-Item out_old/*.der out/ -Force -ErrorAction SilentlyContinue
    }
    Copy-Item *.pem out/ -Force -ErrorAction SilentlyContinue
    Copy-Item *.key out/ -Force -ErrorAction SilentlyContinue
    Copy-Item *.cer out/ -Force -ErrorAction SilentlyContinue
    Copy-Item *.der out/ -Force -ErrorAction SilentlyContinue
    
    if (-not $skipFlash) {
        Write-Host "Read Patch Flash - Flashing original factory binaries"
        & (Join-Path $scriptDir "flash.ps1") -FlashInternal:$writeInternal -FlashSpi:($writeSpiA -or $writeSpiB)
        Write-Host "Read Patch Flash - Done flashing original factory binaries"
    }
    else {
        Write-Host "Read Patch Flash - Skipping flashing step (flash nothing selected)"
    }
    
    Write-Host "Read Patch Flash - Revert process completed successfully."
    exit 0
}

Write-Host "Read Patch Flash - Checking firmware version..."
try {
    & (Join-Path $scriptDir "check_firmware.ps1") $unmoddedInternal $unmoddedSpi
}
catch {
    throw "ERROR: Firmware verification/update failed: $_"
}
Write-Host "Read Patch Flash - Done checking firmware version"

$explicitSlots = $FlashInternal.IsPresent -or $FlashSpiA.IsPresent -or $FlashSpiB.IsPresent -or $NoFlash.IsPresent

$writeInternal = $false
$writeSpiA = $false
$writeSpiB = $false
$skipFlash = $false

if ($NoFlash.IsPresent) {
    $skipFlash = $true
    # Still patch based on overwriteBothSpiSlots or auto-detect so files are generated correctly
    $writeSpiA = ($overwriteBothSpiSlots -eq 1)
    $writeSpiB = ($overwriteBothSpiSlots -eq 1)
}

if (-not $explicitSlots) {
    $writeInternal = $true
    if ($overwriteBothSpiSlots -eq 1) {
        $writeSpiA = $true
        $writeSpiB = $true
    }
    else {
        $internalBytes = [System.IO.File]::ReadAllBytes($unmoddedInternal)
        $spiBytes = [System.IO.File]::ReadAllBytes($unmoddedSpi)
        
        $offset128k = 128 * 1024
        $offset512k = 512 * 1024
        $count384k = 384 * 1024
        
        $internalChunk = New-Object byte[] $count384k
        [System.Array]::Copy($internalBytes, $offset128k, $internalChunk, 0, $count384k)
        
        $spiChunkA = New-Object byte[] $count384k
        [System.Array]::Copy($spiBytes, $offset128k, $spiChunkA, 0, $count384k)
        
        $spiChunkB = New-Object byte[] $count384k
        [System.Array]::Copy($spiBytes, $offset512k, $spiChunkB, 0, $count384k)
        
        function Compare-Bytes {
            param([byte[]]$a, [byte[]]$b)
            if ($a.Length -ne $b.Length) { return $false }
            for ($i = 0; $i -lt $a.Length; $i++) {
                if ($a[$i] -ne $b[$i]) { return $false }
            }
            return $true
        }
        
        if (Compare-Bytes $internalChunk $spiChunkA) {
            Write-Host "Read Patch Flash - Matching SPI slot found, selecting slot A"
            $writeSpiA = $true
        }
        elseif (Compare-Bytes $internalChunk $spiChunkB) {
            Write-Host "Read Patch Flash - Matching SPI slot found, selecting slot B"
            $writeSpiB = $true
        }
        else {
            Write-Host "Read Patch Flash - No matching SPI slot found, defaulting to slot B"
            $writeSpiB = $true
        }
    }
} elseif (-not $NoFlash.IsPresent) {
    $writeInternal = $FlashInternal.IsPresent
    $writeSpiA = $FlashSpiA.IsPresent
    $writeSpiB = $FlashSpiB.IsPresent
}

$spiSlot = 0
if ($writeSpiA -and $writeSpiB) {
    $spiSlot = 3
} elseif ($writeSpiA) {
    $spiSlot = 1
} elseif ($writeSpiB) {
    $spiSlot = 2
}

Write-Host "Read Patch Flash - Patching files"
try {
    & (Join-Path $scriptDir "patch.ps1") $spiSlot $endpointType -ReuseCerts:$ReuseCerts
}
catch {
    throw "ERROR: Patching process failed: $_"
}

# Verify output binaries exist and are valid sizes before moving and flashing
$patchedInternal = "IB-patched-ca-endpoint-crc.bin"
$patchedSpi = "IB-SPI-patched-ca-endpoint.bin"

if (-not (Test-Path $patchedInternal)) {
    throw "ERROR: Patched internal binary '$patchedInternal' was not generated."
}
if ((Get-Item $patchedInternal).Length -ne 524288) {
    throw "ERROR: Patched internal binary '$patchedInternal' size is $((Get-Item $patchedInternal).Length) bytes (expected 524288)."
}

if ($spiSlot -ne 0) {
    if (-not (Test-Path $patchedSpi)) {
        throw "ERROR: Patched SPI binary '$patchedSpi' was not generated."
    }
    if ((Get-Item $patchedSpi).Length -ne 2097152) {
        throw "ERROR: Patched SPI binary '$patchedSpi' size is $((Get-Item $patchedSpi).Length) bytes (expected 2097152)."
    }
}
Write-Host "Read Patch Flash - Done patching files (All files validated)"

Write-Host "Read Patch Flash - Moving files to out directory"
$null = New-Item -ItemType Directory -Path out -Force
Move-Item *.pem out/ -Force -ErrorAction SilentlyContinue
Move-Item *.key out/ -Force -ErrorAction SilentlyContinue
Move-Item *.cer out/ -Force -ErrorAction SilentlyContinue
Move-Item *.der out/ -Force -ErrorAction SilentlyContinue
Move-Item *.bin out/ -Force -ErrorAction SilentlyContinue
Write-Host "Read Patch Flash - Done moving files to out directory"

# Fill original directory if the extracted RootCA matches the original hardcoded SHA256
$originalRootCaSha = "1cd811ecdbdd2f127b4d67c57e9a191f46a53c70193af9c933bc9a24f379b23f"
$extractedCaCer = "out/tadoRootCA.cer"

if (Test-Path $extractedCaCer) {
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    $cerBytes = [System.IO.File]::ReadAllBytes((Resolve-Path $extractedCaCer).Path)
    $cerHash = [System.BitConverter]::ToString($sha256.ComputeHash($cerBytes)).Replace("-", "").ToLower()
    
    if ($cerHash -eq $originalRootCaSha) {
        Write-Host "Read Patch Flash - Extracted RootCA matches original Tado RootCA. Writing true unmodded backups to original directory."
        if (-not (Test-Path "original")) {
            $null = New-Item -ItemType Directory -Path original -Force
        }
        Copy-Item "out/tadoRootCA.cer" "original/tadoRootCA.cer" -Force
        Copy-Item "out/tadoRootCA.der" "original/tadoRootCA.der" -Force
        Copy-Item "out/$unmoddedInternal" "original/$unmoddedInternal" -Force
        Copy-Item "out/$unmoddedSpi" "original/$unmoddedSpi" -Force
    } else {
        Write-Host "Read Patch Flash - Extracted RootCA ($cerHash) does not match original Tado RootCA. Skipping original directory true backup."
    }
}

if (-not $skipFlash) {
    Write-Host "Read Patch Flash - Flashing modded binaries"
    & (Join-Path $scriptDir "flash.ps1") -FlashInternal:$writeInternal -FlashSpi:($writeSpiA -or $writeSpiB)
    Write-Host "Read Patch Flash - Done flashing modded binaries"
} else {
    Write-Host "Read Patch Flash - Skipping flashing step (flash nothing selected)"
}

Write-Host "Read Patch Flash - Copy the generated certificates to the ws-server/certs directory:"
Write-Host "  cp original/tadoRootCA.cer ../ws-server/certs/tadoRootCA.cer"
Write-Host "  cp out/tanoclo_key.pem ../ws-server/certs/tanoclo_key.pem"
Write-Host "  cp out/tanoclo_cert.pem ../ws-server/certs/tanoclo_cert.pem"
Write-Host "Read Patch Flash - Then restart the TaNoClo Docker container to load the new certificates."

if ($endpointType -ne 0) {
    Write-Host "Read Patch Flash - The IB will connect to port 988. Ensure your DNS resolves the target domain to your server."
}
else {
    Write-Host "Read Patch Flash - The IB will connect to port 443. Ensure your DNS resolves the target domain to your server."
}

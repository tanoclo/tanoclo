# build_all_and_patch.ps1
# Build all and patch internal flash dump and create leaf certificates
param(
    [Parameter(Mandatory=$true, Position=0)]
    [string]$inFw,
    [Parameter(Mandatory=$true, Position=1)]
    [string]$outFw,
    [Parameter(Mandatory=$true, Position=2)]
    [int]$endpointType,
    [Parameter(Mandatory=$true, Position=3)]
    [string]$outDir,
    [switch]$ReuseCerts
)

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $scriptDir "utils.ps1")
Install-RequiredCommand "openssl" "ShiningLight.OpenSSL.Light"

$extractScript = Join-Path $scriptDir "extract_rootca.ps1"
$rootScript = Join-Path $scriptDir "clone_rootca.ps1"
$chainScript = Join-Path $scriptDir "clone_chain.ps1"
$patchScript = Join-Path $scriptDir "patch_rootca_validate.ps1"

foreach ($s in @($extractScript, $rootScript, $chainScript, $patchScript)) {
    if (-not (Test-Path $s)) {
        Write-Error "Build all and patch - ERROR: missing required script: $s"
        exit 2
    }
}

if (-not (Test-Path $inFw)) {
    Write-Error "Build all and patch - ERROR: firmware not found: $inFw"
    exit 4
}

$null = New-Item -ItemType Directory -Path $outDir -Force
$outDir = (Resolve-Path $outDir).Path

$work = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), [System.IO.Path]::GetRandomFileName())
$null = New-Item -ItemType Directory -Path $work

try {
    $origRootDer = Join-Path $outDir "tadoRootCA.der"
    $origRootPem = Join-Path $outDir "tadoRootCA.cer"

    $rootKey = Join-Path $outDir "tanocloRootCAkey.pem"
    $rootDer = Join-Path $outDir "tanocloRootCA.der"
    $rootPem = Join-Path $outDir "tanocloRootCA.cer"

    $intKey = Join-Path $outDir "ingress-intermediate.key"
    $intPem = Join-Path $outDir "ingress-intermediate.pem"

    $leafKey = Join-Path $outDir "ingress.key"
    $leafPem = Join-Path $outDir "ingress.pem"

    $fullChain = Join-Path $outDir "ingress-fullchain.pem"
    $fullChainKey = Join-Path $outDir "tanocloMITM.pem"

    if ([System.IO.Path]::IsPathRooted($outFw)) {
        $patchedFw = $outFw
    } else {
        $patchedFw = Join-Path $outDir $outFw
    }

    Write-Host "Build all and patch - Output directory: $outDir"

    # 0) Extract original RootCA from firmware
    Write-Host "Build all and patch - Extracting original RootCA from firmware..."
    if (-not $ReuseCerts) {
        & $extractScript $inFw $origRootDer

        $rootLen = (Get-Item $origRootDer).Length
        if ($rootLen -ne 639) {
            Write-Error "Build all and patch - ERROR: extracted RootCA length is $rootLen bytes (expected 639)"
            exit 5
        }

        openssl x509 -in $origRootDer -inform DER -out $origRootPem -outform PEM
    } else {
        Write-Host "Build all and patch - Skipping RootCA extraction (reusing existing)"
    }

    # 1) Generate cloned RootCA
    Write-Host "Build all and patch - Generating cloned RootCA..."
    if (-not $ReuseCerts) {
        & $rootScript $origRootDer $rootKey $rootDer

        openssl x509 -in $rootDer -inform DER -out $rootPem -outform PEM
    } else {
        Write-Host "Build all and patch - Skipping cloned RootCA generation (reusing existing)"
    }

    # 2) Generate Intermediate + Leaf
    Write-Host "Build all and patch - Generating Intermediate and Leaf certificates..."
    if (-not $ReuseCerts) {
        $oldDir = Get-Location
        Set-Location $work

        Copy-Item $rootDer "tanocloRootCA.der"
        Copy-Item $rootKey "tanocloRootCAkey.pem"

        & $chainScript $endpointType

        Copy-Item "ingress-intermediate.pem" $intPem
        Copy-Item "ingress-intermediate.key" $intKey
        Copy-Item "ingress.pem" $leafPem
        Copy-Item "ingress.key" $leafKey

        [System.IO.File]::WriteAllText($fullChain, (Get-Content "ingress.pem" -Raw) + (Get-Content "ingress-intermediate.pem" -Raw))
        [System.IO.File]::WriteAllText($fullChainKey, (Get-Content "ingress.key" -Raw) + (Get-Content $fullChain -Raw))

        Set-Location $oldDir

        # Server-facing copies for ws-server compatibility
        Copy-Item $leafKey (Join-Path $outDir "tanoclo_key.pem") -Force
        Copy-Item $fullChain (Join-Path $outDir "tanoclo_cert.pem") -Force
    } else {
        Write-Host "Build all and patch - Skipping Intermediate + Leaf generation (reusing existing)"
    }

    # 3) Validate certificate chain
    Write-Host "Build all and patch - Validating certificate chain with OpenSSL..."
    openssl verify -CAfile $rootPem -untrusted $intPem $leafPem
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Build all and patch - ERROR: certificate verification failed"
        exit 7
    }
    Write-Host "Build all and patch - Certificate chain validated"

    # 4) Patch firmware + validation (final logic)
    Write-Host "Build all and patch - Patching firmware..."
    & $patchScript $inFw $rootDer $patchedFw

    # 5) Verify embedded RootCA bytes
    Write-Host "Build all and patch - Verifying embedded RootCA in patched firmware..."
    $certOffset = 0x00059FF0
    $certLen = 639

    $patchedFwBytes = [System.IO.File]::ReadAllBytes($patchedFw)
    $embeddedBytes = New-Object byte[] $certLen
    [System.Array]::Copy($patchedFwBytes, $certOffset, $embeddedBytes, 0, $certLen)

    # Compute SHA256 of embeddedBytes
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    $embeddedHash = [System.BitConverter]::ToString($sha256.ComputeHash($embeddedBytes)).Replace("-", "").ToLower()

    $rootBytes = [System.IO.File]::ReadAllBytes($rootDer)
    $rootHash = [System.BitConverter]::ToString($sha256.ComputeHash($rootBytes)).Replace("-", "").ToLower()

    if ($embeddedHash -ne $rootHash) {
        Write-Error "Build all and patch - ERROR: embedded RootCA does not match rootca.der"
        exit 6
    }

    Write-Host "Build all and patch - Embedded RootCA verified"
    Write-Host ""
    Write-Host "Build all and patch - Done"
    Write-Host "Artifacts:"
    Write-Host "  RootCA:"
    Write-Host "    DER: $rootDer"
    Write-Host "    PEM: $rootPem"
    Write-Host "    KEY: $rootKey"
    Write-Host "  Intermediate:"
    Write-Host "    PEM: $intPem"
    Write-Host "    KEY: $intKey"
    Write-Host "  Leaf:"
    Write-Host "    PEM: $leafPem"
    Write-Host "    KEY: $leafKey"
    Write-Host "  Full chain:"
    Write-Host "    $fullChain"
    Write-Host "  Full chain with key (for MITM):"
    Write-Host "    $fullChainKey"
    Write-Host "  Server certs (for ws-server):"
    Write-Host "    $(Join-Path $outDir "tanoclo_key.pem")"
    Write-Host "    $(Join-Path $outDir "tanoclo_cert.pem")"
    Write-Host "  Patched firmware:"
    Write-Host "    $patchedFw"

} finally {
    Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}

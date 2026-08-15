# clone_rootca.ps1
# Mimic and generate Root CA cert

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $scriptDir "utils.ps1")
Install-RequiredCommand "openssl" "ShiningLight.OpenSSL.Light"

if ($args.Count -ne 3) {
    Write-Error "Usage: clone_rootca.ps1 <original.der> <out_key.pem> <out_cert.der>"
    exit 1
}

$origDer = Resolve-Path $args[0]
$outKey = $args[1]
$outDer = $args[2]

# Temp directory
$work = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), [System.IO.Path]::GetRandomFileName())
$null = New-Item -ItemType Directory -Path $work

try {
    $origLen = (Get-Item $origDer).Length
    $start = "20190207102053Z"
    $end = "20390202102053Z"

    # 1) Generate key
    $null = openssl ecparam -name prime256v1 -genkey -noout -out $outKey

    # 2) CA directory structure
    $ca = Join-Path $work "ca"
    $null = New-Item -ItemType Directory -Path (Join-Path $ca "certs")
    $null = New-Item -ItemType Directory -Path (Join-Path $ca "crl")
    $null = New-Item -ItemType Directory -Path (Join-Path $ca "newcerts")
    $null = New-Item -ItemType Directory -Path (Join-Path $ca "private")
    
    [System.IO.File]::WriteAllText((Join-Path $ca "index.txt"), "")
    [System.IO.File]::WriteAllText((Join-Path $ca "index.txt.attr"), "unique_subject = no`n")
    Copy-Item $outKey (Join-Path $ca "private/ca.key") -Force

    # 3) Config file
    $conf = Join-Path $work "openssl.cnf"
    $caPathForward = $ca.Replace("\", "/")
    $confContent = @"
[ ca ]
default_ca = CA_default

[ CA_default ]
dir               = $caPathForward
database          = `$dir/index.txt
new_certs_dir     = `$dir/newcerts
serial            = `$dir/serial
private_key       = `$dir/private/ca.key
certificate       = `$dir/certs/issuer.pem
default_md        = sha256
policy            = policy_any
x509_extensions   = v3_ca
copy_extensions   = none

[ policy_any ]
countryName            = supplied
stateOrProvinceName    = supplied
localityName           = supplied
organizationName       = supplied
organizationalUnitName = supplied
commonName             = supplied
emailAddress           = supplied

[ req ]
prompt             = no
distinguished_name = dn
string_mask        = utf8only
preserve           = yes
req_extensions     = v3_req

# EXACT DER RDN ORDER
[ dn ]
0.C  = DE
1.ST = Germany
2.L  = Munich
3.O  = tado GmbH
4.OU = IoT Cloud
5.CN = tado RootCA
6.emailAddress = aws-ops@tado.com

# CSR extensions (NO SKI/AKI HERE)
[ v3_req ]
basicConstraints = critical,CA:true
keyUsage         = critical,digitalSignature,keyCertSign,cRLSign

# Final cert extensions (SKI + AKI required)
[ v3_ca ]
basicConstraints       = critical,CA:true
keyUsage               = critical,digitalSignature,keyCertSign,cRLSign
subjectKeyIdentifier   = hash
authorityKeyIdentifier = keyid
"@
    [System.IO.File]::WriteAllText($conf, $confContent)

    # 4) CSR
    $csr = Join-Path $work "req.csr"
    $null = openssl req -new -key $outKey -out $csr -config $conf 2>$null

    # Gate CSR DN order
    $csrSubj = (openssl req -in $csr -noout -subject -nameopt compat)
    if ($csrSubj -match "^subject=\s*(.*)$") {
        $csrSubj = $Matches[1]
    }
    $expectedCompat = "/C=DE/ST=Germany/L=Munich/O=tado GmbH/OU=IoT Cloud/CN=tado RootCA/emailAddress=aws-ops@tado.com"
    if ($csrSubj -ne $expectedCompat) {
        Write-Error "Clone RootCA - ERROR: CSR DN order wrong."
        Write-Error "  got:      $csrSubj"
        Write-Error "  expected: $expectedCompat"
        exit 2
    }

    $resetCaDb = {
        [System.IO.File]::WriteAllText((Join-Path $ca "index.txt"), "")
        Remove-Item (Join-Path $ca "newcerts/*") -Force -ErrorAction SilentlyContinue
        Remove-Item (Join-Path $ca "certs/issuer.pem") -Force -ErrorAction SilentlyContinue
    }

    $makeIssuerCert = {
        $null = openssl ca -batch -selfsign `
          -config $conf `
          -in $csr `
          -keyfile (Join-Path $ca "private/ca.key") `
          -startdate $start `
          -enddate $end `
          -extensions v3_req `
          -out (Join-Path $ca "certs/issuer.pem") 2>$null
    }

    $bestDiff = 999999
    $bestDer = Join-Path $work "best.der"

    # Loop range
    $startVal = [UInt64]9404289437119033189
    $endVal = [UInt64]9404289437119064190

    for ($i = $startVal; $i -le $endVal; $i++) {
        & $resetCaDb

        $serial = $i.ToString("X16")
        [System.IO.File]::WriteAllText((Join-Path $ca "serial"), "$serial`n")

        & $makeIssuerCert

        $tmpPem = Join-Path $work "tmp.pem"
        $tmpDer = Join-Path $work "tmp.der"

        $null = openssl ca -batch `
          -config $conf `
          -in $csr `
          -keyfile (Join-Path $ca "private/ca.key") `
          -startdate $start `
          -enddate $end `
          -extensions v3_ca `
          -out $tmpPem 2>$null

        $null = openssl x509 -in $tmpPem -out $tmpDer -outform DER 2>$null

        # Check AKI
        $txt = openssl x509 -in $tmpDer -inform DER -noout -text
        if (-not ($txt -match "Authority Key Identifier|AuthorityKeyIdentifier")) {
            Write-Error "Clone RootCA - ERROR: AKI still missing (unexpected on this path). Aborting."
            exit 3
        }

        $len = (Get-Item $tmpDer).Length
        $diff = [Math]::Abs($len - $origLen)
        if ($diff -lt $bestDiff) {
            $bestDiff = $diff
            Copy-Item $tmpDer $bestDer -Force
        }

        if ($len -eq $origLen) {
            Copy-Item $tmpDer $outDer -Force
            Write-Host "Clone RootCA - Exact DER length matched: $len bytes (original $origLen), serial=0x$serial"
            exit 0
        }
    }

    Copy-Item $bestDer $outDer -Force
    Write-Error "Clone RootCA - ERROR: No exact DER-length match found (closest diff=$bestDiff bytes)."
    Write-Error "Clone RootCA - The cloned certificate must be exactly $origLen bytes to fit the firmware slot."
    exit 1

} finally {
    Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}

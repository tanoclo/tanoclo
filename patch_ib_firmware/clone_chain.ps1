# clone_chain.ps1
# Creates a NEW IntermediateCA and Leaf cert chained to a cloned RootCA

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $scriptDir "utils.ps1")
Install-RequiredCommand "openssl" "ShiningLight.OpenSSL.Light"

if ($args.Count -ne 1) {
    Write-Error "Usage: clone_chain.ps1 <endpoint_type>"
    exit 1
}

$endpointType = $args[0]
if ($endpointType -ne 2) {
    $endpoint = "ingress.tado.com"
} else {
    $endpoint = "tanoclo.tado.lan"
}

$rootCaDer = "tanocloRootCA.der"
$rootCaKey = "tanocloRootCAkey.pem"

$work = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), [System.IO.Path]::GetRandomFileName())
$null = New-Item -ItemType Directory -Path $work

try {
    Write-Host "Clone chain - Using RootCA:"
    $subj = openssl x509 -in $rootCaDer -inform DER -noout -subject -nameopt compat
    Write-Host $subj

    Write-Host "Clone chain - Creating IntermediateCA..."
    $null = openssl ecparam -name prime256v1 -genkey -noout -out ingress-intermediate.key

    $intermediateCnf = Join-Path $work "intermediate.cnf"
    $cnfContent = @"
[ req ]
prompt = no
distinguished_name = dn
string_mask = utf8only
preserve = yes

[ dn ]
0.C  = DE
1.ST = Germany
2.O  = tado GmbH
3.OU = IoT Cloud
4.CN = tado Ingress IntermediateCA
5.emailAddress = aws-ops@tado.com
"@
    [System.IO.File]::WriteAllText($intermediateCnf, $cnfContent)

    $null = openssl req -new `
      -key ingress-intermediate.key `
      -out ingress-intermediate.csr `
      -config $intermediateCnf 2>$null

    $intermediateExt = Join-Path $work "intermediate_ext.cnf"
    $extContent = @"
basicConstraints       = critical,CA:true,pathlen:0
keyUsage               = critical,keyCertSign,cRLSign
subjectKeyIdentifier   = hash
authorityKeyIdentifier = keyid
"@
    [System.IO.File]::WriteAllText($intermediateExt, $extContent)

    $null = openssl x509 -req `
      -in ingress-intermediate.csr `
      -CA $rootCaDer `
      -CAkey $rootCaKey `
      -CAcreateserial `
      -days 7300 `
      -sha256 `
      -extfile $intermediateExt `
      -out ingress-intermediate.pem 2>$null

    Write-Host "Clone chain - Intermediate subject:"
    $intSubj = openssl x509 -in ingress-intermediate.pem -noout -subject -nameopt compat
    Write-Host $intSubj

    Write-Host "Clone chain - Creating $endpoint leaf..."
    $null = openssl ecparam -name prime256v1 -genkey -noout -out ingress.key

    $leafCnf = Join-Path $work "leaf.cnf"
    $leafCnfContent = @"
[ req ]
prompt = no
distinguished_name = dn
req_extensions = v3_req
string_mask = utf8only
preserve = yes

[ dn ]
0.CN = $endpoint

[ v3_req ]
subjectAltName = @alt_names

[ alt_names ]
DNS.1 = $endpoint
"@
    [System.IO.File]::WriteAllText($leafCnf, $leafCnfContent)

    $null = openssl req -new `
      -key ingress.key `
      -out ingress.csr `
      -config $leafCnf 2>$null

    $leafExt = Join-Path $work "leaf_ext.cnf"
    $leafExtContent = @"
basicConstraints       = CA:false
keyUsage               = digitalSignature
extendedKeyUsage       = serverAuth
subjectKeyIdentifier   = hash
authorityKeyIdentifier = keyid
subjectAltName         = DNS:$endpoint
"@
    [System.IO.File]::WriteAllText($leafExt, $leafExtContent)

    $null = openssl x509 -req `
      -in ingress.csr `
      -CA ingress-intermediate.pem `
      -CAkey ingress-intermediate.key `
      -CAcreateserial `
      -days 7300 `
      -sha256 `
      -extfile $leafExt `
      -out ingress.pem 2>$null

    Write-Host "Clone chain - Leaf subject:"
    $leafSubj = openssl x509 -in ingress.pem -noout -subject -nameopt compat
    Write-Host $leafSubj

    Write-Host "Clone chain - Leaf SAN:"
    $leafSan = openssl x509 -in ingress.pem -noout -text | Select-String -Pattern "Subject Alternative Name" -Context 0,1
    Write-Host $leafSan

} finally {
    Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}

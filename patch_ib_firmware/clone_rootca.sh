#!/usr/bin/env bash
# ==============================================================================
# Script: clone_rootca.sh
# Description: Clones properties of the original Root CA DER certificate,
#              emulating exact subject Distinguished Name RDN sequences,
#              recreating key identifier extensions, and compiling it to DER format
#              matching the target 639-byte footprint.
#
# Arguments:
#   $1 - Path to original root CA DER certificate file
#   $2 - Path to write the output PEM format private key file
#   $3 - Path to write the output DER format cloned Root CA certificate file
# ==============================================================================
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "Usage: $0 <original.der> <out_key.pem> <out_cert.der>" >&2
  exit 1
fi

ORIG_DER="$1"
OUT_KEY="$2"
OUT_DER="$3"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

ORIG_LEN="$(wc -c < "$ORIG_DER" | tr -d ' ')"

START="20190207102053Z"
END="20390202102053Z"

# 1) Generate key
openssl ecparam -name prime256v1 -genkey -noout -out "$OUT_KEY"

# 2) CA directory
CA="$WORK/ca"
mkdir -p "$CA"/{certs,crl,newcerts,private}
touch "$CA/index.txt"
touch "$CA/index.txt.attr"
echo 'unique_subject = no' > "$CA/index.txt.attr"
chmod 700 "$CA/private"
cp "$OUT_KEY" "$CA/private/ca.key"

# 3) Single config used everywhere
CONF="$WORK/openssl.cnf"
cat > "$CONF" <<EOF
[ ca ]
default_ca = CA_default

[ CA_default ]
dir               = $CA
database          = \$dir/index.txt
new_certs_dir     = \$dir/newcerts
serial            = \$dir/serial
private_key       = \$dir/private/ca.key
certificate       = \$dir/certs/issuer.pem
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
EOF

# 4) CSR
CSR="$WORK/req.csr"
openssl req -new -key "$OUT_KEY" -out "$CSR" -config "$CONF"

# Gate: CSR subject order must match exactly
EXPECTED='/C=DE/ST=Germany/L=Munich/O=tado GmbH/OU=IoT Cloud/CN=tado RootCA/emailAddress=aws-ops@tado.com'
CSR_SUBJ="$(openssl req -in "$CSR" -noout -subject -nameopt compat | sed 's/^subject=//')"
if [[ "$CSR_SUBJ" != "$EXPECTED" ]]; then
  echo "Clone RootCA - ERROR: CSR DN order wrong." >&2
  echo "  got:      $CSR_SUBJ" >&2
  echo "  expected: $EXPECTED" >&2
  exit 2
fi

reset_ca_db() {
  : > "$CA/index.txt"
  rm -f "$CA/newcerts/"* 2>/dev/null || true
  rm -f "$CA/certs/issuer.pem" 2>/dev/null || true
}

# Create a minimal issuer cert so OpenSSL has an issuer certificate object loaded.
# It can lack AKI; it exists solely to enable AKI emission on the final signing pass.
make_issuer_cert() {
  local issuer_pem="$1"
  # Use openssl ca -selfsign just to create issuer.pem with correct DN and dates.
  # IMPORTANT: This is not the final output.
  openssl ca -batch -selfsign \
    -config "$CONF" \
    -in "$CSR" \
    -keyfile "$CA/private/ca.key" \
    -startdate "$START" \
    -enddate "$END" \
    -extensions v3_req \
    -out "$issuer_pem" >/dev/null 2>&1
}

BEST_DIFF=999999
BEST_DER="$WORK/best.der"

for i in $(seq 9404289437119033189 9404289437119064190); do
  reset_ca_db

  SERIAL="$(printf "%016X" "$i")"
  echo "$SERIAL" > "$CA/serial"

  # 5a) Create issuer.pem (for AKI computation)
  make_issuer_cert "$CA/certs/issuer.pem"

  TMP_PEM="$WORK/tmp.pem"
  TMP_DER="$WORK/tmp.der"

  # 5b) Final issuance WITHOUT -selfsign (forces issuer cert to be loaded → AKI emitted)
  openssl ca -batch \
    -config "$CONF" \
    -in "$CSR" \
    -keyfile "$CA/private/ca.key" \
    -startdate "$START" \
    -enddate "$END" \
    -extensions v3_ca \
    -out "$TMP_PEM" >/dev/null 2>&1

  openssl x509 -in "$TMP_PEM" -out "$TMP_DER" -outform DER

  # Gate: ensure AKI is present
  if ! openssl x509 -in "$TMP_DER" -inform DER -noout -text | grep -q "X509v3 Authority Key Identifier"; then
    echo "Clone RootCA - ERROR: AKI still missing (unexpected on this path). Aborting." >&2
    exit 3
  fi

  LEN="$(wc -c < "$TMP_DER" | tr -d ' ')"
  DIFF=$(( LEN > ORIG_LEN ? LEN - ORIG_LEN : ORIG_LEN - LEN ))
  (( DIFF < BEST_DIFF )) && BEST_DIFF="$DIFF" && cp -f "$TMP_DER" "$BEST_DER"

  if (( LEN == ORIG_LEN )); then
    cp -f "$TMP_DER" "$OUT_DER"
    echo "Clone RootCA - Exact DER length matched: $LEN bytes (original $ORIG_LEN), serial=0x$SERIAL"
    exit 0
  fi
done

cp -f "$BEST_DER" "$OUT_DER"
echo "Clone RootCA - ERROR: No exact DER-length match found (closest diff=$BEST_DIFF bytes)." >&2
echo "Clone RootCA - The cloned certificate must be exactly $ORIG_LEN bytes to fit the firmware slot." >&2
exit 1
#!/usr/bin/env bash
# ==============================================================================
# Script: clone_chain.sh
# Description: Generates a new Intermediate CA and a Leaf certificate chained to
#              the cloned Root CA. Emulates target attributes and domain endpoints
#              (ingress.tado.com or tanoclo.tado.lan) based on selection.
#
# Arguments:
#   $1 - Endpoint selection type (1 for port 988, 2 for tanoclo, other for default)
# ==============================================================================
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <endpoint_type>" >&2
  exit 1
fi

endpoint_type="$1"

if [[ "$endpoint_type" != 2 ]]; then
  ENDPOINT="ingress.tado.com"
else
  ENDPOINT="tanoclo.tado.lan"
fi

ROOT_CA_DER="tanocloRootCA.der"
ROOT_CA_KEY="tanocloRootCAkey.pem"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "Clone chain - Using RootCA:"
openssl x509 -in "$ROOT_CA_DER" -inform DER -noout -subject -nameopt compat

############################################
# 1) INTERMEDIATE CA
############################################

echo "Clone chain - Creating IntermediateCA…"

# --- Key ---
openssl ecparam -name prime256v1 -genkey -noout -out ingress-intermediate.key

# --- Config with exact DN order ---
cat > "$WORK/intermediate.cnf" <<EOF
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
EOF

# --- CSR ---
openssl req -new \
  -key ingress-intermediate.key \
  -out ingress-intermediate.csr \
  -config "$WORK/intermediate.cnf"

# --- Extensions ---
cat > "$WORK/intermediate_ext.cnf" <<EOF
basicConstraints       = critical,CA:true,pathlen:0
keyUsage               = critical,keyCertSign,cRLSign
subjectKeyIdentifier   = hash
authorityKeyIdentifier = keyid
EOF

# --- Sign with new RootCA ---
openssl x509 -req \
  -in ingress-intermediate.csr \
  -CA "$ROOT_CA_DER" \
  -CAkey "$ROOT_CA_KEY" \
  -CAcreateserial \
  -days 7300 \
  -sha256 \
  -extfile "$WORK/intermediate_ext.cnf" \
  -out ingress-intermediate.pem

# --- Gate: verify DN order ---
echo "Clone chain - Intermediate subject:"
openssl x509 -in ingress-intermediate.pem -noout -subject -nameopt compat

############################################
# 2) LEAF CERT
############################################

echo "Clone chain - Creating $ENDPOINT leaf…"

# --- Key ---
openssl ecparam -name prime256v1 -genkey -noout -out ingress.key

# --- Leaf config ---
printf '%s\n' \
'[ req ]' \
'prompt = no' \
'distinguished_name = dn' \
'req_extensions = v3_req' \
'string_mask = utf8only' \
'preserve = yes' \
'' \
'[ dn ]' \
"0.CN = $ENDPOINT" \
'' \
'[ v3_req ]' \
'subjectAltName = @alt_names' \
'' \
'[ alt_names ]' \
"DNS.1 = $ENDPOINT" \
> "$WORK/leaf.cnf"

# --- CSR ---
openssl req -new \
  -key ingress.key \
  -out ingress.csr \
  -config "$WORK/leaf.cnf"

# --- Leaf extensions ---
printf '%s\n' \
'basicConstraints       = CA:false' \
'keyUsage               = digitalSignature' \
'extendedKeyUsage       = serverAuth' \
'subjectKeyIdentifier   = hash' \
'authorityKeyIdentifier = keyid' \
"subjectAltName         = DNS:$ENDPOINT" \
> "$WORK/leaf_ext.cnf"

# --- Sign with new IntermediateCA ---
openssl x509 -req \
  -in ingress.csr \
  -CA ingress-intermediate.pem \
  -CAkey ingress-intermediate.key \
  -CAcreateserial \
  -days 7300 \
  -sha256 \
  -extfile "$WORK/leaf_ext.cnf" \
  -out ingress.pem

# --- Gate checks ---
echo "Clone chain - Leaf subject:"
openssl x509 -in ingress.pem -noout -subject -nameopt compat

echo "Clone chain - Leaf SAN:"
openssl x509 -in ingress.pem -noout -text | grep -A1 "Subject Alternative Name"
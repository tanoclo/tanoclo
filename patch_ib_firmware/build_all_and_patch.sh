#!/usr/bin/env bash
# ==============================================================================
# Script: build_all_and_patch.sh
# Description: Main certificate generation & firmware patching coordinator.
#              1) Extracts original RootCA from firmware image.
#              2) Clones the RootCA certificate details into a custom Root CA (tanoclo).
#              3) Spawns intermediate and leaf certificates matched to the endpoint.
#              4) Generates server certificates (tanoclo_key.pem / tanoclo_cert.pem).
#              5) Patches the cloned RootCA DER certificate back into the firmware.
#              6) Runs SHA-256 verifications.
#
# Arguments:
#   $1 - Path to unmodified firmware binary
#   $2 - Name of patched firmware output binary
#   $3 - Endpoint type indicator (1 for port 988, 2 for tanoclo, other for default)
#   $4 - Directory path to write output certificate artifacts
# ==============================================================================
set -euo pipefail

if [[ $# -lt 4 || $# -gt 5 ]]; then
  echo "Usage: $0 <unmodified_firmware.bin> <modified_firmware.bin> <endpoint_type> <outdir> [reuse_certs]" >&2
  exit 1
fi

IN_FW="$1"
OUT_FW="$2"
ENDPOINT_TYPE="$3"
OUTDIR="$4"
REUSE_CERTS="${5:-0}"

# ---- Required final scripts ----
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

EXTRACT_SCRIPT="$SCRIPT_DIR/extract_rootca.sh"
ROOT_SCRIPT="$SCRIPT_DIR/clone_rootca.sh"
CHAIN_SCRIPT="$SCRIPT_DIR/clone_chain.sh"
PATCH_SCRIPT="$SCRIPT_DIR/patch_rootca_validate.sh"

for s in "$EXTRACT_SCRIPT" "$ROOT_SCRIPT" "$CHAIN_SCRIPT" "$PATCH_SCRIPT"; do
  [[ -f "$s" ]] || { echo "Build all and patch - ERROR: missing required script: $s" >&2; exit 2; }
  [[ -x "$s" ]] || { echo "Build all and patch - ERROR: script not executable: $s (chmod +x $s)" >&2; exit 3; }
done

[[ -f "$IN_FW" ]] || { echo "Build all and patch - ERROR: firmware not found: $IN_FW" >&2; exit 4; }

mkdir -p "$OUTDIR"
OUTDIR="$(cd "$OUTDIR" && pwd)"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# ---- Standardized outputs ----
ORIG_ROOT_DER="$OUTDIR/tadoRootCA.der"
ORIG_ROOT_PEM="$OUTDIR/tadoRootCA.cer"

ROOT_KEY="$OUTDIR/tanocloRootCAkey.pem"
ROOT_DER="$OUTDIR/tanocloRootCA.der"
ROOT_PEM="$OUTDIR/tanocloRootCA.cer"

INT_KEY="$OUTDIR/ingress-intermediate.key"
INT_PEM="$OUTDIR/ingress-intermediate.pem"

LEAF_KEY="$OUTDIR/ingress.key"
LEAF_PEM="$OUTDIR/ingress.pem"

FULLCHAIN="$OUTDIR/ingress-fullchain.pem"
FULLCHAINKEY="$OUTDIR/tanocloMITM.pem"

PATCHED_FW="$OUTDIR/$OUT_FW"

echo "Build all and patch - Output directory: $OUTDIR"

if [[ "$REUSE_CERTS" -eq 0 ]]; then
  ############################################################
  # 0) Extract original RootCA from firmware
  ############################################################
  echo "Build all and patch - Extracting original RootCA from firmware..."
  "$EXTRACT_SCRIPT" "$IN_FW" "$ORIG_ROOT_DER"

  # Sanity check (size must be 639 bytes)
  ROOT_LEN=$(wc -c < "$ORIG_ROOT_DER" | tr -d ' ')
  if [[ "$ROOT_LEN" -ne 639 ]]; then
    echo "Build all and patch - ERROR: extracted RootCA length is $ROOT_LEN bytes (expected 639)" >&2
    exit 5
  fi

  openssl x509 -in "$ORIG_ROOT_DER" -inform DER -out "$ORIG_ROOT_PEM" -outform PEM

  ############################################################
  # 1) Generate cloned RootCA
  ############################################################
  echo "Build all and patch - Generating cloned RootCA..."
  "$ROOT_SCRIPT" "$ORIG_ROOT_DER" "$ROOT_KEY" "$ROOT_DER"

  # Convert DER → PEM
  openssl x509 -in "$ROOT_DER" -inform DER -out "$ROOT_PEM" -outform PEM

  ############################################################
  # 2) Generate Intermediate + Leaf (final logic)
  ############################################################
  echo "Build all and patch - Generating Intermediate and Leaf certificates..."

  (
    cd "$WORK"

    # Names expected by clone_chain.sh
    cp "$ROOT_DER" tanocloRootCA.der
    cp "$ROOT_KEY" tanocloRootCAkey.pem

    "$CHAIN_SCRIPT" "$ENDPOINT_TYPE"

    # Normalize outputs
    cp ingress-intermediate.pem "$INT_PEM"
    cp ingress-intermediate.key "$INT_KEY"
    cp ingress.pem "$LEAF_PEM"
    cp ingress.key "$LEAF_KEY"

    # Full chain = leaf + intermediate
    cat "$LEAF_PEM" "$INT_PEM" > "$FULLCHAIN"
    cat "$LEAF_KEY" "$FULLCHAIN" > "$FULLCHAINKEY"
  )

  # Server-facing copies for ws-server compatibility
  cp "$LEAF_KEY" "$OUTDIR/tanoclo_key.pem"
  cp "$FULLCHAIN" "$OUTDIR/tanoclo_cert.pem"
else
  echo "Build all and patch - Reusing existing certificates (skipping generation)"
fi

############################################################
# 3) Validate certificate chain (OpenSSL sanity check)
############################################################
echo "Build all and patch - Validating certificate chain with OpenSSL..."
openssl verify -CAfile "$ROOT_PEM" -untrusted "$INT_PEM" "$LEAF_PEM" >/dev/null
echo "Build all and patch - Certificate chain validated"

############################################################
# 4) Patch firmware + validation (final logic)
############################################################
echo "Build all and patch - Patching firmware..."
"$PATCH_SCRIPT" "$IN_FW" "$ROOT_DER" "$PATCHED_FW"

############################################################
# 5) Verify embedded RootCA bytes
############################################################
echo "Build all and patch - Verifying embedded RootCA in patched firmware..."

CERT_OFFSET=$((0x00059FF0))
CERT_LEN=639

PATCH_SHA=$(
  dd if="$PATCHED_FW" bs=1 skip="$CERT_OFFSET" count="$CERT_LEN" status=none \
  | sha256sum | awk '{print $1}'
)
ROOT_SHA=$(sha256sum "$ROOT_DER" | awk '{print $1}')

if [[ "$PATCH_SHA" != "$ROOT_SHA" ]]; then
  echo "Build all and patch - ERROR: embedded RootCA does not match rootca.der" >&2
  exit 6
fi

echo "Build all and patch - Embedded RootCA verified"

############################################################
# Done
############################################################
echo
echo "Build all and patch - Done"
echo "Artifacts:"
echo "  RootCA:"
echo "    DER: $ROOT_DER"
echo "    PEM: $ROOT_PEM"
echo "    KEY: $ROOT_KEY"
echo "  Intermediate:"
echo "    PEM: $INT_PEM"
echo "    KEY: $INT_KEY"
echo "  Leaf:"
echo "    PEM: $LEAF_PEM"
echo "    KEY: $LEAF_KEY"
echo "  Full chain:"
echo "    $FULLCHAIN"
echo "  Full chain with key (for MITM):"
echo "    $FULLCHAINKEY"
echo "  Server certs (for ws-server):"
echo "    $OUTDIR/tanoclo_key.pem"
echo "    $OUTDIR/tanoclo_cert.pem"
echo "  Patched firmware:"
echo "    $PATCHED_FW"
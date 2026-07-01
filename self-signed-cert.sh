#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# self-signed-cert.sh — Generate a self-signed cert for LAN / internal use
#
# Useful when:
#   - You're running on a local network without a public domain
#   - You want to test HTTPS before setting up Let's Encrypt
#   - You're behind a VPN and can't use ACME challenge
#
# Browsers will show a security warning — you'll need to click through once,
# or install the cert as a trusted CA on your devices.
#
# Usage:
#   bash self-signed-cert.sh
# ─────────────────────────────────────────────────────────────────────────────

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CERT_JSON="$SCRIPT_DIR/cert.json"
CERTS_DIR="$SCRIPT_DIR/certs"

BOLD='\033[1m'; GREEN='\033[0;32m'; BLUE='\033[0;34m'; NC='\033[0m'
info()    { echo -e "${BLUE}ℹ${NC}  $*"; }
success() { echo -e "${GREEN}✔${NC}  $*"; }
error()   { echo -e "\033[0;31m✖\033[0m  $*"; exit 1; }

command -v openssl &>/dev/null || error "openssl is required. Install it first."

echo ""
echo -e "${BOLD}  🎙  Podcast Studio — Self-Signed Certificate${NC}"
echo "  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Detect local IPs for SAN
LOCAL_IPS=$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\.' | head -5 || echo "")
HOSTNAME_VAL=$(hostname -f 2>/dev/null || hostname || echo "localhost")

echo "  Detected hostnames/IPs for Subject Alternative Names:"
echo "  - localhost"
echo "  - 127.0.0.1"
echo "  - $HOSTNAME_VAL"
for ip in $LOCAL_IPS; do echo "  - $ip"; done
echo ""

read -rp "  Common Name / primary domain [${HOSTNAME_VAL}]: " CN
CN="${CN:-$HOSTNAME_VAL}"

read -rp "  Validity in days [365]: " DAYS
DAYS="${DAYS:-365}"

mkdir -p "$CERTS_DIR"

KEY_PATH="$CERTS_DIR/privkey.pem"
CERT_PATH="$CERTS_DIR/fullchain.pem"

# Build SAN list
SAN="DNS:localhost,DNS:$CN,IP:127.0.0.1"
for ip in $LOCAL_IPS; do
  [[ "$ip" != "127.0.0.1" ]] && SAN="$SAN,IP:$ip"
done

info "Generating 2048-bit RSA key + self-signed certificate…"
info "  CN=$CN  validity=${DAYS}d"
info "  SAN=$SAN"
echo ""

openssl req -x509 -nodes -newkey rsa:2048 \
  -keyout "$KEY_PATH" \
  -out    "$CERT_PATH" \
  -days   "$DAYS" \
  -subj   "/CN=$CN/O=Podcast Studio/OU=Self-Signed" \
  -addext "subjectAltName=$SAN" \
  2>/dev/null

chmod 600 "$KEY_PATH"
success "Generated: $KEY_PATH"
success "Generated: $CERT_PATH"

# Write cert.json
cat > "$CERT_JSON" <<EOF
{
  "domain":    "$CN",
  "key":       "$KEY_PATH",
  "cert":      "$CERT_PATH",
  "selfSigned": true,
  "createdAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "expiresAt": "$(date -u -d "+${DAYS} days" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u -v +${DAYS}d +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "unknown")"
}
EOF

success "Written: $CERT_JSON"

echo ""
echo -e "${BOLD}  Trusting the certificate (optional but recommended)${NC}"
echo ""
echo "  Chrome/Edge: navigate to https://$CN, click Advanced → Proceed"
echo "  Firefox:     navigate to https://$CN, click Advanced → Accept Risk"
echo ""
echo "  To avoid the warning permanently, install $CERT_PATH"
echo "  as a trusted CA on each device:"
echo "    macOS:   Keychain Access → import → set to Always Trust"
echo "    Windows: certmgr.msc → Trusted Root Certification Authorities"
echo "    iOS:     Settings → Profile Downloaded → Install"
echo "    Android: Settings → Security → Install from storage"
echo ""
echo -e "${BOLD}  Start the server:${NC}"
echo "    HTTPS_PORT=3443 npm start   (port 3443 avoids needing sudo)"
echo "    sudo npm start              (uses port 443)"
echo ""
info "  WebRTC will work on this device and on other devices that"
info "  have accepted the certificate warning (or installed the CA)."
echo ""

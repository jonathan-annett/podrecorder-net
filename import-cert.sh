#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# import-cert.sh — Manually point Podcast Studio at existing cert files
#
# Use this if you already have a certificate from:
#   - A wildcard cert from your hosting provider
#   - Another ACME CA (ZeroSSL, Buypass, etc.)
#   - A self-signed cert for internal/LAN use
#   - A cert managed by Nginx/Caddy/Apache that you want to share
#
# Usage:
#   bash import-cert.sh /path/to/privkey.pem /path/to/fullchain.pem
#   bash import-cert.sh          (interactive mode)
# ─────────────────────────────────────────────────────────────────────────────

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CERT_JSON="$SCRIPT_DIR/cert.json"

BOLD='\033[1m'; GREEN='\033[0;32m'; RED='\033[0;31m'
BLUE='\033[0;34m'; YELLOW='\033[1;33m'; NC='\033[0m'

info()    { echo -e "${BLUE}ℹ${NC}  $*"; }
success() { echo -e "${GREEN}✔${NC}  $*"; }
warn()    { echo -e "${YELLOW}⚠${NC}  $*"; }
error()   { echo -e "${RED}✖${NC}  $*"; exit 1; }

echo ""
echo -e "${BOLD}  🎙  Podcast Studio — Manual Certificate Import${NC}"
echo "  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ── Args or interactive ───────────────────────────────────────────────────────
KEY_PATH="${1:-}"
CERT_PATH="${2:-}"

if [[ -z "$KEY_PATH" ]]; then
  read -rp "  Path to private key  (privkey.pem): " KEY_PATH
fi
if [[ -z "$CERT_PATH" ]]; then
  read -rp "  Path to certificate  (fullchain.pem): " CERT_PATH
fi

KEY_PATH="${KEY_PATH//\'/}"
CERT_PATH="${CERT_PATH//\'/}"

# ── Validate files ────────────────────────────────────────────────────────────
[[ -f "$KEY_PATH"  ]] || error "Key file not found:  $KEY_PATH"
[[ -f "$CERT_PATH" ]] || error "Cert file not found: $CERT_PATH"

# Basic PEM sanity check
grep -q "PRIVATE KEY" "$KEY_PATH"  || warn "Key file doesn't look like a PEM private key."
grep -q "CERTIFICATE" "$CERT_PATH" || warn "Cert file doesn't look like a PEM certificate."

# ── Verify key matches cert (openssl) ─────────────────────────────────────────
if command -v openssl &>/dev/null; then
  info "Verifying key/cert pair…"
  KEY_MOD=$(openssl rsa -noout -modulus -in "$KEY_PATH" 2>/dev/null | md5sum || \
            openssl ec  -noout -text    -in "$KEY_PATH" 2>/dev/null | md5sum || echo "skip")
  CRT_MOD=$(openssl x509 -noout -modulus -in "$CERT_PATH" 2>/dev/null | md5sum || echo "skip2")

  if [[ "$KEY_MOD" != "skip" ]] && [[ "$CRT_MOD" != "skip2" ]]; then
    if [[ "$KEY_MOD" == "$CRT_MOD" ]]; then
      success "Key and certificate match."
    else
      warn "Key modulus doesn't match certificate. They may be mismatched."
      read -rp "  Continue anyway? [y/N] " CONT
      [[ "$CONT" =~ ^[Yy]$ ]] || exit 0
    fi
  fi

  # Print cert info
  echo ""
  info "Certificate details:"
  openssl x509 -noout -subject -issuer -dates -in "$CERT_PATH" 2>/dev/null \
    | sed 's/^/     /' || true

  # Expiry warning
  EXPIRY=$(openssl x509 -noout -enddate -in "$CERT_PATH" 2>/dev/null \
    | cut -d= -f2 || echo "")
  if [[ -n "$EXPIRY" ]]; then
    EXPIRY_EPOCH=$(date -d "$EXPIRY" +%s 2>/dev/null || date -j -f "%b %d %T %Y %Z" "$EXPIRY" +%s 2>/dev/null || echo 0)
    NOW_EPOCH=$(date +%s)
    DAYS_LEFT=$(( (EXPIRY_EPOCH - NOW_EPOCH) / 86400 ))
    if   [[ $DAYS_LEFT -le 0  ]]; then error "Certificate has EXPIRED ($EXPIRY)."
    elif [[ $DAYS_LEFT -le 14 ]]; then warn  "Certificate expires in $DAYS_LEFT days ($EXPIRY)."
    else success "Certificate valid for $DAYS_LEFT more days."
    fi
  fi
else
  warn "openssl not found — skipping key/cert validation."
fi

# ── Resolve absolute paths ────────────────────────────────────────────────────
KEY_PATH="$(cd "$(dirname "$KEY_PATH")"  && pwd)/$(basename "$KEY_PATH")"
CERT_PATH="$(cd "$(dirname "$CERT_PATH")" && pwd)/$(basename "$CERT_PATH")"

# ── Detect domain from cert CN ────────────────────────────────────────────────
DOMAIN=""
if command -v openssl &>/dev/null; then
  DOMAIN=$(openssl x509 -noout -subject -in "$CERT_PATH" 2>/dev/null \
    | grep -oP '(?<=CN\s=\s)[^\s,]+' || \
    openssl x509 -noout -subject -in "$CERT_PATH" 2>/dev/null \
    | sed 's/.*CN=\([^,/]*\).*/\1/' || echo "")
fi

# ── Write cert.json ───────────────────────────────────────────────────────────
echo ""
cat > "$CERT_JSON" <<EOF
{
  "domain":     "${DOMAIN:-unknown}",
  "key":        "$KEY_PATH",
  "cert":       "$CERT_PATH",
  "importedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
}
EOF

success "Written: $CERT_JSON"

# ── Self-signed helper ────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}  Next steps${NC}"
info "  Restart the server (or start it if not running):"
echo "    ${BOLD}sudo npm start${NC}      (sudo for ports 80/443)"
echo "    ${BOLD}HTTPS_PORT=3443 npm start${NC}  (non-privileged port)"
echo ""
info "  The server watches $CERT_PATH and reloads certs automatically"
info "  when the file changes — no restart needed on renewal."
echo ""

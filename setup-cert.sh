#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# setup-cert.sh — Obtain or renew a Let's Encrypt cert for Podcast Studio
#
# Usage:
#   sudo bash setup-cert.sh
#
# What it does:
#   1. Checks certbot is installed (offers to install if not)
#   2. Asks for your domain name
#   3. Runs certbot in standalone mode (briefly binds port 80)
#   4. Writes cert.json pointing at the live cert files
#   5. Installs a cron job for auto-renewal
#
# Requirements:
#   - Root / sudo access
#   - Port 80 reachable from the internet (temporarily — certbot only)
#   - A DNS A record for your domain pointing at this machine
#
# After running:
#   npm start        (or restart your existing process)
#   The server reads cert.json on startup and switches to HTTPS automatically.
#   Cert renewal is automatic via cron; the server reloads certs without restart.
# ─────────────────────────────────────────────────────────────────────────────

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CERT_JSON="$SCRIPT_DIR/cert.json"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; NC='\033[0m'

info()    { echo -e "${BLUE}ℹ${NC}  $*"; }
success() { echo -e "${GREEN}✔${NC}  $*"; }
warn()    { echo -e "${YELLOW}⚠${NC}  $*"; }
error()   { echo -e "${RED}✖${NC}  $*"; exit 1; }

echo ""
echo -e "${BOLD}  🎙  Podcast Studio — TLS Certificate Setup${NC}"
echo "  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ── Root check ────────────────────────────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
  error "Please run as root: sudo bash setup-cert.sh"
fi

# ── certbot check / install ───────────────────────────────────────────────────
if ! command -v certbot &>/dev/null; then
  warn "certbot is not installed."
  read -rp "  Install it now? (apt/snap) [y/N] " INSTALL
  if [[ "$INSTALL" =~ ^[Yy]$ ]]; then
    if command -v apt-get &>/dev/null; then
      info "Installing certbot via apt…"
      apt-get update -qq
      apt-get install -y certbot
    elif command -v snap &>/dev/null; then
      info "Installing certbot via snap…"
      snap install --classic certbot
      ln -sf /snap/bin/certbot /usr/local/bin/certbot
    else
      error "Neither apt nor snap found. Install certbot manually: https://certbot.eff.org"
    fi
    success "certbot installed."
  else
    error "certbot is required. Exiting."
  fi
fi

CERTBOT_VERSION=$(certbot --version 2>&1)
success "Found $CERTBOT_VERSION"

# ── Domain ────────────────────────────────────────────────────────────────────
echo ""
read -rp "  Enter your domain name (e.g. studio.example.com): " DOMAIN
DOMAIN="${DOMAIN// /}"
[[ -z "$DOMAIN" ]] && error "Domain cannot be empty."

echo ""
read -rp "  Email address for Let's Encrypt expiry notices: " EMAIL
EMAIL="${EMAIL// /}"
[[ -z "$EMAIL" ]] && error "Email cannot be empty."

# ── Port 80 availability ──────────────────────────────────────────────────────
echo ""
info "Checking if port 80 is free…"
HTTPS_PORT="${HTTPS_PORT:-443}"
HTTP_PORT="${HTTP_PORT:-80}"

if ss -tlnp 2>/dev/null | grep -q ":${HTTP_PORT} " || \
   netstat -tlnp 2>/dev/null | grep -q ":${HTTP_PORT} "; then
  warn "Port $HTTP_PORT appears to be in use."
  warn "certbot standalone mode needs port 80 briefly. Stop whatever is using it,"
  warn "or use the --webroot or --nginx/--apache plugins instead."
  read -rp "  Continue anyway? [y/N] " CONT
  [[ "$CONT" =~ ^[Yy]$ ]] || exit 0
fi

# ── Request certificate ───────────────────────────────────────────────────────
echo ""
info "Requesting certificate for ${BOLD}$DOMAIN${NC}…"
echo "  (certbot will briefly bind port 80 to verify domain ownership)"
echo ""

certbot certonly \
  --standalone \
  --non-interactive \
  --agree-tos \
  --email "$EMAIL" \
  --domains "$DOMAIN" \
  --http-01-port 80

LIVE_DIR="/etc/letsencrypt/live/$DOMAIN"
KEY_PATH="$LIVE_DIR/privkey.pem"
CERT_PATH="$LIVE_DIR/fullchain.pem"

if [[ ! -f "$KEY_PATH" ]] || [[ ! -f "$CERT_PATH" ]]; then
  error "Cert files not found at $LIVE_DIR — certbot may have failed."
fi

success "Certificate obtained!"
info "  Key:  $KEY_PATH"
info "  Cert: $CERT_PATH"

# ── Write cert.json ───────────────────────────────────────────────────────────
cat > "$CERT_JSON" <<EOF
{
  "domain":    "$DOMAIN",
  "key":       "$KEY_PATH",
  "cert":      "$CERT_PATH",
  "obtainedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
}
EOF

success "Written: $CERT_JSON"

# ── Cron for auto-renewal ─────────────────────────────────────────────────────
# certbot renew runs twice daily by default when installed via snap/apt.
# We add a post-hook that touches fullchain.pem after successful renewal —
# the server's fs.watchFile picks this up and reloads certs without restart.

RENEW_HOOK_DIR="/etc/letsencrypt/renewal-hooks/post"
RENEW_HOOK="$RENEW_HOOK_DIR/podcast-studio-reload.sh"

mkdir -p "$RENEW_HOOK_DIR"
cat > "$RENEW_HOOK" <<'HOOK'
#!/usr/bin/env bash
# Post-renewal hook: touch fullchain.pem so podcast-studio server picks up new certs.
# The server watches this file and calls setSecureContext() — no restart needed.
DOMAIN=$(ls /etc/letsencrypt/live/ | head -1)
touch "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" 2>/dev/null || true
echo "[$(date)] Podcast Studio: cert reload triggered" >> /var/log/podcast-studio-cert.log
HOOK
chmod +x "$RENEW_HOOK"
success "Renewal post-hook installed: $RENEW_HOOK"

# Ensure certbot timer/cron exists
if systemctl is-active --quiet certbot.timer 2>/dev/null; then
  success "certbot.timer is active (renewal is automatic)"
elif crontab -l 2>/dev/null | grep -q certbot; then
  success "certbot cron entry found (renewal is automatic)"
else
  warn "No certbot timer or cron found. Adding a cron entry…"
  (crontab -l 2>/dev/null; echo "0 3 * * * certbot renew --quiet") | crontab -
  success "Cron entry added (runs daily at 03:00)"
fi

# ── Optional: HTTPS_PORT env ──────────────────────────────────────────────────
echo ""
echo -e "${BOLD}  Ports${NC}"
info "  The server defaults to HTTPS on port 443 and HTTP redirect on port 80."
info "  Override with env vars: HTTPS_PORT=8443 HTTP_PORT=8080 npm start"

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}  ✔ Done!${NC}"
echo ""
echo "  Start (or restart) the server:"
echo "    ${BOLD}sudo npm start${NC}      (sudo needed for ports 80/443)"
echo "    ${BOLD}sudo node server.js${NC}"
echo ""
echo "  Your studio will be available at:"
echo -e "    ${BOLD}https://$DOMAIN${NC}"
echo ""
echo "  Certs auto-renew every ~60 days."
echo "  The server reloads them live — no restart needed."
echo ""

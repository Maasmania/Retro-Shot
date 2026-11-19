#!/bin/bash
# Retro Shot server: install or update. Run as root on Ubuntu:
#   curl -fsSL https://raw.githubusercontent.com/Maasmania/Retro-Shot/main/setup.sh | bash
set -e
SRC=https://raw.githubusercontent.com/Maasmania/Retro-Shot/main
echo "== Retro Shot server setup =="
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  echo "-- installing Node.js"; apt-get update -y -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs npm
fi
id retroshot >/dev/null 2>&1 || useradd --system --home /opt/retroshot --shell /usr/sbin/nologin retroshot
mkdir -p /opt/retroshot
echo "-- downloading the server"
curl -fsSL "$SRC/server.js" -o /opt/retroshot/server.js
curl -fsSL "$SRC/package.json" -o /opt/retroshot/package.json
cd /opt/retroshot && npm install --omit=dev --no-audit --no-fund --loglevel=error
chown -R retroshot:retroshot /opt/retroshot
cat > /etc/systemd/system/retroshot.service <<'UNIT'
[Unit]
Description=Retro Shot game server
After=network-online.target
[Service]
User=retroshot
WorkingDirectory=/opt/retroshot
ExecStart=/usr/bin/env node server.js
Environment=PORT=7777
Restart=always
RestartSec=2
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable retroshot >/dev/null 2>&1
systemctl restart retroshot
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then ufw allow 7777/tcp >/dev/null; fi
sleep 2
if curl -fs http://localhost:7777 >/dev/null; then echo "== Retro Shot server is running on port 7777 =="; curl -s http://localhost:7777; else echo "!! server did not start:"; journalctl -u retroshot -n 20 --no-pager; fi

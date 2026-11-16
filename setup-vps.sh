#!/bin/bash
set -e

echo "=== [1/5] Setting up Caddy Reverse Proxy ==="
docker network create dilly-net 2>/dev/null || true
docker rm -f dilly-caddy 2>/dev/null || true

cat << 'CADDYEOF' > /opt/dilly/Caddyfile
{
  admin 0.0.0.0:2019
}
:80 {
  respond "Dilly Caddy Ready"
}
CADDYEOF

docker run -d \
  --name dilly-caddy \
  --network dilly-net \
  --restart unless-stopped \
  -p 127.0.0.1:2019:2019 \
  -p 8080:80 \
  -v /opt/dilly/Caddyfile:/etc/caddy/Caddyfile \
  caddy:2-alpine

echo "=== [2/5] Configuring server environment ==="
JWT_KEY=$(openssl rand -hex 32)
cat << ENVEOF > /opt/dilly/server/.env
PORT=3000
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/dilly
JWT_SECRET=${JWT_KEY}
CADDY_API_URL=http://127.0.0.1:2019
DATA_DIR=/opt/dilly/.dilly_data
NODE_ENV=production
ENVEOF

echo "=== [3/5] Installing dependencies and building ==="
cd /opt/dilly
bun install
bun run --filter web build

echo "=== [4/5] Running Drizzle database migrations ==="
cd /opt/dilly/server
bun run db:push

echo "=== [5/5] Configuring and starting systemd service ==="
cat << 'SYSEOF' > /etc/systemd/system/dilly.service
[Unit]
Description=Dilly PaaS Engine
After=network.target docker.service

[Service]
Type=simple
User=root
WorkingDirectory=/opt/dilly/server
ExecStart=/usr/local/bin/bun src/index.ts
Restart=always
RestartSec=5
EnvironmentFile=/opt/dilly/server/.env

[Install]
WantedBy=multi-user.target
SYSEOF

systemctl daemon-reload
systemctl enable dilly
systemctl restart dilly

sleep 3
echo "Checking service status..."
systemctl status dilly --no-pager

echo "=== Dilly installed and running on http://127.0.0.1:3000 ==="

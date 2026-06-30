# zterm-relay-server

ZTerm traversal relay server. This is the public control-plane service for account login, device presence, WebSocket signaling, and TURN credential delivery.

This package is intentionally separate from the Mac daemon package. The daemon runs on user Macs; this relay server runs on a public server such as Claw.

## Install

```bash
npm install -g @jsonstudio/zterm-relay-server
```

## Runtime env

All production configuration must come from environment variables or a secret manager:

```bash
export ZTERM_TRAVERSAL_HOST=127.0.0.1
export ZTERM_TRAVERSAL_PORT=19090
export ZTERM_TRAVERSAL_BASE_PATH=/relay
export ZTERM_TRAVERSAL_STORE_PATH=/var/lib/zterm-relay/store.json
export ZTERM_TURN_URL='turn:claw.codewhisper.cc:3479?transport=udp'
export ZTERM_TURN_USERNAME='<secret>'
export ZTERM_TURN_CREDENTIAL='<secret>'
zterm-relay-server
```

Do not put test account passwords or TURN credentials in the package or repository.

## Smoke

```bash
zterm-relay-server smoke --base-url https://claw.codewhisper.cc:18443/relay/
RELAY_USERNAME=zterm-relay-smoke RELAY_PASSWORD='<secret>' \
  zterm-relay-server smoke --base-url https://claw.codewhisper.cc:18443/relay/
```

The smoke command redacts access tokens and TURN credentials.

## systemd example

```ini
[Unit]
Description=ZTerm Relay Server
After=network.target

[Service]
EnvironmentFile=/etc/zterm-relay/server.env
ExecStart=/usr/bin/env zterm-relay-server
Restart=always
RestartSec=5
User=zterm-relay
Group=zterm-relay

[Install]
WantedBy=multi-user.target
```

## nginx upstream sketch

Public TLS and path routing should stay in the reverse proxy:

```nginx
location /relay/ {
  proxy_pass http://127.0.0.1:19090/relay/;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Host $host;
  proxy_set_header X-Forwarded-Proto https;
}
```

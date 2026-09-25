# Static web app served by Caddy. Railway injects $PORT.
FROM caddy:2.8-alpine
COPY Caddyfile /etc/caddy/Caddyfile
COPY web /srv

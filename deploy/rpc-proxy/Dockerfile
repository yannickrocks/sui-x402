# Header-injecting gRPC-Web proxy — see Caddyfile and README.md.
FROM caddy:2-alpine

COPY Caddyfile /etc/caddy/Caddyfile

# Railway injects PORT; the Caddyfile defaults to 8080 elsewhere.
EXPOSE 8080

CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]

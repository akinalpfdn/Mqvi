# Caddy: real client IP behind Cloudflare

Behind Cloudflare, Caddy forwards Cloudflare's address instead of the user's. The devices screen
shows the wrong IP and city, and IP rate limits treat everyone on the same Cloudflare PoP as one
client. Not behind Cloudflare? Skip this.

Needs Caddy 2.7+. Ubuntu's own package is 2.6.2 and rejects `trusted_proxies`; install from
[Caddy's apt repo](https://caddyserver.com/docs/install#debian-ubuntu-raspbian). The upgrade restarts
Caddy, so the Caddyfile must be valid before you upgrade. Edit `/etc/caddy/Caddyfile` on the server:

```caddy
{
	servers {
		# Cloudflare ranges: https://www.cloudflare.com/ips/
		trusted_proxies static 173.245.48.0/20 103.21.244.0/22 103.22.200.0/22 103.31.4.0/22 141.101.64.0/18 108.162.192.0/18 190.93.240.0/20 188.114.96.0/20 197.234.240.0/22 198.41.128.0/17 162.158.0.0/15 104.16.0.0/13 104.24.0.0/14 172.64.0.0/13 131.0.72.0/22 2400:cb00::/32 2606:4700::/32 2803:f800::/32 2405:b500::/32 2405:8100::/32 2a06:98c0::/29 2c0f:f248::/32
		client_ip_headers CF-Connecting-IP
	}
}

your.domain {
	reverse_proxy localhost:9090 {
		# Overwrite, don't append: the forwarded chain starts with whatever the client sent.
		header_up X-Forwarded-For {client_ip}
	}
}
```

Requests that bypass Cloudflare are not trusted, so a forged `CF-Connecting-IP` is ignored.

```bash
caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy
```

Check: sign in again; Settings → Security → Active devices shows your own IP and city.

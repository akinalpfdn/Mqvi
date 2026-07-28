# Caddy: hold requests during the deploy swap (no 502)

Step 1's reorder already shrinks the outage to the ~2–5s the server takes to stop, swap and boot.
For the HTTP side of that window, one directive on the `reverse_proxy` makes Caddy **wait for the
server to come back instead of returning a 502** to whoever hit it mid-swap.

The Caddyfile lives on the server at `/etc/caddy/Caddyfile` (not in this repo). It is not secret,
but it carries the real domain, so it stays on the box. Apply this by hand.

## What to change

Find the `reverse_proxy` that points at mqvi-server (the upstream is the internal port, e.g.
`localhost:9090`) and add the `lb_try_duration` / `lb_try_interval` lines:

```caddy
reverse_proxy localhost:9090 {
    # During a deploy the upstream is briefly unreachable while it stops and reboots. Keep trying
    # to reach it for up to 15s, re-attempting every 300ms, instead of returning a 502. A request
    # that arrives mid-swap simply waits a beat and succeeds once the new process is listening.
    lb_try_duration 15s
    lb_try_interval 300ms
}
```

`lb_try_duration` must comfortably exceed the real swap time (stop ≤ `TimeoutStopSec` 15s in the
worst case, then boot + migrations). 15s covers a normal deploy; a genuinely stuck stop would blow
past it, which is correct — you *want* a 502 rather than a 30s hang if the server truly wedged.

Only requests whose connection fails *before* any bytes are sent are retried (a refused dial during
the restart) — Caddy will not replay a request it already started forwarding, so this is safe for
non-idempotent calls too.

## Apply

```bash
sudoedit /etc/caddy/Caddyfile      # add the two lines inside the mqvi reverse_proxy block
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
```

## Note on the request-body limit

`start.sh` / `prestart.sh` already `sed` the `max_size` in this same block to match
`UPLOAD_MAX_SIZE`, and only touch a Caddyfile marked `# managed by mqvi`. Adding these two lines
does not interfere with that — they live in the same `reverse_proxy` block and are left alone by
the max_size sed.
```

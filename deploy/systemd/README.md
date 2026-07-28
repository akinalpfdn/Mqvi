# systemd deployment (root / ~/mqvi layout)

These units put the maintainer's existing `root@host:~/mqvi` deployment onto systemd, for
**crash-restart and reboot survival** — without moving any data. They keep running as root at
`/root/mqvi`, exactly as the nohup setup did.

This is deliberately *not* the hardened install. `install.sh` builds hardened units under
`/opt/mqvi` with a dedicated `mqvi` user (`ProtectSystem=strict`, `NoNewPrivileges`, …). Converging
this box onto that model is a separate, rehearsed migration — those directives cannot apply here
because `WorkingDirectory` lives under `/root`, which `ProtectHome` would hide.

## Files

| File | Where it ends up | Role |
|---|---|---|
| `mqvi-server.service` | `/etc/systemd/system/` | the backend; `Restart=on-failure`, `TimeoutStopSec=15` |
| `mqvi-livekit.service` | `/etc/systemd/system/` | local SFU; inactive where there is no `livekit.yaml` (prod) |
| `prestart.sh` | `/root/mqvi/` | `ExecStartPre`: start clamav, sync Caddy's max_size. Never installs, always exits 0 |
| `bootstrap.sh` | `/root/mqvi/` | one-time: download LiveKit (if local), install clamav, make data dirs |
| `install-units.sh` | run once on the box | installs the above and cuts over from nohup |

## One-time setup (rehearse on staging first)

```bash
# from your machine
scp -r deploy/systemd root@STAGING:~/mqvi/systemd
ssh root@STAGING "cd ~/mqvi/systemd && ./install-units.sh"
# verify, watch it survive a reboot, THEN do prod the same way
```

`install-units.sh` stops the running nohup instance before systemd starts, so the two never
overlap. It moves no data and rewrites no paths — the old binary and `.env` stay put, so rollback
is immediate.

## After setup, deploys use systemctl

Once the units are installed, `redeploy-prod.ps1` / `redeploy.ps1` stop and start via
`systemctl` instead of `pkill`/`nohup`. The staged-binary swap and the live database backup are
unchanged.

## Rollback to nohup

```bash
systemctl disable --now mqvi-server.service mqvi-livekit.service
cd /root/mqvi && nohup ./start.sh > output.log 2>&1 &
```

`start.sh` is left in place precisely so this always works.

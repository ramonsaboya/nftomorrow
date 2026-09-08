# Operations

## Installed layout

DigitalOcean Ubuntu 24.04, dedicated non-root `nftomorrow` service user. The selected 512 MB Droplet has 1 GB swap. Node.js 24.20.0 comes from the official Linux archive with a verified SHA-256 checksum. SSH-key access works; UFW permits SSH and denies other inbound traffic. Unattended security updates are enabled. No inbound application port is required.

- `/opt/nftomorrow`: root-owned application and pinned dependencies.
- `/opt/node-v24.20.0`: Node installation, linked from `/usr/local/bin`.
- `/etc/nftomorrow/config.json`: root-owned private group and policy configuration, readable by the service group.
- `/etc/nftomorrow/environment`: root-only environment file read by systemd; API and Healthchecks secrets.
- `/var/lib/nftomorrow`: service-owned SQLite state, mode 0700; files mode 0600.
- `/etc/systemd/system/nftomorrow.service`: non-root, restricted service, enabled at boot and restarted on failure.

Journald storage is capped at 100 MB and retention at 14 days on this dedicated host. Check memory pressure before adding workloads. Node's V8 old-space limit is 192 MB; this does not cap total process/native memory.

## Service commands

For current NFT prices, send `/status` from another WhatsApp account in the configured group while the service is connected. It fetches fresh prices and replies in that group. Allow one minute between requests. This is a price command; use the administrator commands below for process health. Commands sent while offline are not replayed after reconnect.

The feature branch also supports `/sticker-test` in the configured group or a one-to-one chat with the bot for one fixed native sticker reply in the same chat, with a separate one-minute cooldown per chat. See [prototype test/deployment instructions](sticker-prototype.md) and [validation](validation.md) for its live activation state.

The GPT Image 2 feature adds `/sticker <prompt>` using the source reference photo. Configure its separate API key and daily limit using [image sticker setup](image-stickers.md). API work is bounded and runs independently of the monitor. Its live activation state is separate from the fixed sticker prototype.

Run through SSH as the server administrator:

```sh
systemctl status nftomorrow --no-pager
journalctl -u nftomorrow -n 40 --no-pager
systemctl restart nftomorrow
```

For pairing, group discovery or an intentional test, stop the service first. Never run the same credentials concurrently on the Mac and server.

```sh
systemctl stop nftomorrow
sudo -u nftomorrow env CONFIG_PATH=/etc/nftomorrow/config.json DATA_DIR=/var/lib/nftomorrow /usr/local/bin/node /opt/nftomorrow/src/cli.js pair
sudo -u nftomorrow env CONFIG_PATH=/etc/nftomorrow/config.json DATA_DIR=/var/lib/nftomorrow /usr/local/bin/node /opt/nftomorrow/src/cli.js groups
systemctl start nftomorrow
```

`pair` replaces unusable authentication when a persistent logout is recorded, keeping price and delivery records. For a one-message test, use `send-test` in place of `groups`. Commands above use public FX access; provide the configured API key through a private environment if your provider requires it. Do not copy the credential database, QR output or private environment into chat or Git.

## Healthchecks email — next setup step

Create three checks at [Healthchecks.io](https://healthchecks.io/), attach and verify the operator's email, and put the secret ping URLs in `/etc/nftomorrow/environment`:

| Variable | Behavior | Period / grace |
| --- | --- | --- |
| `HEALTHCHECK_PRICES_URL` | Success after complete fresh price/FX checks, failure otherwise | 1 hour / 10 minutes |
| `HEALTHCHECK_WHATSAPP_URL` | Heartbeat while connected; immediate failure for logout or uncertain delivery | 1 minute / 10 minutes |
| `HEALTHCHECK_PROCESS_URL` | Main-loop heartbeat | 1 minute / 5 minutes |

Restart the service after editing. When disconnected temporarily, WhatsApp success pings stop; the grace period triggers the notification. A persistent logout sends `/fail` immediately when networking permits. Name that check “NFTomorrow WhatsApp: reconnect or re-pair required”. If all networking is lost, external missing-heartbeat detection covers the outage. HTTP ping failures are logged without exposing URLs.

Do a deliberate failure/recovery test of each check and confirm actual email receipt. This integration is **not active until URLs and verified email notifications are configured**. The [ping API](https://healthchecks.io/docs/http_api/) does the email delivery, so no SMTP credentials are needed.

## Backup and restore

Code and lockfile live in Git. Back up the private configuration and SQLite state in encrypted, access-controlled storage. A state backup contains account credentials. No off-server backup destination has been configured yet.

For a simple consistent backup, stop the service before copying its state directory and private configuration, then restart it. Include any WAL/SHM files. Never copy only a live SQLite database. Alternatively use Node's SQLite backup API while holding the application's instance lock; the initial transfer used that API.

To restore: stop the original instance, install the same application/dependency versions on the replacement host, restore state/config, set ownership and modes, verify locally, then start just one instance. If WhatsApp rejects a restored session, stop the service and explicitly re-pair. A stale backup can lack recent delivery attempts; review that before resuming sends.

## Updates

Use the published Git commit and `package-lock.json`. Stage and verify the code before stopping the service. Install with `npm ci --include=optional`: Sharp requires its platform-specific binary packages. `npm run verify` runs tests serially to limit test-process memory. Keep secrets/state outside the release directory. Stop the sole service, retain the prior code release for rollback, swap code and restart. A code-only update without schema changes keeps the existing session/state in place; do not transfer or restore old session keys. After deployment verify the configured group, price checks, connection status and memory; do not treat a send acknowledgement as a recipient notification.

## Outstanding acceptance

Verify reboot recovery, a restoration, a full live daily cycle including overnight conditions, email notifications and actual phone notifications. Automated tests cover scheduling, restart persistence and disconnection semantics but cannot establish those live outcomes.

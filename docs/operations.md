# Operations plan — deployment pending

This is a runbook outline for the completed service. Do not configure systemd to run the current `check` command as if it were a continuous monitor. The runtime and unit file will follow confirmation of the alert rules.

## Linux host

Use a small Linux VPS with SSH-key access, an unprivileged `nftomorrow` service account, a firewall allowing only necessary SSH access, and automatic security updates. No inbound application port is needed. Check provider prices and location availability before purchasing; DigitalOcean has been selected and SSH access to an Ubuntu 24.04 Droplet has been verified. Node.js and the service are not yet installed.

Planned paths:

- `/opt/nftomorrow`: root-owned application release and pinned dependencies.
- `/etc/nftomorrow/config.json`: private group, currencies, thresholds and approved policy.
- `/etc/nftomorrow/environment`: mode 0600; API and Healthchecks secrets.
- `/var/lib/nftomorrow`: service-owned state directory, mode 0700.

Use systemd with `User=nftomorrow`, `UMask=0077`, `Restart=on-failure`, `StateDirectory=nftomorrow`, `NoNewPrivileges=true`, `ProtectSystem=strict`, `ProtectHome=true`, and `PrivateTmp=true`. Allow writes only to the state directory. Use a pinned Node 24 executable available to the service, not an interactive shell's version-manager path. Enable the completed unit for reboot startup. Logs go to journald; set storage/retention limits appropriate for the dedicated host, such as a 100 MB cap and 14-day retention. Never enable verbose Baileys logging on the service.

## Healthchecks email

Create three checks at [Healthchecks.io](https://healthchecks.io/), attach and verify the operator's email, and place each secret ping URL in its corresponding environment variable:

| Variable | Intended service behavior | Suggested period / grace |
| --- | --- | --- |
| `HEALTHCHECK_PRICES_URL` | Success after complete fresh price/required FX checks, failure otherwise | 1 hour / 10 minutes |
| `HEALTHCHECK_WHATSAPP_URL` | Heartbeat while connected; immediate failure for logout; no success while disconnected | 1 minute / 10 minutes |
| `HEALTHCHECK_PROCESS_URL` | Regular main-loop heartbeat independent of WhatsApp | 1 minute / 5 minutes |

The HTTP helper implements success and `/fail` pings without logging tokens. **Runtime wiring and real email verification remain pending.** Healthchecks performs email delivery; the application does not need SMTP credentials. Configure descriptive check names so the WhatsApp check says that re-pairing or connection investigation is needed. Network loss can prevent failure pings; the external missing-heartbeat deadline covers that case. Consult the [ping API](https://healthchecks.io/docs/http_api/) and test both failure and recovery notifications before relying on it.

## Backup and restore

Keep code and its lockfile in Git. Keep private configuration and the entire SQLite state outside Git in encrypted, access-controlled backups. The state includes account credentials; a backup grants access to the bot. Provider disk backups alone do not establish a successful application restore.

For a simple consistent backup, stop the service before copying its state directory and private configuration, then restart it. Include SQLite WAL/SHM files if present; never copy only a live database file. Do not archive pairing QR output. A future online backup command can use SQLite's backup API if uninterrupted monitoring is needed.

To restore: stop the original instance, install the same application/dependency versions on the replacement host, restore configuration and all state, set ownership and private modes, verify data locally, then start one instance. Never run the same WhatsApp identity concurrently from a restored backup and the original server. A restored session can be invalid; if so, stop the service and run the interactive `pair` command under its account. Explicit re-pairing replaces only unusable authentication and keeps price and delivery data.

Verify price checks, group identity, Healthchecks and actual recipient delivery after any restore. A stale backup can lack recent delivery records, so review potential duplicate alerts before resuming sending.

## Live acceptance still required

After the policy and runtime are complete, obtain server authorization, the activated bot account, exact group, thresholds, currencies, summary time and operator email. Verify one explicitly authorized group message on a recipient device. Observe a complete daily cycle, overnight threshold behavior, timezone behavior, reconnection and a reboot. Test logout/re-pairing deliberately with the owner present. A Baileys acknowledgement is not evidence of a recipient notification.

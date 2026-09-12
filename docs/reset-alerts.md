# Tibo reset alerts

Set `resetAlerts: true` in the existing private configuration. Exactly one phone
account must appear in `stickerOwnerJids`; its matching LID may also be present.
Alerts go only to that phone's private chat. The WhatsApp transport independently
checks the allowlist and rejects group destinations. The setting defaults off.

The existing service checks every five minutes, in a background task alongside
NFT checks and sticker jobs, without a second WhatsApp connection or AI API calls.
It reads Tibo's recent public posts through TwiScan and the status/history APIs at
Codex Resets. These are third-party feeds and may lag or omit posts. Recent-post
coverage is limited to the page returned by TwiScan; the tracker covers up to 100
recent entries. This is not a guaranteed complete X timeline or five-minute SLA.

Filtering deliberately favors recall: reset spelling variants, banked credits,
usage/rate limits, fresh usage, button presses, milestones, celebrations and
rollout wording match. Short replies mentioning yes, done, tomorrow, soon and
similar terms also match, even without parent context. False positives are
expected and accepted. Alerts have a neutral title, a short excerpt, London
publication time and a canonical link to Tibo's original X post. A notification
does not assert that the recipient's account received a reset.

The first activation saves a cutoff and skips earlier posts. The same post ID
is sent once across sources, polls and restarts. Separate follow-ups and edited
post IDs can each alert. New matching posts remain queued during WhatsApp
disconnections for up to seven days. A send is reserved durably before calling
WhatsApp; uncertain sends are recorded and never automatically repeated.

Fetches have 15-second timeouts, reject redirects, honor Retry-After, and run
independently so one failed source does not suppress the other. Changed or empty
TwiScan markup is an error. Source success/failure and timestamps are stored in
SQLite's existing key/value table and reported to the service log. No new
database schema, dependency or separate systemd timer is required.

Read-only feed check, without a WhatsApp session:

```sh
node scripts/check-reset-feeds.js
```

Relevant log events: `reset_watch_started`, `reset_source_ok`,
`reset_source_failed`, `reset_check_complete`, `reset_check_failed`,
`reset_message_acknowledged`, `reset_delivery_uncertain`. State keys are
`resetWatch`, `resetSource:recent`, `resetSource:status`, `resetSource:history`
and one `resetPost:<id>` per attempted post. Logs omit the recipient's number.

Disable with `resetAlerts: false` and restart the existing service. Preserve the
SQLite state to retain deduplication and the original activation cutoff.

Sources: [Codex Resets API](https://codex-resets.com/api/docs),
[Tibo's public recent posts](https://twiscan.com/en/x/thsottiaux), and the
[researched announcement catalogue](research/tibo-reset-announcements-2026-09-12.md).

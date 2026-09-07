# Validation record

## Verified locally on 7 September 2026

- Node 22.23.2 on macOS; syntax checks and 32 Node test cases pass, including delivery bookkeeping, QR session restart regressions and bounded CLI shutdown with output flushing.
- Fixed a false `needs_pairing` result: Baileys 7.0.0-rc14 QR pairing persists `creds.me.id` while `registered` remains false. Startup now uses the saved identity, matching Baileys' login path, while retaining explicit logout protection.
- Reconnected with the user's existing paired session and successfully fetched the group list after the fix. No chat message was sent during this verification.
- User confirmed receiving the one-off test message in NFTomorrow. Phone notification behavior and scheduled delivery are not established by that confirmation.
- Replaced the one-shot CLI's unbounded shutdown wait with a two-second socket cleanup grace period after pending application work, then SQLite close, lock release and flushed terminal output. A live `npm run groups` completed and exited in 1.72 seconds total. No additional test message was sent.
- Real read-only Magic Eden check returned floors for all three configured collection symbols and a complete total. No credentials or payments were needed.
- Pinned Baileys imports successfully on the local runtime.
- npm dependency audit initially reported zero vulnerabilities; see the final task report for the last audit result.
- Unit/integration coverage includes strict lamport parsing, complete-set totals, fresh FX handling, bounded HTTP retries, config validation, message formatting, SQLite restart persistence, atomic Signal key rollback, app-state protobuf restoration, credential permissions, exclusive process locking, interrupted delivery records, mocked connection recovery/logout, and configured-group restrictions.
- Cleanup removed the unused timezone dependency until scheduling is implemented. No generated auth database, private config, pairing QR or temporary test directory is committed.

- Verified the compact message against live Magic Eden and CoinGecko USD prices. USD conversion worked without an API key in this check. Automated coverage checks matching total/rate conversion and suppresses stale fiat values.
- Removed the old verbose message layout, change comparisons, marketplace-link formatter and test-message preamble/footer. Pricing caveats remain documented in README. No new dependency was needed.

The repository includes Linux CI for Node 22 and 24. It has not yet been verified on GitHub.

## Continuous monitor validation

Automated tests verify the approved hourly repeat behavior below 6,500 USD, strict threshold comparison, combined triggers, daily 18:00 London slots and suppression, both daylight saving transitions, a simulated multi-day cycle, persisted duplicate prevention after restart/uncertain sends, offline history collection, fresh reconnect observations, concurrent-poll coalescing and missed-summary handling. Missing price/FX data does not cause USD alerts.

The user deferred email configuration until after deployment. The Healthchecks client and runtime integration are implemented, but actual emails require three check URLs and verified email integrations.

## Not exercised live

Actual recipient notifications; Healthchecks email; Linux service deployment verification, reboot or restoration; and a full daily cycle. Simulated tests do not prove these behaviors. The price snapshot is a one-time fetch, not evidence of continuous monitoring.

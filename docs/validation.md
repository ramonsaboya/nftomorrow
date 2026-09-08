# Validation record

## Native sticker prototype — 8 September 2026

- Local Node 24.20.0: `npm run verify` passes syntax checks and all **62 tests**. The locked dependencies are unchanged; installation audit reports zero vulnerabilities.
- Sticker replies work through mocked full command flows in the configured group, phone-number direct chats and WhatsApp LID direct chats. Tests cover actual Baileys sticker protocol generation with simulated uploads, original-message quoting, per-chat persistent cooldown/deduplication, globally bounded work, invalid/stale/history/own-message rejection, missing/corrupt assets, reconnect/expiry cancellation, timeouts and uncertain-send bookkeeping. `/status` remains group-only, and automatic alert/summary regression tests pass.
- Review identified and fixed a future-clock-skew duplicate window in the new sticker handler. Retention includes the parser's 60-second timestamp tolerance; the replay-after-301-seconds regression now sends only once.
- Asset validation: original RGBA PNG saved, static transparent WebP encoded to 512 × 512 and 73,460 bytes. `webpinfo -diag` reports no errors; `dwebp` decodes successfully; the final sticker was visually reviewed. Runtime validation pins its verified SHA-256.
- Live preflight: current server release `dc870316818821b3e3ea51de5f6a36f9c772c5b8` matched all 39 tracked files, local and GitHub main. Exactly one remote systemd process owns the paired session; no local bot process. No private state or credentials were read or copied.
- Linux Node 24.20.0: staged feature application revision `a6419df9f587e79380a74576fa033f16d45cc2b3` passed syntax checks and all **62 tests** as the service user, with serial test execution. Existing dependency audit reports zero vulnerabilities. The stage did not start a WhatsApp socket; production continued under its original process during validation.
- **Live at 14:13 UTC / 15:13 BST on 8 September 2026:** stopped the old systemd service, confirmed its process exited, swapped the tested code and started that same service. New PID `40159`, active/running, zero automatic restarts, approximately 55 MiB observed memory. WhatsApp connected at `14:13:08.121Z`; fresh price checks with FX completed before and after connection. Configuration and current SQLite session remained in place. No unsolicited test message was sent.
- Exact code rollback release: `/opt/nftomorrow-before-sticker-a6419df9`, recording baseline `dc870316818821b3e3ea51de5f6a36f9c772c5b8`. Runtime code is the feature commit above; this subsequent documentation update does not change the running code. Feature branch `codex/sticker-test` is published separately; main remains unchanged.
- Manual acceptance remains: send `/sticker-test` from a non-bot account in the configured group and/or one-to-one chat, confirm native sticker receipt in that chat, then save it to favourites and confirm it in the picker. Allow a minute before repeating in the same chat. A connected service does not prove actual sticker delivery or saving.
- Cleanup review: one original plus one delivery asset; no new dependency, schema migration, AI subsystem or temporary runtime verifier. See [prototype instructions](sticker-prototype.md) for testing and code-only rollback.

## On-demand status command — 8 September 2026

- Local syntax checks and all 39 tests pass. New coverage verifies incoming group-only `/status` filtering, disappearing text, own-message/history/stale-message rejection, fresh replies, unchanged automatic scheduling, persistent cooldown/deduplication, bounded concurrent work, unavailable prices/FX, reconnect/expiry cancellation and uncertain-delivery bookkeeping.
- Incoming events and sends are mocked in these tests. Actual group command delivery and phone notifications require live acceptance after deployment.
- Cleanup review: no dependencies, schema migrations, temporary runtime helpers or private state were added. The README's former no-inbound-chatbot description now documents the single supported command.

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

The repository includes Linux CI for Node 22 and 24. Hosted GitHub Actions results have not been inspected. The full suite also passed directly on the Linux Droplet with Node 24.20.0.

## Continuous monitor validation

Automated tests verify the approved hourly repeat behavior below 6,500 USD, strict threshold comparison, combined triggers, daily 18:00 London slots and suppression, both daylight saving transitions, a simulated multi-day cycle, persisted duplicate prevention after restart/uncertain sends, offline history collection, fresh reconnect observations, concurrent-poll coalescing and missed-summary handling. Missing price/FX data does not cause USD alerts.

The user deferred email configuration until after deployment. The Healthchecks client and runtime integration are implemented, but actual emails require three check URLs and verified email integrations.

## Droplet deployment verified

- Deployed published application revision `a461941972ef7cf7bc4c3d3760a2b3360c055aaa` to Ubuntu 24.04 with verified Node 24.20.0, a non-root systemd service, an SSH-only inbound firewall, enabled unattended updates, bounded journald storage and 1 GB swap on the selected 512 MB host.
- All 32 tests and syntax checks passed on Linux; dependency audit found zero vulnerabilities.
- A consistent SQLite backup was transferred over SSH, preserving the existing paired WhatsApp session. The live service connected without another QR scan and completed fresh Magic Eden/CoinGecko checks.
- `systemctl` reports active/running and enabled at boot. An intentional restart succeeded, reconnecting and checking prices. Sample steady memory was about 53 MiB, with no automatic restarts or swap use observed; this is a short observation, not a load/soak test.
- Verified private file ownership/modes and removed temporary credential-transfer files and installation cache. Credentials/config remain outside Git. Only the server should use the paired session from now on; the local snapshot becomes stale as server keys evolve.
- Email check URLs are unset by user choice, and the service reports this explicitly.

- User confirmed receiving the explicitly authorized Droplet-origin test. The temporary origin-verification helper, message prefix and standalone evidence file were then removed at the user's request. The regular compact message format is restored; historical delivery audit and journal entries remain.


## Not exercised live

Actual phone notifications; Healthchecks email; a host reboot or restoration; and a full daily cycle. Simulated tests do not prove these behaviors. The price snapshot is a one-time fetch, not evidence of continuous monitoring.

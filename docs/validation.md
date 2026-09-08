# Validation record

## GPT Image 2 reference-photo edits — 8 September 2026

- Feature branch `codex/gpt-image-stickers` adds `/sticker <prompt>` in the configured group and phone/LID direct chats. The attached reference photo is saved unchanged as `assets/stickers/default-reference.png`; source and saved copy share SHA-256 `bcf8d48f8d38a29b11accb87935ba51b0064fbb67f6d3f382ff14baccda38f6d`.
- Local Node 24.20.0: syntax checks and all **83 tests** pass. New tests verify exact `gpt-image-2` multipart image edits, original-reference uploads, transparent-image validation/conversion, response limits, API deadline and cancellation, no paid retries, durable attempt budgets and deduplication, chat routing, failure notices, uncertain sends, and price polling during slow generation.
- Sharp 0.35.4 is now an explicit runtime dependency; its version was already represented as a peer in the previous lockfile. Installation and CI include optional platform binaries. No other dependency versions changed; installation audit found zero vulnerabilities. Verification runs serially to bound Linux test memory.
- Initial staging found no API key and left production unchanged. After the user supplied a key and requested activation, authenticated lookup of `gpt-image-2` succeeded; the key was saved only in the server's root-only environment file. No image edit was run during activation. A subsequent debugging request made one authenticated edit as recorded below.
- Staging detected concurrent live revision `e2fd3b248abd071dbb902cd190574da7cceedc16`. That update was merged into the feature branch, preserving actual Dobby mentions for group status and private `/status` replies. Activation preflight verified the same live revision before swapping code.
- Final application revision `3bbf2af84fefc43b0e69099790b24ecf02dc1109` passed all **83 tests** and syntax checks on Linux as the service user, including Sharp platform binaries; audit found zero vulnerabilities. The temporary upload archive was removed.
- **Activated at 15:31 UTC / 16:31 BST on 8 September 2026:** stopped the sole service, retained the prior release at `/opt/nftomorrow-before-image-e2fd3b24`, moved the tested release into `/opt/nftomorrow`, and restarted the same service. PID `43073` is active/running with zero automatic restarts and approximately 53 MiB observed memory. WhatsApp connected at `15:31:41.180Z`. Exactly one bot process was present; the existing paired session/state remained in place. No unsolicited test message was sent. See [setup and runtime behavior](image-stickers.md).
- Cleanup: retained the free fixed-sticker diagnostic and its artwork; added one distinct source photo, converter, API client and bounded command handler. No generated variants, schema changes, extra WhatsApp session, or credentials were added.

## Image failure diagnostics — 8 September 2026

- The user reported a failure after activation. The server recorded `sticker_generation_failed` at `15:34:32.466Z`, followed by an acknowledged failure notice at `15:34:32.667Z`. Its audit duration was 84,637 ms, below the three-minute timeout. The previous handler discarded all error details, so the cause of that original request is unknown.
- One controlled diagnostic from the server used the existing photo, `gpt-image-2`, medium quality and prompt `Make him look like a pirate`. OpenAI returned HTTP 200 in 71,867 ms; conversion produced a valid transparent 512px WebP of 79,104 bytes. Usage was 1,609 input and 1,756 output tokens. OpenAI request ID: `req_bd9e5c8ec7294cc09341ffc90d934b35`. This was one billable API diagnostic outside the chat attempt counter; no WhatsApp session was opened, no message was sent and no output file was retained. User-visible appearance, delivery and saving remain unverified.
- Added bounded, sanitized API diagnostics, failure-stage/timing/generation references and distinct user notices. Provider messages, raw bodies, prompts and secrets are excluded from logs. No dependency, schema, artwork or retry-policy changes. All **88 tests** and syntax checks pass locally, including new tests for billing/reference correlation, redaction, oversized/non-JSON errors, timeout/access notices and conversion errors.

- **Diagnostics live at 15:42 UTC / 16:42 BST:** revision `260a5e7dae8fb3e68b36928e522aa9e74d7999ad` passed all **88 tests** and syntax checks on Linux as the service user, then replaced the previous code in the sole systemd service. PID `44056`, zero automatic restarts, approximately 54 MiB observed memory; WhatsApp connected at `15:42:13.120Z` and fresh price checks completed. Prior code remains at `/opt/nftomorrow-before-diagnostics-3bbf2af8`. Temporary staging archive and verification log were removed. No second live image call or WhatsApp message was sent.

## Dobby acknowledgement — 8 September 2026

- Added one quoted `sticker-processing` acknowledgement in the originating group or 1:1 chat, after request/configuration/budget validation and before image generation. Generation starts only after confirmed acknowledgement and a fresh connection check. Duplicate/cooldown/busy requests do not send extra acknowledgements. No periodic updates, dependencies, schema changes or automatic retries were added.
- All **90 tests** and syntax checks pass locally. Updated flow tests cover one acknowledgement in group and direct chats, preflight rejections, duplicate suppression and failure references; new tests verify that uncertain acknowledgement or disconnect/shutdown during it prevents paid generation and budget reservation.
- Parallel read-only investigation of `C15EBE86` found HTTP 500 / `server_error` at `2026-09-08T16:45:06.318Z`, after 88,753 ms. OpenAI request ID `req_3adf03682c614f578d1afee6cad41f46`. This is consistent with the ongoing [OpenAI image-generation incident](https://status.openai.com/incidents/01M20PYYYGRT9303VHAPA7YNT2); the incident does not establish the root cause of an individual request. No paid diagnostic request or WhatsApp message was sent during this work.

- **Acknowledgement live at 16:48 UTC / 17:48 BST:** revision `3e7b216232b4b78d7920fbc924e464e62cdf946e` passed all 90 tests on Linux as the service user. No image job was active at preflight. The sole service restarted as PID `45373`, active with zero automatic restarts; WhatsApp connected at `16:48:53.895Z`, and fresh price checks completed. Rollback code is `/opt/nftomorrow-before-ack-260a5e7`. Temporary archive and verification logs were removed; the paired session/state was preserved. Receipt of the new acknowledgement on a phone remains manual acceptance.

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

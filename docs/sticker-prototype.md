# Native WhatsApp sticker prototype

Send `/sticker-test` from another WhatsApp account in the configured NFTomorrow group **or directly in a one-to-one chat with the bot** while the deployed service is connected. The reply stays in the originating chat, including WhatsApp private-address (LID) chats. The bot replies to that command with the fixed robot DJ sticker. Tap or long-press the received sticker and use WhatsApp's favourites/save action, then confirm it appears in your sticker picker. Labels vary between clients; actual receipt and saving need manual acceptance.

Allow one minute between sticker requests in the same chat. `/status` remains group-only with its own cooldown. Both commands ignore history, stale messages, other groups, broadcasts, captions, the bot's own messages and unsupported command arguments. Sticker cooldown and duplicate records are separate per chat, with only one sticker request pending or running across all chats. Restart/reconnect never replays pending sticker requests; uncertain sends are recorded without automatic retry. The existing hourly checks and alerts, daily summary, session lock, reconnect and shutdown paths remain in use.

## Fixed assets

- Original artwork: [`assets/stickers/sticker-test-source.png`](../assets/stickers/sticker-test-source.png), 1254 × 1254 RGBA. Created once with the built-in image-generation tool, supplied by the parent task; no specific named API model benchmark is claimed.
- Delivery file: [`assets/stickers/sticker-test.webp`](../assets/stickers/sticker-test.webp), static transparent 512 × 512 WebP, **73,460 bytes**, including fully transparent background pixels.
- SHA-256: `17f2455288460fbc1756ad4d34322bd31d445c11bb77201f42025d0075d13a58`.

These dimensions, transparency and size follow [WhatsApp's static sticker requirements](https://github.com/WhatsApp/stickers/tree/main/Android#sticker-art-and-app-requirements). This is delivery of a single sticker in chat, with no sticker-pack application or per-request image generation.

The file was encoded with installed libwebp 1.6.0 tooling, decoded successfully with `dwebp`, checked with `webpinfo -diag`, and visually reviewed at delivery size. The original alpha is retained during resizing and lossless alpha encoding. Runtime checks enforce its WebP header, static/alpha flags, dimensions, 100,000-byte maximum and the SHA-256 of the decoded, reviewed asset. An asset replacement requires offline decoding/review and a deliberate checksum update in `src/sticker.js`. A missing or damaged asset logs `sticker_unavailable`, sends nothing, and leaves price monitoring running.

Reproduce the conversion with installed `cwebp` (not required on the server):

```sh
cwebp -resize 512 512 -q 90 -alpha_q 100 -m 6 -metadata none \
  assets/stickers/sticker-test-source.png -o assets/stickers/sticker-test.webp
webpinfo -diag assets/stickers/sticker-test.webp
dwebp assets/stickers/sticker-test.webp -o /tmp/nftomorrow-sticker-preview.png
```

## Local verification

From this feature checkout using Node 24, install only the existing locked dependencies and run:

```sh
npm ci --omit=optional
npm run verify
```

Tests use mock WhatsApp sockets and temporary/in-memory SQLite. They do not connect the paired account or send messages. The sticker uses Baileys' `{ sticker: Buffer, mimetype: 'image/webp' }` payload with the caller-reserved message ID and the triggering message as a quote. Delivery audit stores the asset name/hash, not its image bytes or quoted message.

Do not start a local bot, run pairing/group discovery, or copy the production session for this test. Only the existing server service may own that session.

## Feature deployment and rollback

Production uses archive releases at `/opt/nftomorrow` and one systemd unit, `nftomorrow`. Configuration and state remain outside the code release under `/etc/nftomorrow` and `/var/lib/nftomorrow`. The baseline for this feature is `dc870316818821b3e3ea51de5f6a36f9c772c5b8`. No schema migration or session transfer is needed.

Stage an archive of the verified feature commit into `/opt/nftomorrow-sticker-<short-commit>`, write its full commit to `REVISION`, and install the existing pinned dependencies there. While the current service continues, run syntax checks and `node --test --test-concurrency=1` as the service user in staging. Never start another service from staging.

After successful verification, stop `nftomorrow` and verify its process has exited. Retain the current release as `/opt/nftomorrow-before-sticker-<short-commit>`, move the staging release to `/opt/nftomorrow`, and start the same systemd unit. Verify its revision, single process, WhatsApp connection and fresh price check. Leave private state in place throughout. The feature is not merged into main.

To roll back, stop that same service, verify its process is gone, move the candidate code aside, restore the matching `before-sticker` release as `/opt/nftomorrow`, and start the service. Keep the current state directory; restoring old session keys or delivery bookkeeping is unnecessary and can cause problems.

The live activation evidence and exact retained release path are recorded in [validation](validation.md). A service connection or send acknowledgement does not establish phone receipt or saving to favourites.

For the release activated on 8 September, the administrator can execute this exact rollback on the server:

```sh
set -eu
test -d /opt/nftomorrow-before-sticker-a6419df9
test ! -e /opt/nftomorrow-sticker-disabled-a6419df9
systemctl stop nftomorrow
test "$(systemctl show nftomorrow -p MainPID --value)" = 0
mv /opt/nftomorrow /opt/nftomorrow-sticker-disabled-a6419df9
mv /opt/nftomorrow-before-sticker-a6419df9 /opt/nftomorrow
systemctl start nftomorrow
systemctl status nftomorrow --no-pager
```

## Cleanup review

The only new runtime feature is fixed sticker transport and its small command handler. No dependencies, image-generation subsystem, schema migration, pairing changes, temporary verifiers or credentials were added. Keep the supplied original and one validated delivery asset; conversion previews remain outside the repository. Existing project artwork is unrelated and retained. The prior code release is intentionally kept on the server for rollback until acceptance.

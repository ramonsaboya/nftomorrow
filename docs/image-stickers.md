# Dobby image stickers

Sticker commands are restricted to the owner account in every group Dobby has joined and in private chats. Configure `stickerOwnerJids` in the private `config.json` with the owner's international phone number (digits only) followed by `@s.whatsapp.net`, and optionally the same account's verified `@lid` ID. An absent or empty list disables all sticker commands. Display names and handles do not grant access.

This covers `/sticker`, `/euvousticker`, `/sticker-test`, and their mention forms. Other senders are silently ignored before cooldowns, replies or paid image work. Group requests use the message sender; direct requests use the sending account. Protocol-provided alternate phone/LID IDs are supported. If a message has only a LID with no phone alternate, configure the owner's verified LID as well. `/status` and scheduled price alerts retain their existing behavior.

Available owner commands:

- `/sticker <description>`: create artwork from the exact user prompt, optionally using photos supplied with the command. No imposed caption style, cutout requirement or other creative template is added.
- `/euvousticker <theme or scene>`: customize the original `assets/stickers/default-reference.png`. A nonempty theme/description is required. Preserve the original man, pose, framing and surroundings by default, adding themed clothing and details. Explicitly requested pose/scene changes and major creative transformations are allowed. Output has an opaque, full-frame square background.
- For requested Eu Vou captions, default to bottom left (or another position when the composition clearly calls for it), plain readable black square sans-serif text, perfectly horizontal, without a box, outline, shadow or decoration. Only add text when requested; explicit placement and elaborate typography requests override defaults.
- Actual mentions work too: `@Dobby sticker a dancing dragon` and `@Dobby euvousticker beach holiday, caption "Eu vou"`. Select Dobby from WhatsApp's mention picker. `/status` and `@Dobby status` return NFT prices in the same group or DM. Scheduled price alerts retain their configured destination.

Dobby acknowledges accepted image work once, quoting the command, then sends a native sticker in that same chat. If acknowledgement is uncertain, no paid image request starts. The free `/sticker-test` transport diagnostic remains available.

## Using your own photos

Send a photo with `/sticker turn me into a wizard` in its caption, or reply to an existing photo with `/sticker turn this into a cartoon`. Actual Dobby mentions also work in photo captions. Text and full photo content are passed together to the image model.

Select up to 25 photos together in WhatsApp, add one `/sticker <description>` caption, and send. Dobby collects the album and sends all its photos with that prompt in one AI request, producing one sticker. Its acknowledgement confirms the number of photos used. `/euvousticker` accepts the same albums as additional references while keeping the original Eu Vou photo first.

Albums use WhatsApp's parent message ID and expected photo count, scoped to the sending account and chat. Out-of-order children and repeated deliveries are supported. Incomplete albums time out after 90 seconds with a resend notice; mixed photo/video albums, more than 25 photos, and conflicting command captions are rejected before paid generation. Completed album IDs are remembered for six minutes, including across reconnects and restarts. Pending collections are dropped on disconnect or shutdown.

For clients that send photos without album association metadata, Dobby groups photos from the same account in the same chat until five seconds pass without another photo (90 seconds maximum). Put the command in a photo caption; avoid sending unrelated photos during that short window. Explicit albums never mix with another album. Single captioned photos may therefore take five seconds before processing starts. A captioned photo replying to another photo still includes the quoted photo, within the 25-photo total.

Inputs must be static JPEG, PNG or WebP photos, at most 20 MiB and 16,777,216 pixels each, with at most 50 MiB of prepared images per request. Photos are decoded, oriented, stripped of metadata and resized to fit 2048 × 2048 before upload. They remain in memory and are not stored in logs or the audit database. Downloading and validation happen only for accepted owner commands, with a 120-second deadline across the set. A missing, expired or invalid photo produces a resend notice without starting paid generation; the bot never silently generates without the requested image. Audits record the photo count alongside the existing prompt hash.

## API and configuration

The Image API accepts at most 16 input images ([official limit](https://developers.openai.com/api/reference/resources/images/methods/edit)). To include all 25 user photos in one generation, larger sets are packed into numbered two-photo reference sheets: above 16 photos for `/sticker`, or above 15 for `/euvousticker`, which reserves a slot for its original. Every photo remains included in order; sheet labels identify photo numbers and are explicitly excluded from the output unless requested. Sets above 15 photos are prepared at up to 1024 pixels per photo to bound memory; smaller sets retain up to 2048 pixels. Sheet packing reduces fine detail compared with separate full-resolution inputs. Prompts accept up to 4,000 characters. Download/validation has two minutes, generation four minutes, and accepted jobs expire after seven minutes. Album collection is separate and allows 90 seconds. The existing daily attempt cap and one-job concurrency remain unchanged.

Both image modes use `gpt-image-2.5-sunburst`, OpenAI's most capable image model as verified on 9 September 2026, with `quality=max` by default. Reference edits and commands with photo inputs use multipart `POST /v1/images/edits`, with each PNG in an `image[]` field; text-only freeform images use JSON `POST /v1/images/generations`. The freeform user's prompt stays unchanged in either case. Both request one 1024 × 1024 PNG; background is `opaque` for Eu Vou and `auto` for freeform. No silent fallback model is used. OpenAI's provider content rules still apply.

Sources: [model documentation](https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst), [Image API guide](https://developers.openai.com/api/docs/guides/image-generation).

Set in the private runtime environment, never in source:

```dotenv
OPENAI_API_KEY=YOUR_PRIVATE_API_KEY
OPENAI_IMAGE_QUALITY=max
STICKER_DAILY_LIMIT=20
```

Quality accepts low, medium, high, xhigh, max or auto. The daily cap (1–1000) covers attempted generations across both modes and every chat per UTC day; failures count. It is an attempt cap, not a dollar budget. The Image API requires separately billed API access; a ChatGPT subscription does not supply this bot's API credentials. Existing server configuration can override the new quality default: update `OPENAI_IMAGE_QUALITY=medium` to `max` during deployment and verify access to the new model.

## Reliability and validation

One image request may be pending or running at once; requests share a per-chat one-minute cooldown. Jobs run asynchronously so price monitoring continues. Shutdown aborts generation and waits for bookkeeping. Requests have a four-minute generation deadline and bounded response/image sizes; uncertain paid work and sends are never automatically retried. Reconnection, expiry or shutdown suppress late replies. Cancellation does not guarantee cancellation of provider billing.

The PNG is decoded, resized to 512 × 512 and compressed to static WebP at or below 100,000 bytes. Opaque and transparent artwork are both valid; wholly transparent, corrupt, oversized and animated images are rejected. Square opaque inputs remain full-frame opaque images. Generated images remain in memory. Logs retain only safe diagnostic fields and token counts; audits retain destination, mode, model and a prompt hash, not raw prompts, keys or images.

Run `npm ci --include=optional` and `npm run verify` using Node.js 24. Tests mock the image provider and WhatsApp transport while performing real image conversion. Do not start a second bot with the production WhatsApp session. Deployment should run the checks on Linux and verify real output and delivery in an unregistered group and a DM.

Local validation on 9 September 2026: all 96 tests and syntax checks passed on Windows with Node.js 24.21.0. Locked dependencies installed successfully. No paid API request, production WhatsApp connection or deployment was performed. POSIX file-mode assertions remain enabled on Linux; Windows does not implement those mode bits.

The history below records earlier releases, not deployment of these changes. Recheck the live revision before deployment.

## Validation and activation

Previously recorded live application revision was `3e7b216232b4b78d7920fbc924e464e62cdf946e`, activated at 16:48 UTC / 17:48 BST on 8 September 2026. This adds Dobby’s acknowledgement. All 90 tests passed locally and on Linux; WhatsApp reconnected at `16:48:53.895Z`. Rollback is `/opt/nftomorrow-before-ack-260a5e7`. The activation details below describe the earlier releases.

Run `npm run verify` in this feature checkout. Tests substitute the OpenAI HTTP response and WhatsApp socket; they exercise real multipart request construction, image decoding/compression and command flows without paid API calls or using the live paired session. Linux staging tests must pass before switching the existing service.

The initial image-feature revision `3bbf2af84fefc43b0e69099790b24ecf02dc1109` went live at 15:31 UTC / 16:31 BST on 8 September 2026 after all 83 tests passed on Linux. The supplied API key was installed in the root-only environment file and authenticated access to the `gpt-image-2` model was verified without an image-generation request. The same systemd service restarted as PID `43073` with zero automatic restarts, and WhatsApp connected at `15:31:41.180Z`. Code-only rollback is retained at `/opt/nftomorrow-before-image-e2fd3b24`; `/var/lib/nftomorrow` remains untouched. Before future release changes, recheck the live revision and preserve concurrent updates.

A controlled authenticated pirate edit succeeded in about 72 seconds and converted to a valid 79,104-byte sticker; it was not sent to WhatsApp. Delivery, appearance and save acceptance remain manual steps: send the example command from a non-bot account, check the edit resembles the default photo with the requested change, confirm it is a native sticker in the same chat, and save it to favourites. That diagnostic verifies API generation and transparent conversion for one prompt; it does not establish why the earlier user request failed or verify recipient-visible output quality. Allow up to three minutes and avoid repeating uncertain requests.

## Debugging a failed sticker

Diagnostic revision `260a5e7dae8fb3e68b36928e522aa9e74d7999ad` went live at `/opt/nftomorrow` at 15:42 UTC / 16:42 BST on 8 September 2026. All 88 tests passed locally and on Linux as the service user. WhatsApp reconnected at `15:42:13.120Z`; PID `44056` was the sole bot process, active with zero automatic restarts. Code-only rollback is `/opt/nftomorrow-before-diagnostics-3bbf2af8`.

Failures now include a short `Reference` in the WhatsApp reply. On the server, inspect the matching structured event:

```sh
journalctl -u nftomorrow --since '15 minutes ago' -o cat --no-pager
```

Find `sticker_generation_failed` and match `reference`. The event records the generation ID, elapsed time, stage, local error code, HTTP status, allowlisted provider error code/type/parameter and OpenAI request ID when available. `image_edit` covers source loading, the API request and conversion; `conversion_failed` specifically means the API returned an image that could not become a valid sticker. `sticker_validation` means the final output failed validation. `delivery_uncertain` is a separate WhatsApp send problem and never regenerates artwork.

Provider messages, response bodies, raw prompts, images and keys are omitted. API error bodies are read with a 16 KiB cap. Billing/access/rate-limit/timeout/conversion failures get distinct user notices; only an explicit moderation code suggests changing the prompt. There are no automatic paid retries. Use the OpenAI request ID for provider support. A generic historical failure from before this diagnostic change cannot be reconstructed because its original details were discarded.

## Cleanup review

Retained the original robot asset solely for the free `/sticker-test` transport diagnostic. The new source photo is distinct and unchanged. Added one required image-conversion dependency; removed outdated optional-dependency installation instructions. No generated variants, keys, credentials or temporary deployment archives belong in Git. No schema migration or second WhatsApp session was introduced.

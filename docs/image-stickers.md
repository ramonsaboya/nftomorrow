# Dobby image stickers

Commands work in every group Dobby has joined, without registration, and in private chats:

- `/sticker <description>`: create any artwork from the exact user prompt. No reference image, imposed caption style, cutout requirement or other creative template is added.
- `/euvousticker <theme or scene>`: customize the original `assets/stickers/default-reference.png`. A nonempty theme/description is required. Preserve the original man, pose, framing and surroundings by default, adding themed clothing and details. Explicitly requested pose/scene changes and major creative transformations are allowed. Output has an opaque, full-frame square background.
- For requested Eu Vou captions, default to bottom left (or another position when the composition clearly calls for it), plain readable black square sans-serif text, perfectly horizontal, without a box, outline, shadow or decoration. Only add text when requested; explicit placement and elaborate typography requests override defaults.
- Actual mentions work too: `@Dobby sticker a dancing dragon` and `@Dobby euvousticker beach holiday, caption "Eu vou"`. Select Dobby from WhatsApp's mention picker. `/status` and `@Dobby status` return NFT prices in the same group or DM. Scheduled price alerts retain their configured destination.

Dobby acknowledges accepted image work once, quoting the command, then sends a native sticker in that same chat. If acknowledgement is uncertain, no paid image request starts. The free `/sticker-test` transport diagnostic remains available.

## API and configuration

Both image modes use `gpt-image-2.5-sunburst`, OpenAI's most capable image model as verified on 9 September 2026, with `quality=max` by default. Reference edits use multipart `POST /v1/images/edits` with the original PNG in `image[]`; freeform images use JSON `POST /v1/images/generations` with the user's prompt unchanged. Both request one 1024 × 1024 PNG; background is `opaque` for Eu Vou and `auto` for freeform. No silent fallback model is used. OpenAI's provider content rules still apply.

Sources: [model documentation](https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst), [Image API guide](https://developers.openai.com/api/docs/guides/image-generation).

Set in the private runtime environment, never in source:

```dotenv
OPENAI_API_KEY=YOUR_PRIVATE_API_KEY
OPENAI_IMAGE_QUALITY=max
STICKER_DAILY_LIMIT=20
```

Quality accepts low, medium, high, xhigh, max or auto. The daily cap (1–1000) covers attempted generations across both modes and every chat per UTC day; failures count. It is an attempt cap, not a dollar budget. The Image API requires separately billed API access; a ChatGPT subscription does not supply this bot's API credentials. Existing server configuration can override the new quality default: update `OPENAI_IMAGE_QUALITY=medium` to `max` during deployment and verify access to the new model.

## Reliability and validation

One image request may be pending or running at once; requests share a per-chat one-minute cooldown. Jobs run asynchronously so price monitoring continues. Shutdown aborts generation and waits for bookkeeping. Requests have a three-minute deadline and bounded response/image sizes; uncertain paid work and sends are never automatically retried. Reconnection, expiry or shutdown suppress late replies. Cancellation does not guarantee cancellation of provider billing.

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

# GPT Image 2 reference-photo stickers

In the configured NFTomorrow group or a one-to-one chat with the bot, send:

```text
/sticker make him a DJ wearing headphones
```

After validation and the daily-limit check, Dobby immediately replies once in the same chat: “Dobby’s on it 🪄 I’m making your sticker and will send it here when it’s ready. It may take a couple of minutes.” The acknowledgement quotes the command. There are no repeating progress messages. If that acknowledgement cannot be confirmed, or the connection changes while sending it, no paid image request starts.

Each accepted request uploads the same original [default reference photo](../assets/stickers/default-reference.png) and the user's prompt to `gpt-image-2`. It asks for an isolated sticker with a transparent background and white outline, preserves the person's recognizable appearance, and applies the requested edit. Requests start from the source photo, not a previous result. No mask is required for whole-image prompted edits. Identity fidelity and the requested appearance still need real-output acceptance.

The returned PNG is decoded, checked for genuine transparency, fitted to 512 × 512, compressed to WebP at or below 100,000 bytes, decoded again, and sent as a native quoted sticker in the originating chat. Generated artwork remains in memory and is discarded after the job; the source photo remains in the repository. The fixed robot `/sticker-test` remains available. The deployed status behavior is preserved: mention Dobby followed by `status` in the group, or send `/status` privately.

## API choices

- Endpoint: `POST https://api.openai.com/v1/images/edits`, multipart `image[]` containing the local PNG, and a text prompt.
- Model: exactly `gpt-image-2`; no silent fallback to another model.
- Output: `n=1`, `size=1024x1024`, `quality=medium`, `background=transparent`, `output_format=png`.
- Omit `input_fidelity`: GPT Image 2 automatically uses high-fidelity image inputs and does not accept changing that setting.
- Transparent backgrounds are a preview feature. If the API rejects the request or returns opaque/invalid artwork, the bot replies with a brief failure notice; it does not pretend that a photo with opaque background is a cutout sticker.

Sources checked 8 September 2026: [GPT Image 2 model](https://developers.openai.com/api/docs/models/gpt-image-2), [image-generation guide](https://developers.openai.com/api/docs/guides/image-generation), [image-edit API reference](https://developers.openai.com/api/reference/resources/images/methods/edit). The Image API has separate usage billing. Input image/text and generated image tokens contribute to cost; consult [current pricing](https://developers.openai.com/api/docs/guides/image-generation#cost-and-latency). Supplying an API key does not itself establish model access or transparent-preview availability.

## Configuration

Set these in the private runtime environment, never in source or a chat message:

```dotenv
OPENAI_API_KEY=YOUR_PRIVATE_API_KEY
OPENAI_IMAGE_QUALITY=medium
STICKER_DAILY_LIMIT=20
```

`OPENAI_IMAGE_QUALITY` accepts `low`, `medium`, or `high`. The daily limit is an integer from 1 to 1,000 and caps attempted generations across all chats per UTC day. Failed/uncertain attempts also consume the cap. It is an attempt limit, not a guaranteed dollar budget. One-minute cooldowns apply per chat; only one image job can run or wait at a time, and additional requests are ignored.

On the existing server, edit `/etc/nftomorrow/environment` through your private SSH terminal. For example, from the Mac:

```sh
ssh -t -i ~/.ssh/id_ed25519_digitalocean root@165.232.43.96 \
  'nano /etc/nftomorrow/environment'
```

Add the three entries above and preserve existing price-monitor settings and file permissions. Do not paste the key into Codex chat, command arguments, Git or documentation. Feature activation is a separate code-release swap; restarting the old fixed-sticker release does not add `/sticker`.

## Reliability and operation

The existing single paired WhatsApp session stays on the server. Image jobs run asynchronously within that service while price checks and health heartbeats continue. SIGTERM/SIGINT or fatal service errors abort an outstanding API request and wait for its bookkeeping before closing SQLite. The API request has a three-minute deadline, bounded response/image sizes and no automatic retries. A connection change, expiry or shutdown suppresses late replies. Cancellation does not guarantee cancellation of provider billing.

Acceptance, a daily attempt reservation and a generation audit are committed before API work. Audit records hold a prompt hash, model and destination, without raw prompt/image/API-key contents. Image token usage is logged as counts. A separate delivery attempt commits before WhatsApp sending. Uncertain generation/delivery is never replayed after restart. Generated images and prompts are not reused as conversation history.

Runtime conversion uses pinned Sharp 0.35.4, with one native worker and its cache disabled for the small host. Install with `npm ci --include=optional`, which includes its platform binaries. CI and `npm run verify` use the same locked dependencies. No OpenAI SDK, agent framework, paid background batch job or extra WhatsApp process is needed.

## Validation and activation

Current live application revision is `3e7b216232b4b78d7920fbc924e464e62cdf946e`, activated at 16:48 UTC / 17:48 BST on 8 September 2026. This adds Dobby’s acknowledgement. All 90 tests passed locally and on Linux; WhatsApp reconnected at `16:48:53.895Z`. Rollback is `/opt/nftomorrow-before-ack-260a5e7`. The activation details below describe the earlier releases.

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

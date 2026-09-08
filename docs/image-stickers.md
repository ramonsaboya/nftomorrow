# GPT Image 2 reference-photo stickers

In the configured NFTomorrow group or a one-to-one chat with the bot, send:

```text
/sticker make him a DJ wearing headphones
```

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

Run `npm run verify` in this feature checkout. Tests substitute the OpenAI HTTP response and WhatsApp socket; they exercise real multipart request construction, image decoding/compression and command flows without paid API calls or using the live paired session. Linux staging tests must pass before switching the existing service.

Live activation is pending the API key and a successful first authenticated edit. Retain the current fixed-sticker release for code-only rollback; keep `/var/lib/nftomorrow` untouched. After activation, send the example command from a non-bot account, check the edit resembles the default photo with the requested change, confirm it is a native sticker in the same chat, and save it to favourites. Allow up to three minutes and avoid repeating uncertain requests.

## Cleanup review

Retained the original robot asset solely for the free `/sticker-test` transport diagnostic. The new source photo is distinct and unchanged. Added one required image-conversion dependency; removed outdated optional-dependency installation instructions. No generated variants, keys, credentials or temporary deployment archives belong in Git. No schema migration or second WhatsApp session was introduced.

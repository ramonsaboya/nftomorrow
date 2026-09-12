# nftomorrow

Sticker commands require `stickerOwnerJids` in private `config.json`, containing
the owner's international phone digits followed by `@s.whatsapp.net` and optionally
the same account's verified `@lid` ID. Missing or empty configuration disables
`/sticker`, `/euvousticker` and `/sticker-test`. Other senders are silently ignored
in groups and DMs, including mention commands. See [sticker access setup](docs/image-stickers.md).

Tomorrowland NFT price monitoring and Dobby WhatsApp commands, using Node.js, Baileys and SQLite. Automatic alerts go to the configured group; commands work in every group Dobby has joined and in private chats, without group registration.

## Behavior

- `/sticker --animated a cat waving` creates a two-second animated sticker; `--gif` is an alias. Both flags work with `/euvousticker`, photo inputs and mentions. Output uses WhatsApp's animated WebP sticker format. See [animated sticker details](docs/image-stickers.md#animated-stickers).
- Select up to 25 photos together in WhatsApp and add `/sticker <description>` as the caption. Dobby uses the whole album and prompt for one sticker, and confirms the photo count before generating. `/euvousticker` also accepts albums. See [photo input details](docs/image-stickers.md#using-your-own-photos).

- Check all three Magic Eden collections hourly, 24/7, and once on startup or reconnection.
- Alert when the full Medallion costs **less than 6,500 USD**, using a fresh CoinGecko SOL/USD rate. Repeat on every hourly check while below. Exactly 6,500 does not trigger. There is no recovery margin or crossing-only rule.
- Daily summary at **18:00 Europe/London**, following daylight saving, if no alert was attempted since the previous daily slot. Combine a coincident alert and summary into one message.
- Checks can detect a dip up to an hour late and miss short dips. “Immediately” means immediately after a check detects the threshold.
- Reconnects and restarts fetch current prices; they do not replay queued messages. Already-attempted alerts are not duplicated within the same UTC hour. First installation waits for the next daily slot; after downtime, at most the latest missed daily summary is sent with fresh prices.
- Persist history, authentication, daily state and delivery bookkeeping. Continue price checks while WhatsApp is disconnected or requires re-pairing.
- In any WhatsApp group Dobby has joined, type `@`, select Dobby from the mention picker, then type `status`: **@Dobby status**. This requests a fresh check of the three NFT floors, Medallion total, exchange rate and check time. Any group member can use it. Replies use the message format below, independently of hourly alerts and the daily summary. Failed price checks return an unavailable message; missing FX still shows SOL prices.
- `/sticker-test` works in any group Dobby has joined or a one-to-one chat with the bot. It replies in that same chat with one fixed, pre-generated robot DJ artwork as a native WhatsApp sticker, quoting the command. The image is loaded locally; each request makes no image-generation API call. See [the sticker prototype](docs/sticker-prototype.md) for assets, validation and testing.
- `/sticker <description>` generates any requested artwork without the reference photo or preset style. `/euvousticker <theme>` customizes the [original photo](assets/stickers/default-reference.png), preserving its appearance by default and using an opaque square background. Requested captions default to plain horizontal black sans-serif text at bottom left, without a box or effects; explicit creative changes and typography requests override those defaults. Both use `gpt-image-2.5-sunburst`, maximum quality by default, and reply with a native sticker in the originating chat. An OpenAI API key is required. See [image sticker setup](docs/image-stickers.md).
- `/status` returns current NFT floors and Medallion prices in any group or private chat. Every command also accepts an actual Dobby mention followed by its name: `@Dobby status`, `@Dobby sticker <description>`, or `@Dobby euvousticker <theme>`. Select Dobby from WhatsApp's mention picker. Status cooldowns apply per chat.
- Commands accept plain text (case-insensitive command names, original prompt casing retained, surrounding spaces allowed), including disappearing text messages. The bot's own messages, broadcasts and unsupported destinations are ignored. Status, fixed stickers and AI stickers each have an independent one-minute cooldown per chat. Both AI modes share one job slot and a daily cap of 20 paid attempts (configurable); failed attempts count too. Each handler allows only one request pending or running at a time; extra requests are silently ignored. History, messages older than five minutes, and messages predating the current connection are ignored. Duplicate requests are suppressed, acceptance survives restart, and uncertain replies are never automatically retried. Image edits run in the background so price checks and health heartbeats continue.

The original proposal in [docs/brief.md](docs/brief.md) is historical. The behavior above incorporates the user's later changes: 18:00, a 6,500 USD Medallion threshold and hourly repeat alerts.

## Message

`/status` and daily summaries send a native WhatsApp album containing four separate PNG images: a summary
with Medallion USD/SOL costs and SOL/USD conversion, NFT floor charts in USD and
SOL (Medallion plus all three collections), and a SOL/USD chart. Current values
are printed beneath every chart. Medallion lines, labels and summary values are
always purple. SVG layouts are rasterized locally with Sharp;
these status images do not use AI or an image-generation API.

The default window is the last **30 days**. Use `/status 7d`, `/status 2w`,
`/status 3m`, or a verified mention such as `@Dobby status 90d` to change it.
Supported windows are 1–365 days; `w` means seven days and `m` means 30 days.
Invalid ranges are ignored. Charts use stored observations only, with no backfill;
USD history requires a recorded, fresh USD rate at each observation. Missing
rates and observation gaps longer than three hours break chart lines. Sparse
history is labelled. USD is now fetched regardless of the display currency.

Hourly alerts retain their text format. The first album image includes three text values
as its caption, with numbers padded on the left, followed by their descriptions
in a monospace block (plus any coincident threshold alert):

```text
5,306.62  Medallion USD
   33.60  Medallion SOL
  157.94  SOL to USD
```

An uncertain message delivery is never automatically replayed.

To render an offline preview from JSON containing `snapshot` and `history`:

```sh
node scripts/render-status.js input.json data/status-preview 30d
```

Text caption / hourly alert format:

```text
Medallion:
                              450.75 USD
                                3.00 SOL

1 SOL =                       150.25 USD

A Letter from the Universe:     1.00 SOL
The Reflection of Love:         1.00 SOL
The Symbol of Love and Unity:   1.00 SOL

07 Sept 2026, 19:05 BST
```

Prices use a WhatsApp monospace block to keep the amounts right-aligned. The timestamp follows outside the block. Illustrative prices. Alert messages append a short triggered-threshold line.

Floors are lowest listed asking prices across aggregated marketplaces, excluding fees, not guaranteed sale values. The Medallion is the sum of the three floors. Invalid/missing/zero values invalidate a collection check; cached values never fill gaps. Stats have no guaranteed upstream listing freshness timestamp. Fiat rates older than five minutes never trigger fiat alerts. If FX fails, SOL stays available and the price health check fails.

Sources: [Magic Eden stats API](https://docs.magiceden.io/reference/get_collections-symbol-stats), [CoinGecko simple price](https://docs.coingecko.com/demo/reference/simple-price).

## Setup

Use Node.js 24 LTS (22.23.2+ also tested). Node's built-in SQLite avoids a separate database dependency. Node 22 prints an experimental SQLite warning.

```sh
npm ci --include=optional
cp config.example.json config.json
cp .env.example .env
npm run verify
npm run check
```

Edit private `config.json`:

```json
{
  "groupId": "YOUR_GROUP_ID@g.us",
  "displayCurrency": "USD",
  "dailySummaryTime": "18:00",
  "thresholds": [
    { "target": "medallion", "currency": "USD", "below": 6500 }
  ]
}
```

Allowed currencies: SOL, USD, GBP, EUR. Display and threshold currency are independent. Targets: `tomorrowland_winter`, `the_reflection_of_love`, `tomorrowland_love_unity`, `medallion`. At most one threshold per target; use an empty array for daily summaries only. Set a CoinGecko Demo key in `.env` if needed; it worked without a key in local validation. Private config, secrets and state are excluded from Git.

## WhatsApp

Regular WhatsApp and WhatsApp Business both work. Use the dedicated bot number, join the intended group and switch to that account on the phone before scanning.

```sh
npm run pair
npm run groups
```

Scan the QR from Linked devices → Link a device. These commands require a private interactive terminal. Never redirect pairing output. Copy the intended group ID into `config.json`, then deliberately send one test:

```sh
npm run send-test
```

Each invocation sends one real message. An acknowledgement does not prove a recipient notification. If delivery is uncertain, inspect the group before retrying. User-confirmed test delivery is recorded in [validation](docs/validation.md).

Start the continuous monitor with `npm start`, or use [the systemd service](deploy/nftomorrow.service). **Only one machine may use the saved WhatsApp session at a time.** After deployment, use WhatsApp commands on the server with the service stopped. Local `npm run check` remains safe because it does not connect to WhatsApp.

Baileys is unofficial. Its pinned npm release `7.0.0-rc14` can break or lead to account restrictions. We store credentials and Signal key batches transactionally using `BufferJSON`; no `useMultiFileAuthState`. QR sessions are recognized by the saved identity because `registered` may remain false after successful pairing. Protocol logging is disabled. State is private on disk, but not encrypted at rest. See [Baileys authentication](https://baileys.wiki/authentication/session-management).

Open the bot account online weekly; the primary-account inactivity rule is separate from keeping the Lyca number active. See [WhatsApp linked-device guidance](https://faq.whatsapp.com/378279804439436/).

## Reliability and operations

HTTP requests have timeouts and bounded retries. WhatsApp reconnects with capped exponential delays up to five minutes. No background retry resends old application messages. A unique delivery attempt and schedule state commit before sending. Interrupted/failed sends are marked uncertain and may have reached WhatsApp; to reduce duplicates we do not replay them or send an additional daily summary for that interval. A fresh alert is still allowed next hour. Exactly-once network delivery is not guaranteed.

The service uses an OS-managed SQLite lock to exclude another process sharing the data directory. SIGTERM stops sending, finishes active bookkeeping, closes the socket with a short grace period, closes SQLite and releases the lock before exiting. Journald provides bounded logs on the deployed host. Price history retains approximately one year; delivery audit is retained separately.

Optional Healthchecks.io pings report process liveness, price failures and WhatsApp health. Email notifications require the three ping URLs and verified email integrations. **Email setup was deferred by the user until after deployment.** See [operations and restore instructions](docs/operations.md) and [validation and remaining checks](docs/validation.md).

Generated stickers support plain replies for changes: reply to a sticker with a request such as 'Make the hat red'. Original photos, prompts, sticker versions and edits are saved privately in SQLite for later revisions. This applies to stickers generated after deployment of this feature. See [image sticker instructions](docs/image-stickers.md).

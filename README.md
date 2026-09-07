# nftomorrow

Tomorrowland NFT floor prices for one WhatsApp group, using Node.js, Baileys and SQLite. No AI, website, wallet access, purchases, trading or inbound chatbot.

## Behavior

- Check all three Magic Eden collections hourly, 24/7, and once on startup or reconnection.
- Alert when the full Medallion costs **less than 6,500 USD**, using a fresh CoinGecko SOL/USD rate. Repeat on every hourly check while below. Exactly 6,500 does not trigger. There is no recovery margin or crossing-only rule.
- Daily summary at **18:00 Europe/London**, following daylight saving, if no alert was attempted since the previous daily slot. Combine a coincident alert and summary into one message.
- Checks can detect a dip up to an hour late and miss short dips. “Immediately” means immediately after a check detects the threshold.
- Reconnects and restarts fetch current prices; they do not replay queued messages. Already-attempted alerts are not duplicated within the same UTC hour. First installation waits for the next daily slot; after downtime, at most the latest missed daily summary is sent with fresh prices.
- Persist history, authentication, daily state and delivery bookkeeping. Continue price checks while WhatsApp is disconnected or requires re-pairing.

The original proposal in [docs/brief.md](docs/brief.md) is historical. The behavior above incorporates the user's later changes: 18:00, a 6,500 USD Medallion threshold and hourly repeat alerts.

## Message

```text
Medallion: 6,734.35 USD (64.797 SOL)
A Letter from the Universe: 49 SOL
The Reflection of Love: 13.699 SOL
The Symbol of Love and Unity: 2.098 SOL

SOL -> USD: 103.93 USD

Date checked: 07 Sept 2026, 18:11 BST
```

Illustrative prices. Alert messages append a short triggered-threshold line.

Floors are lowest listed asking prices across aggregated marketplaces, excluding fees, not guaranteed sale values. The Medallion is the sum of the three floors. Invalid/missing/zero values invalidate a collection check; cached values never fill gaps. Stats have no guaranteed upstream listing freshness timestamp. Fiat rates older than five minutes never trigger fiat alerts. If FX fails, SOL stays available and the price health check fails.

Sources: [Magic Eden stats API](https://docs.magiceden.io/reference/get_collections-symbol-stats), [CoinGecko simple price](https://docs.coingecko.com/demo/reference/simple-price).

## Setup

Use Node.js 24 LTS (22.23.2+ also tested). Node's built-in SQLite avoids a separate database dependency. Node 22 prints an experimental SQLite warning.

```sh
npm ci --omit=optional
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

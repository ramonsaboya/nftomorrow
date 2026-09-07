# nftomorrow

A small Node.js service in development for Tomorrowland NFT floor prices and alerts to one WhatsApp group. Repository: [ramonsaboya/nftomorrow](https://github.com/ramonsaboya/nftomorrow).

**Status: price checks and one-off WhatsApp delivery work; unattended monitoring awaits alert-policy confirmation and implementation.** The DigitalOcean Droplet is available and SSH access has been verified, but the service is not deployed. The user has paired the bot and confirmed receiving a test message. This version includes read-only price checks, interactive pairing/group discovery, a one-message test command, SQLite persistence and tested transport components.

## Local use

Use an existing Node.js 24 LTS installation, or Node.js 22.23.2+. Node's built-in SQLite removes a separate database dependency; Node 22 emits an experimental SQLite warning. Do not install anything globally for this project.

```sh
npm ci --omit=optional
cp config.example.json config.json
cp .env.example .env
npm run verify
npm run check
```

`check` reads public prices and prints them. It does not connect to WhatsApp, write credentials/history, or send a message. The example configuration shows the Medallion total in USD and SOL, individual floors in SOL, the SOL/USD rate and a London-local check timestamp. Configuration files and local state are ignored by Git.

The collection symbols are:

| Target | Collection |
| --- | --- |
| `tomorrowland_winter` | A Letter from the Universe |
| `the_reflection_of_love` | The Reflection of Love |
| `tomorrowland_love_unity` | The Symbol of Love and Unity |
| `medallion` | Sum of all three floors |

Every check requests the three [Magic Eden stats endpoints](https://docs.magiceden.io/reference/get_collections-symbol-stats) with `listingAggMode=true`. Integer lamports are retained and converted to SOL for display. These are aggregated lowest asking prices, excluding fees, not guaranteed sale values. Zero, absent, nonnumeric and unsafe values invalidate a check; cached collection values never fill gaps. Local fetch age is checked, but the upstream collection stats do not provide a guaranteed listing freshness timestamp.

## Configuration

`displayCurrency` is `null` (unselected; read-only checks show SOL), `SOL`, `USD`, `GBP` or `EUR`. USD is the configured display currency. Display and threshold currencies are separate. For example, the following defines a threshold's data shape; **5 SOL is an illustration, not an accepted threshold, and threshold evaluation is not implemented yet**:

```json
{
  "groupId": null,
  "displayCurrency": "GBP",
  "thresholds": [
    { "target": "medallion", "currency": "SOL", "below": 5 }
  ]
}
```

Allow at most one threshold for each target. Invalid fields fail validation rather than silently reverting to defaults. Keep thresholds empty until chosen.

USD/GBP/EUR uses [CoinGecko's Demo simple-price endpoint](https://docs.coingecko.com/demo/reference/simple-price). Put the Demo API key in `COINGECKO_DEMO_API_KEY`, never in the JSON or repository. The client sends a key when configured. An unavailable or rejected FX request preserves SOL prices, shows fiat as unavailable, and makes `check` exit with status 1. Rates must be positive and timestamped within five minutes. Do not use fiat thresholds until valid rates are available.

## WhatsApp setup

Activate the dedicated Lyca SIM/eSIM, register its number in WhatsApp Business through SMS/call verification, set its display identity, and add it to the intended group with permission to post. In an interactive private SSH terminal:

```sh
npm run pair
npm run groups
```

Scan the QR through WhatsApp Business → Linked devices. `pair` displays secrets only on an interactive terminal; never redirect or capture its output. `groups` prints group names and IDs locally. Copy the intended `...@g.us` ID into the private configuration. Neither command sends a chat message. Stop any future daemon before pairing or discovery; the data directory admits only one process.

[Baileys session management](https://baileys.wiki/authentication/session-management) requires both credentials and Signal keys. The SQLite auth adapter uses `BufferJSON`, restores app-state protobuf values, and commits key batches before resolving. It does not use `useMultiFileAuthState`. Baileys protocol logs are disabled to protect account material. Database and lock files are mode 0600 inside a private directory; the data is not encrypted at rest.

The adapter reconnects with delays from one second up to five minutes. A terminal authentication failure persists a need to re-pair; it does not erase price/history tables. Run `pair` explicitly to replace invalid auth. Reconnection emits a fresh-check callback, and the sender accepts only the configured group. The connection behavior is covered by simulated tests; restarting with a saved QR session and fetching groups have also been verified with a live account. QR sessions are recognized by the saved account identity, not the `registered` flag, which can remain false after successful pairing.

### One-off delivery test

After pairing, run `npm run groups` and set `groupId` in `config.json` to the intended group's ID. Then run:

```sh
npm run send-test
```

This command sends **one real message** to the configured group with a fresh set of all three floors and the Medallion total. It does not enable scheduled alerts. Check the message on a recipient phone, and check notifications separately. An acknowledgement alone does not prove either. Each invocation is a new deliberate test; if delivery is reported uncertain, inspect the group before running it again. Attempts are recorded in SQLite before sending and are never automatically retried by the test command.

After a one-shot command completes, it finishes pending bookkeeping and allows up to two seconds for socket cleanup, then closes SQLite, releases the process lock, flushes terminal output and exits. It does not wait for all of Baileys' background timers or log out the paired account.

Baileys is unofficial and can break or lead to account restrictions. The npm `latest` version inspected for this implementation was `7.0.0-rc14`, a release candidate; it is pinned along with a lockfile and needs live acceptance before deployment.

The primary bot WhatsApp Business account should be opened online weekly. Its linked-device inactivity rules and the Lyca number's activity rules are separate. See the original brief and [WhatsApp's linked-device help](https://faq.whatsapp.com/777829757305409); check current carrier rules when obtaining the SIM.

## Completion gate

The following proposed rules remain unimplemented until confirmed:

- First observation below a threshold alerts, including startup; simultaneous triggers combine.
- No hourly repeats while below; recovery at 1% above the threshold re-arms it.
- Daily summary at 20:00 Europe/London with daylight saving handling.
- Suppress that summary if a threshold alert was sent since the previous daily slot; combine a coincident alert and summary.

After confirmation, remaining implementation is the hourly runtime, threshold state machine, timezone scheduling, transactional delivery orchestration, operational pings and systemd service. Delivery bookkeeping primitives already preserve unique attempts and mark interrupted attempts uncertain. This is not yet end-to-end duplicate prevention. WhatsApp and a local SQLite transaction cannot provide exactly-once delivery; the final policy must distinguish failed, acknowledged and uncertain sends and avoid blindly replaying old messages.

See [the original brief](docs/brief.md), [operations plan](docs/operations.md) and [validation record](docs/validation.md).

No AI, website, wallet connection, purchases, trading, or inbound chatbot is included.

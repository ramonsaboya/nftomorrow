Implement a small server-hosted Tomorrowland NFT price monitor that sends updates to a WhatsApp group with friends.

**Scope and architecture**

- Keep it simple: a dedicated Node.js service using Baileys for WhatsApp, with SQLite for price history, alert state and persistent authentication credentials.
- OpenClaw is not required.
- Run continuously on a small Linux VPS, with automatic startup after reboot and reconnection after temporary outages.
- No AI, website, wallet connection, purchases or trading functionality.
- This is currently a researched proposal. Nothing has been built, purchased or deployed.

**Price sources**

Use Magic Eden’s public Solana API directly. These collection symbols were verified against Tomorrowland’s official website, and their stats endpoints returned prices successfully:

- `tomorrowland_winter` — A Letter from the Universe
- `the_reflection_of_love` — The Reflection of Love
- `tomorrowland_love_unity` — The Symbol of Love and Unity

Endpoint:

```text
https://api-mainnet.magiceden.dev/v2/collections/{symbol}/stats?listingAggMode=true
```

Convert `floorPrice` from lamports to SOL. Calculate the full Medallion price by summing the three collection floors. These are lowest listed asking prices, excluding transaction fees, not guaranteed sale values.

References:

- https://nft.tomorrowland.com/
- https://tmlunite.com/en/tracker
- https://nft.hardy.se/
- https://docs.magiceden.io/reference/get_collections-symbol-stats

Use CoinGecko for optional GBP/EUR conversion. Confirm the desired display currency and threshold currency separately.

**User-required behavior**

- Check prices hourly, 24/7.
- Send a WhatsApp group alert when a configured price is below its threshold, including overnight.
- Otherwise, send prices once daily.
- Allow thresholds for individual collections and/or the combined Medallion total.

**Proposed alert semantics—confirm before implementation**

- Alert on the first observation below a threshold, including initial startup.
- Combine simultaneous threshold triggers into one message.
- Do not repeat the same alert every hour while the price remains below its threshold.
- Re-arm after recovery above the threshold; proposed recovery margin: 1%, to prevent repeated alerts from minor fluctuations.
- Proposed daily summary: 20:00 `Europe/London`, automatically respecting daylight saving time.
- Send the daily summary only if no threshold alert was sent since the previous daily summary slot.
- If a threshold alert coincides with the daily summary, send one combined message.
- Persist alert and daily-summary state across restarts.
- Hourly polling can detect a crossing up to an hour late and can miss short-lived dips.

Messages should show all three collection floors, the total, optional fiat equivalents, changes since the previous update, the observation timestamp, triggered thresholds and marketplace links.

**WhatsApp setup**

The user intends to obtain a dedicated Lyca SIM/eSIM.

Phone-side steps:

1. Activate Lyca.
2. Install WhatsApp Business and register the Lyca number through SMS/call verification.
3. Set the bot’s display name and picture.
4. Add the number to the friends’ WhatsApp group with permission to post.
5. Pair the server through WhatsApp Business → Linked devices.

The phone does not need to remain online continuously. The user should open the bot’s WhatsApp Business account while online weekly; WhatsApp can log out linked devices after more than 14 days without using the primary account. Using personal WhatsApp alone does not satisfy this for the separate bot account.

If logged out, price checks should continue, sending should pause, and an email should notify the user that re-pairing is needed. Re-fetch prices after reconnection instead of sending accumulated stale alerts.

Keeping the Lyca number active is a separate responsibility: maintain the plan or satisfy current PAYG activity rules. WhatsApp traffic over Wi-Fi does not count as SIM activity.

Baileys is unofficial and carries compatibility/account-restriction risk. The user has been informed. Do not promise uninterrupted delivery.

Documentation:

- https://baileys.wiki/
- https://baileys.wiki/authentication/session-management
- https://faq.whatsapp.com/777829757305409

**Hosting recommendation—not yet selected or purchased**

Recommended: DigitalOcean Basic bundled Droplet, 1 vCPU, 1 GB RAM, 25 GB disk, Linux, preferably London if available.

Prices researched on 7 September 2026:

- Server: $6/month before tax.
- Optional basic weekly backups: additional 20%, bringing the total to $7.20/month before tax.
- Lyca costs are separate.
- No paid WhatsApp gateway or AI usage is required.

OVHcloud advertised a cheaper VPS from £3.97/month including VAT, but the advertised configuration defaulted to 12-month prepayment. DigitalOcean was recommended for predictable flexible billing. Recheck prices and availability before purchase.

- https://www.digitalocean.com/pricing/droplets
- https://docs.digitalocean.com/products/backups/details/pricing/

**Operational requirements**

- Run as a dedicated non-root service managed by systemd.
- Use SSH-key access, a firewall and routine security updates.
- Protect WhatsApp credentials and exclude them from Git/logs.
- Persist both authentication credentials and Signal session keys correctly. Baileys explicitly discourages its example `useMultiFileAuthState` implementation for production; use a suitable transactional store.
- Use bounded retries, timeouts, rotating logs and persistent delivery bookkeeping to reduce duplicate sends.
- Missing or invalid price data must never be treated as zero.
- Only calculate the total from a complete, fresh set of prices. Do not evaluate fiat thresholds using stale exchange rates.
- Restrict sending to the configured group; no general chatbot or inbound command processing is needed.
- Add free Healthchecks.io monitoring with email notifications for failed price checks, persistent WhatsApp disconnection or server downtime.
- Keep code/configuration backed up; document restoration and re-pairing.
- Review dependencies and remove temporary scaffolding before completion.

**Still needed from the user**

- Hosting selection/account and authorized server access.
- Activated Lyca/WhatsApp Business account and group.
- Threshold values, applicable collections/total, and threshold currency.
- Display currency.
- Daily summary time.
- Confirmation of repeat-alert/recovery behavior above.
- Email for operational alerts.

**Validation before completion**

Test price parsing, conversions, missing-data handling, threshold crossing/recovery, combined alerts, daily-summary suppression, London daylight-saving behavior, restart persistence, disconnection/reconnection and duplicate prevention. Then verify actual group delivery with the user and observe at least one full daily cycle.

Do not treat an API send acknowledgement as proof that recipients received a phone notification. Report automated checks, actual WhatsApp delivery checks and remaining limitations separately.
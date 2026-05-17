# X Bulk Unfollow — Chrome Extension (Official X API v2)

> **Personal tool.** Use at your own risk. Bulk actions on X can get your account restricted.

A private, rate-limit-aware Chrome extension that lets you bulk-unfollow accounts using the **official X (Twitter) API v2** + intelligent suggestions (local heuristics + optional Grok).

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Features

- Uses official X API v2 (OAuth 2.0 PKCE)
- Fully client-side — nothing leaves your browser except to `api.x.com` and (optionally) `api.x.ai`
- Smart local scoring + optional Grok-powered analysis to decide who to unfollow first
- Strong safety limits (18s minimum delay, session caps, warnings)
- Search, filters, multi-select, CSV export, dry-run mode

> **Reality check**: The X API only allows **50 unfollows per 15 minutes**. This tool is best for thoughtful, moderate cleanup rather than mass nuking.

---

## Quick Start (5 minutes)

1. **Create an X Developer App** (you need a developer account — free to apply)
   - Go to https://developer.x.com
   - Create a **Project** + **App**
   - In the App settings:
     - Enable **OAuth 2.0**
     - Add the exact **Callback URI** that the extension will show you (it looks like `https://...chromiumapp.org/x-unfollow-oauth`)
     - Request the scopes: `users.read`, `follows.read`, `follows.write`
   - Note your **Client ID** (you will paste this once)

2. **Load the extension**
   - `chrome://extensions` → enable Developer mode → **Load unpacked**
   - Select the cloned `x-bulk-unfollow` folder
   - Pin the extension

3. **First run**
   - Click the extension icon → **Open Unfollow Manager**
   - Click the gear (⚙︎) → paste your **Client ID**
   - Click **Connect with X** and authorize the app
   - Once connected you will see your @handle in the header

4. **Load & clean**
   - Click **Load Following List**
   - Use search / verified filters
   - Select accounts → **Unfollow Selected** (or use the per-row buttons)
   - Keep the tab open while it works

---

## Installation

See the [Quick Start](#quick-start-5-minutes) section above.

For development:

```bash
git clone https://github.com/clodoan/x-bulk-unfollow.git
cd x-bulk-unfollow
# Load the folder as an unpacked extension in chrome://extensions
```

## Project Structure

```
x-bulk-unfollow/
├── manifest.json
├── background.js
├── popup.html + popup.js
├── manager.html + manager.css + manager.js   # Main UI + logic
├── lib/scoring.js               # Pure local scoring engine (testable)
├── tests/test-scoring.js
├── icons/
└── README.md
```

Everything is vanilla JavaScript, zero dependencies, and Manifest V3 compliant.

## Screenshots

> **Note**: Screenshots will be added soon. The UI includes:
> - Clean dark-themed manager tab
> - Score badges (red = strong unfollow candidate, green = keep)
> - Smart Sort that surfaces lowest-value accounts first
> - Grok analysis option (when xAI key is provided)

## Development

```bash
# Run scoring tests
node tests/test-scoring.js
```

When modifying the scoring logic, please add corresponding test cases in `tests/test-scoring.js`.

---

## Safety & Rate Limits

- Hard minimum ~12 s delay between unfollow API calls
- Automatic handling of 429 responses using the `x-rate-limit-reset` header
- Dry-run checkbox (logs what it would do)
- Confirmation modal with exact count
- All tokens stored only in Chrome's encrypted local storage
- No analytics, no telemetry, no external calls except to X

**Still — X can rate-limit or suspend accounts for "suspicious" mass actions** even when you stay inside the published limits. Use common sense. Start with small batches.

---

## FAQ

**Q: Do I need a paid X API plan?**  
Yes for write actions (`follows.write`). The free tier is read-only for most things now. Check your tier in the developer portal before expecting unfollows to succeed.

**Q: Why is it so slow compared to the old "mass unfollow" scripts?**  
Those scripts click the buttons on `x.com/following` directly (DOM automation). They are faster but fragile and technically against X's automation rules. This extension uses the official, supported, auditable API as you requested.

**Q: Can I run it in the background overnight?**  
The current version needs the manager tab to stay open. Closing the tab pauses the queue (it is saved). You can resume later.

**Q: Will this ever support "unfollow everyone who doesn't follow me back"?**  
Possible in a future version (we have the data), but it requires extra API calls per user and burns your read quota. For now you decide manually or via the visible metrics.

**Q: How do I remove the extension?**  
`chrome://extensions` → remove. All local data is deleted with it.

---

## Smart Analysis (Local + Grok)

After loading your following list you now have two powerful ways to decide **who to unfollow first**:

### 1. Local Analysis (free, instant, private)
- Click **"Run Local Analysis"**
- Every account gets a 0–100 "keep score" based on heuristics tuned for designers/engineers (activity, follower ratio, bio signals, verified status, etc.).
- Red/orange/yellow/green badges appear in the Score column.
- Hover a badge to see the specific reasons.
- Click **"Smart Sort (lowest first)"** — the worst accounts (most worth unfollowing) bubble to the top.

### 2. Grok-powered Analysis (optional, much smarter)
- Add your **xAI API key** in the Settings gear (stored only in this browser).
- Click **"Analyze with Grok"**.
- The extension sends small batches of accounts (name + bio + metrics) to Grok with a carefully written prompt that understands your taste.
- Grok returns nuanced scores + one-sentence reasons.
- Scores are cached in the current session. You can mix local + Grok scores.

**Privacy note**: Local analysis never leaves your machine. Grok analysis only sends the data you explicitly ask it to analyze, and only to xAI using *your* key.

## Safety, Abuse Prevention & Testing

This tool is deliberately designed with multiple layers of protection against misuse (both accidental and malicious).

### Hard Safety Limits (in code)
- Minimum **18 seconds** between every unfollow API call (well below X's published 50/15 min limit).
- Hard cap of **180 unfollows per browser session**.
- Large actions (30+) trigger extra warnings in the log.
- Scores (local or Grok) are **never** used to auto-select accounts. You must manually select.

### Why These Limits Exist
- X is extremely aggressive at detecting and punishing bulk unfollow behavior, even when using the official API.
- AI scoring makes it tempting to "trust the machine" and go too far, too fast. The friction and caps exist to protect *your* account.
- The extension will never exfiltrate your following list or API keys.

### Testing
The scoring engine has dedicated tests:

```bash
node tests/test-scoring.js
```

These tests explicitly verify that common spam / low-value patterns (crypto bots, follow-trains, zero-activity accounts, adult promo, etc.) are heavily down-scored, while real designers and engineers are protected.

We also maintain a manual test checklist covering:
- Rate limit header handling
- Token refresh
- Large bulk actions with the safety cap
- Grok key is never sent anywhere except to api.x.ai
- No network calls to unexpected domains

**You are ultimately responsible** for every account you unfollow. The AI and heuristics are decision-support tools only.

This turns the tool from a dumb bulk button into a genuine "following hygiene" assistant.

## Development Notes

- Open `manager.html` directly in the browser for quick CSS work (most JS will fail without the extension APIs).
- In the manager tab, open DevTools and type `XUF_DEBUG.state` to inspect everything.
- The processor log and rate pill already work and are wired to real headers.

---

## Alternatives (if the 50/15 min limit is too painful)

- https://github.com/luqmanoop/twitter-mass-unfollow — popular DOM-based extension
- https://github.com/hernaezTlon/x-following-cleaner — smart inactive-account cleaner (also DOM)
- Various Tampermonkey userscripts with random long delays (often the safest for huge lists)

If you ever want a hybrid version (API for the list + DOM for the actual unfollow clicks), let me know — it's a common request.

---

## License & Credits

Personal tool. Do whatever you want with the code. Built for Claudio in May 2026 using the official X API v2.

If you publish this or a fork to the Chrome Web Store, remember you will need to apply for OAuth client verification with X and pass store review.

---

**Made with care. Unfollow responsibly.**

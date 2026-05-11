# Auxidien Watcher

Off-chain price oracle watcher for the [Auxidien (AUXI)](https://auxidien.io) precious metals index token on BNB Smart Chain.

This service periodically fetches spot prices for the four constituent metals (XAU/XAG/XPT/XPD), computes the weighted index price, and publishes it to the on-chain `AuxidienOracle` contract using `ORACLE_ROLE`.

## Related repositories

- [`auxidien-project`](https://github.com/temelreiz/auxidien-project) — Smart contracts (AuxiToken, AuxiVesting, AuxidienOracle)
- [`auxidien-admin`](https://github.com/temelreiz/auxidien-admin) — Admin dashboard
- [`website-auxidien`](https://github.com/temelreiz/website-auxidien) — Public website

## How it works

1. Every `WATCHER_INTERVAL` ms (default 1 hour) the watcher pulls XAU/XAG/XPT/XPD prices from GoldAPI.
2. The composite index is computed using the configured weights (currently XAU 0.55, XAG 0.20, XPT 0.17, XPD 0.08).
3. The target on-chain price is clamped by `ORACLE_MAX_STEP_BPS` (default 3%) to prevent single-tick jumps.
4. If the clamped target differs from the current on-chain price, the watcher signs and submits a `setPricePerOzE6` transaction.

The on-chain oracle additionally enforces `minUpdateInterval` and `maxPriceChangeRate` server-side, so the watcher is defence-in-depth, not the only safeguard.

## Setup

```bash
npm install
cp .env.example .env
# fill in RPC_URL, ORACLE_ADDRESS, PRIVATE_KEY, GOLDAPI_KEY
```

## Running

```bash
npm start          # dev (ts-node)
npm run build      # compile to dist/
npm run start:prod # run compiled JS
```

For production deployment, run under a process manager (PM2, systemd, Docker) and monitor logs.

## Environment variables

See [`.env.example`](./.env.example) for the full list.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `RPC_URL` | yes | — | BSC RPC endpoint |
| `ORACLE_ADDRESS` | yes | — | Deployed `AuxidienOracle` address |
| `PRIVATE_KEY` | yes | — | Signer with `ORACLE_ROLE` |
| `GOLDAPI_KEY` | yes | — | GoldAPI access token |
| `WATCHER_INTERVAL` | no | `3600000` | Tick interval (ms) |
| `GOLDAPI_REQUEST_DELAY_MS` | no | `300` | Delay between metal fetches |
| `GOLDAPI_CACHE_TTL_MS` | no | `60000` | Price cache TTL |
| `ORACLE_MAX_STEP_BPS` | no | `300` | Max per-tick price step (bps) |

## Security

- Never commit `.env` — only `.env.example` is tracked.
- The `PRIVATE_KEY` should hold only `ORACLE_ROLE`, not contract ownership.
- Rotate the key if it is ever exposed; revoke the old role on-chain via the admin multisig.

## Disclaimer

This software is provided for informational purposes only and does not constitute financial advice.

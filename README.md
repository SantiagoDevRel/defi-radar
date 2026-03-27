# DeFi Radar

A self-hosted DeFi yield dashboard that reads data **100% on-chain** — no third-party APIs, no CoinGecko, no DeFiLlama. Live yield opportunities across 8 chains and 16 protocols, normalized into a single TypeScript backend.

> **Status:** Sprint 1 complete — Venus Protocol on BNB Chain live. More adapters in progress.

---

## Why DeFi Radar?

Most yield aggregators call DeFiLlama or a proprietary indexer. DeFi Radar goes directly to the source:

- **Chainlink price feeds** — on-chain USD prices, no HTTP roundtrips to price APIs.
- **Protocol contracts directly** — Venus vToken rates, AAVE `getReserveData()`, etc.
- **SQLite snapshots** — 90-day retention of hourly APY/TVL history for trend analysis.
- **Manual refresh by default** — no background polling hammering free RPC endpoints.

---

## Tech Stack

| Layer       | Technology                         |
|-------------|-------------------------------------|
| Runtime     | Node.js 18+ / TypeScript 5          |
| HTTP server | Express 4                           |
| Database    | SQLite via `better-sqlite3`         |
| EVM reads   | ethers.js v6                        |
| Solana      | `@solana/web3.js`                   |
| Stellar     | `@stellar/stellar-sdk`              |
| Deployment  | Railway (single `npm start`)        |

---

## Supported Chains & Protocols

### Chains (8)

| Chain       | Chain ID | Default RPC                                      |
|-------------|----------|--------------------------------------------------|
| Ethereum    | 1        | Alchemy/Infura (set `ETHEREUM_RPC_URL`)          |
| BNB Chain   | 56       | `https://bsc-dataseed.binance.org`               |
| Base        | 8453     | `https://mainnet.base.org`                       |
| Arbitrum    | 42161    | `https://arb1.arbitrum.io/rpc`                   |
| Polygon     | 137      | `https://polygon-rpc.com`                        |
| Avalanche   | 43114    | `https://api.avax.network/ext/bc/C/rpc`          |
| Solana      | —        | `https://api.mainnet-beta.solana.com`            |
| Stellar     | —        | Horizon `https://horizon.stellar.org`            |

### Protocols (Sprint 1: 1 live, 15 planned)

| Protocol         | Chain(s)                          | Status     |
|-----------------|-----------------------------------|------------|
| Venus Protocol  | BNB Chain                         | ✅ Live     |
| Aave v3         | Ethereum, Polygon, Arbitrum, Base | Planned    |
| Compound v3     | Ethereum, Arbitrum, Base          | Planned    |
| PancakeSwap     | BNB Chain                         | Planned    |
| Uniswap v3      | Multi-chain                       | Planned    |
| Curve Finance   | Multi-chain                       | Planned    |
| GMX             | Arbitrum, Avalanche               | Planned    |
| Trader Joe      | Avalanche, Arbitrum               | Planned    |
| BENQI           | Avalanche                         | Planned    |
| Rocket Pool     | Ethereum                          | Planned    |
| Lido Finance    | Ethereum                          | Planned    |
| Radiant Capital | Arbitrum, BNB Chain               | Planned    |
| Pendle Finance  | Multi-chain                       | Planned    |
| Orca            | Solana                            | Planned    |
| Marinade        | Solana                            | Planned    |
| Blend           | Stellar                           | Planned    |

---

## Token Whitelist (41 tokens)

Tokens are tiered to prevent noise from low-quality assets:

| Tier | Description    | Min TVL    | Tokens |
|------|----------------|------------|--------|
| 1    | Blue chips     | Always     | BTC, ETH, BNB, SOL, ADA, XLM, AVAX, LINK, DOT, MATIC |
| 2    | Stablecoins    | Always     | USDC, USDT, DAI, PYUSD, FRAX, EURC, USDe |
| 3    | DeFi protocols | $100M TVL  | AAVE, UNI, CAKE, CRV, LDO, MKR, COMP, GMX, JOE, BLND, XVS, QI, RPL |
| 4    | Ecosystem      | Always     | ARB, OP, SUI, TON, STX, NEAR, BIFI, PENDLE, MORPHO, GNS, RDNT |

Meme coins (DOGE, SHIB, PEPE, FLOKI, BONK, WIF, TRUMP) are hard-blacklisted.

---

## Risk Score (1–10)

Each pool gets an automated risk score based on five factors:

| Factor            | Safe (0 pts)   | Moderate (1–2) | Risky (3–4)     |
|-------------------|----------------|----------------|-----------------|
| Protocol age      | > 3 years      | 1–3 years      | < 1 year        |
| Audit status      | Top firm       | Known firm     | No audit        |
| TVL               | > $100M        | $10–100M       | < $10M          |
| APY composition   | 100% base      | Mixed          | 100% emissions  |
| IL exposure       | None (lending) | Moderate (LP)  | High (volatile) |

Score 1–3 = safe, 4–6 = moderate, 7–10 = high risk.

---

## Quick Start

### Prerequisites

- Node.js 18+
- A free [Alchemy](https://www.alchemy.com) key (for Ethereum; other chains use public RPCs)

### 1. Clone and install

```bash
git clone https://github.com/santiagotrujilloz/defi-radar.git
cd defi-radar
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env and add your ETHEREUM_RPC_URL
```

### 3. Start the server

```bash
# Development (ts-node, hot reload)
npm run dev

# Production
npm run build && npm start
```

The server starts at `http://localhost:3001`.

---

## API Reference

All endpoints return JSON. Read endpoints are public; `POST /api/refresh` requires an API key when `API_SECRET_KEY` is set.

### GET /api/health

Service health, DB stats, and refresh status.

```json
{
  "status": "ok",
  "version": "1.0.0",
  "uptime": 3600,
  "db": { "poolCount": 42, "historyRowCount": 1260 },
  "refresh": { "status": "idle", "poolCount": 42, "lastDurationMs": 4200 }
}
```

### GET /api/yields

All yield pools, sorted by total APY descending.

```json
{
  "count": 42,
  "pools": [
    {
      "id": "venus-bnb-0x...",
      "protocol": "venus",
      "chain": "bnb",
      "type": "lending",
      "tokens": ["USDC"],
      "apyBase": 4.21,
      "apyReward": 1.88,
      "apyTotal": 6.09,
      "apyTotalFormatted": "6.09%",
      "tvlUsd": 45200000,
      "tvlFormatted": "$45.20M",
      "riskScore": 3,
      "riskLabel": "safe",
      "isStale": false
    }
  ]
}
```

### GET /api/yields/chain/:chain

Filter by chain: `ethereum`, `bnb`, `base`, `arbitrum`, `polygon`, `avalanche`, `solana`, `stellar`.

### GET /api/yields/token/:symbol

Filter by token symbol (case-insensitive): `/api/yields/token/USDC`.

### GET /api/yields/:id

Single pool by ID.

### GET /api/yields/:id/history?days=30

APY and TVL history for up to 90 days.

### GET /api/whitelist

Current token whitelist with tier information.

### GET /api/protocols

Protocol registry with metadata (audit status, age, chains).

### POST /api/refresh

Trigger a manual refresh. Returns `202 Accepted` immediately; refresh runs in background.

```bash
curl -X POST http://localhost:3001/api/refresh \
  -H "X-Api-Key: your_secret" \
  -H "Content-Type: application/json" \
  -d '{"chains": ["bnb"]}'   # optional: filter by chain or protocol
```

### GET /api/refresh/status

Current refresh progress (status, last run time, pool count).

---

## Project Structure

```
src/
├── index.ts                    # Express server entry
├── config/
│   ├── chains.ts               # 8 chain configs (RPC, chainId)
│   ├── whitelist.ts            # 41-token whitelist (4 tiers)
│   └── protocols.ts            # Protocol registry (audit, age, chains)
├── adapters/
│   ├── types.ts                # YieldPool, ProtocolAdapter interfaces
│   ├── base-evm-adapter.ts     # Shared EVM logic (provider, retry)
│   └── venus.ts                # Venus Protocol on BNB Chain
├── services/
│   ├── yield-aggregator.ts     # Runs all adapters, normalizes results
│   ├── risk-calculator.ts      # 5-factor risk score (1–10)
│   ├── price-service.ts        # Chainlink on-chain price feeds
│   └── refresh-manager.ts      # Manual + optional auto-refresh
├── db/
│   ├── database.ts             # SQLite init + migrations
│   └── queries.ts              # Typed read/write queries
├── api/
│   ├── routes.ts               # Express route handlers
│   └── middleware.ts           # CORS, auth, logging, errors
└── utils/
    ├── apy-math.ts             # APY / RAY / WAD conversion helpers
    ├── format.ts               # Number formatting, pool ID generation
    └── logger.ts               # Structured JSON/pretty logger
```

---

## Adding a New Adapter

1. Create `src/adapters/my-protocol.ts` extending `BaseEvmAdapter` (or write a standalone class for Solana/Stellar).
2. Implement `fetchPools(): Promise<YieldPool[]>`.
3. Add the protocol metadata to `src/config/protocols.ts`.
4. Register the adapter in `src/services/yield-aggregator.ts`.

The adapter will be automatically included in all refresh cycles.

---

## Deployment (Railway)

```bash
# Link to Railway project
railway login && railway link

# Deploy
railway up
```

Set environment variables in Railway's dashboard (copy from `.env.example`). Railway auto-detects `npm start` from `package.json`.

---

## Data Freshness & Staleness

| State       | Condition       | UI Indicator           |
|-------------|-----------------|------------------------|
| Fresh       | < 6 hours old   | Normal                 |
| Stale       | 6–24 hours old  | Yellow tint            |
| Very stale  | > 24 hours old  | Orange badge           |

Auto-refresh is **off by default**. Enable it by setting `AUTO_REFRESH_INTERVAL_MINUTES=30` in `.env`.

---

## License

MIT — use freely, attribution appreciated.

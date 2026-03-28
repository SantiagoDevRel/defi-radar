/**
 * DeFi Radar — Express server entry point.
 *
 * Startup sequence:
 * 1. Load environment variables from .env
 * 2. Initialize the SQLite database (run migrations)
 * 3. Mount API routes
 * 4. Start listening
 * 5. Optionally enable auto-refresh if AUTO_REFRESH_INTERVAL_MINUTES > 0
 */

import 'dotenv/config';
import express from 'express';
import { corsMiddleware, requestLogger, errorHandler, notFound } from './api/middleware';
import routes from './api/routes';
import { initDatabase, closeDb } from './db/database';
import { refreshManager } from './services/refresh-manager';
import { logger } from './utils/logger';

// ---------------------------------------------------------------------------
// App setup
// ---------------------------------------------------------------------------

const app = express();

// Trust Railway/Render proxy headers
app.set('trust proxy', 1);

// Body parsing
app.use(express.json());

// CORS
app.use(corsMiddleware);

// Request logging
app.use(requestLogger);

// Root landing page — full yield dashboard
app.get('/', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(DASHBOARD_HTML);
});

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>DeFi Radar — On-Chain Yield Dashboard</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0d1117;--surface:#161b22;--border:#30363d;--text:#e6edf3;--muted:#8b949e;
  --blue:#58a6ff;--green:#3fb950;--yellow:#d29922;--red:#f85149;
  --risk-safe:#238636;--risk-mod:#9a6700;--risk-high:#b62324;
  --font:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
}
body{font-family:var(--font);background:var(--bg);color:var(--text);min-height:100vh;padding:0}

/* ── Header ── */
header{background:var(--surface);border-bottom:1px solid var(--border);padding:.75rem 1.25rem;
  display:flex;align-items:center;gap:.75rem;flex-wrap:wrap}
.logo{font-size:1.2rem;font-weight:700;white-space:nowrap}
.logo span{color:var(--blue)}
.subtitle{color:var(--muted);font-size:.8rem;flex:1;min-width:140px}
.header-right{display:flex;align-items:center;gap:.6rem;flex-wrap:wrap;margin-left:auto}
#last-updated{color:var(--muted);font-size:.75rem;white-space:nowrap}
#refresh-btn{background:#238636;color:#fff;border:none;border-radius:6px;
  padding:.4rem .85rem;font-size:.8rem;cursor:pointer;white-space:nowrap;font-weight:600}
#refresh-btn:disabled{opacity:.5;cursor:not-allowed}
#refresh-btn.running{background:#1f6feb;animation:pulse 1.4s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.6}}

/* ── Controls ── */
.controls{display:flex;gap:.5rem;flex-wrap:wrap;padding:.75rem 1.25rem;
  background:var(--surface);border-bottom:1px solid var(--border);align-items:center}
.controls select,.controls input{background:#0d1117;color:var(--text);border:1px solid var(--border);
  border-radius:6px;padding:.35rem .65rem;font-size:.8rem;outline:none}
.controls select:focus,.controls input:focus{border-color:var(--blue)}
.toggle-label{display:flex;align-items:center;gap:.4rem;font-size:.8rem;color:var(--muted);
  cursor:pointer;user-select:none;white-space:nowrap}
.toggle-label input[type=checkbox]{accent-color:var(--blue);width:14px;height:14px}
.stat-pill{background:#161b22;border:1px solid var(--border);border-radius:20px;
  padding:.25rem .7rem;font-size:.75rem;color:var(--muted);white-space:nowrap}
.stat-pill b{color:var(--text)}
.controls-spacer{flex:1}

/* ── Table ── */
.table-wrap{overflow-x:auto;padding:0 1.25rem 2rem}
table{width:100%;border-collapse:collapse;font-size:.8rem;margin-top:.75rem;min-width:780px}
thead th{background:var(--surface);color:var(--muted);font-size:.7rem;text-transform:uppercase;
  letter-spacing:.06em;padding:.55rem .6rem;text-align:left;border-bottom:2px solid var(--border);
  white-space:nowrap;position:sticky;top:0;z-index:2;cursor:pointer;user-select:none}
thead th:hover{color:var(--text)}
thead th.sorted{color:var(--blue)}
thead th .sort-arrow{margin-left:.3rem;opacity:.5}
thead th.sorted .sort-arrow{opacity:1}
tbody tr{border-bottom:1px solid #21262d}
tbody tr:hover{background:#1c2128}
td{padding:.5rem .6rem;vertical-align:middle;white-space:nowrap}
.protocol-badge{display:inline-flex;align-items:center;gap:.3rem;background:#21262d;
  border-radius:4px;padding:.15rem .45rem;font-weight:600;font-size:.75rem}
.chain-badge{display:inline-block;border-radius:4px;padding:.12rem .4rem;font-size:.7rem;font-weight:600;opacity:.9}
.chain-ethereum{background:#3c3061;color:#a78bfa}
.chain-bnb{background:#3a2c05;color:#f0b90b}
.chain-arbitrum{background:#0c2040;color:#12aaff}
.chain-polygon{background:#2d1661;color:#8247e5}
.chain-avalanche{background:#3a0a0a;color:#e84142}
.chain-base{background:#0a1628;color:#0052ff}
.apy-total{font-weight:700;color:var(--green)}
.apy-base{color:var(--text)}
.apy-reward{color:#d2a679}
.risk{display:inline-block;border-radius:3px;padding:.1rem .4rem;font-size:.7rem;font-weight:700}
.risk-safe{background:rgba(35,134,54,.25);color:#3fb950;border:1px solid rgba(35,134,54,.5)}
.risk-mod{background:rgba(154,103,0,.25);color:#d29922;border:1px solid rgba(154,103,0,.5)}
.risk-high{background:rgba(182,35,36,.25);color:#f85149;border:1px solid rgba(182,35,36,.5)}
.tokens{color:var(--text)}
.tvl{color:var(--muted)}
.no-data{text-align:center;padding:3rem;color:var(--muted)}
.no-data b{display:block;font-size:1.1rem;margin-bottom:.5rem;color:var(--text)}
a.pool-link{color:var(--blue);text-decoration:none;font-size:.7rem}
a.pool-link:hover{text-decoration:underline}

/* ── Loading spinner ── */
#loading{display:none;text-align:center;padding:3rem;color:var(--muted)}
#loading.visible{display:block}
.spinner{width:28px;height:28px;border:3px solid var(--border);border-top-color:var(--blue);
  border-radius:50%;animation:spin .7s linear infinite;margin:0 auto 1rem}
@keyframes spin{to{transform:rotate(360deg)}}

/* ── Error banner ── */
#error-banner{display:none;background:#2d0e0e;border:1px solid var(--red);border-radius:6px;
  padding:.65rem 1rem;margin:.75rem 1.25rem;font-size:.82rem;color:var(--red)}
#error-banner.visible{display:block}
</style>
</head>
<body>

<header>
  <div class="logo">DeFi <span>Radar</span></div>
  <div class="subtitle">100% on-chain yield — no third-party APIs</div>
  <div class="header-right">
    <span id="last-updated">Not loaded</span>
    <button id="refresh-btn" onclick="triggerRefresh()">Refresh All</button>
  </div>
</header>

<div class="controls">
  <select id="chain-filter" onchange="applyFilters()">
    <option value="">All Chains</option>
  </select>
  <select id="protocol-filter" onchange="applyFilters()">
    <option value="">All Protocols</option>
  </select>
  <select id="token-filter" onchange="applyFilters()">
    <option value="">All Tokens</option>
  </select>
  <input id="search" type="text" placeholder="Search..." oninput="applyFilters()" style="width:130px"/>
  <label class="toggle-label">
    <input type="checkbox" id="hide-values" onchange="applyFilters()"/> Hide Values
  </label>
  <div class="controls-spacer"></div>
  <span class="stat-pill">Pools: <b id="pool-count">—</b></span>
  <span class="stat-pill">TVL: <b id="total-tvl">—</b></span>
</div>

<div id="error-banner"></div>
<div id="loading" class="visible"><div class="spinner"></div>Loading pools from DB…</div>

<div class="table-wrap">
<table id="yields-table">
<thead>
  <tr>
    <th onclick="sortBy('protocol')">Protocol<span class="sort-arrow">↕</span></th>
    <th onclick="sortBy('chain')">Chain<span class="sort-arrow">↕</span></th>
    <th>Tokens</th>
    <th onclick="sortBy('apyBase')" class="sorted">Base APY<span class="sort-arrow">↓</span></th>
    <th onclick="sortBy('apyReward')">Reward APY<span class="sort-arrow">↕</span></th>
    <th onclick="sortBy('apyTotal')">Total APY<span class="sort-arrow">↕</span></th>
    <th onclick="sortBy('tvlUsd')">TVL<span class="sort-arrow">↕</span></th>
    <th onclick="sortBy('riskScore')">Risk<span class="sort-arrow">↕</span></th>
  </tr>
</thead>
<tbody id="table-body"></tbody>
</table>
</div>

<script>
let allPools = [];
let sortCol = 'apyTotal';
let sortDir = -1; // -1 = desc, 1 = asc

// ── Data loading ──────────────────────────────────────────────────────────

async function loadPools() {
  showLoading(true);
  hideError();
  try {
    const r = await fetch('/api/yields');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    allPools = data.pools || [];
    populateFilters(allPools);
    applyFilters();
    const now = new Date().toLocaleTimeString();
    document.getElementById('last-updated').textContent = 'Updated ' + now;
  } catch (e) {
    showError('Failed to load pools: ' + e.message);
  } finally {
    showLoading(false);
  }
}

// ── Filters & rendering ───────────────────────────────────────────────────

function applyFilters() {
  const chainF    = document.getElementById('chain-filter').value;
  const protoF    = document.getElementById('protocol-filter').value;
  const tokenF    = document.getElementById('token-filter').value;
  const search    = document.getElementById('search').value.toLowerCase();
  const hideVals  = document.getElementById('hide-values').checked;

  let pools = allPools.filter(p => {
    if (chainF  && p.chain !== chainF) return false;
    if (protoF  && p.protocol !== protoF) return false;
    if (tokenF  && !(p.tokens || []).some(t => t.toUpperCase() === tokenF.toUpperCase())) return false;
    if (search) {
      const haystack = [p.protocol, p.chain, ...(p.tokens||[])].join(' ').toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });

  // Sort
  pools = pools.slice().sort((a, b) => {
    let av = a[sortCol], bv = b[sortCol];
    if (typeof av === 'string') return av.localeCompare(bv) * sortDir;
    return ((av || 0) - (bv || 0)) * sortDir;
  });

  renderTable(pools, hideVals);
  updateStats(pools);
}

function renderTable(pools, hideVals) {
  const tbody = document.getElementById('table-body');
  if (!pools.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="no-data"><b>No pools found</b>Run POST /api/refresh to fetch on-chain data.</td></tr>';
    return;
  }
  tbody.innerHTML = pools.map(p => {
    const tokens  = (p.tokens || []).join(' / ');
    const baseApy = fmtApy(p.apyBase);
    const rewApy  = fmtApy(p.apyReward);
    const totApy  = fmtApy(p.apyTotal);
    const tvl     = hideVals ? '—' : fmtTvl(p.tvlUsd);
    const risk    = p.riskScore || 0;
    const riskCls = risk <= 3 ? 'risk-safe' : risk <= 6 ? 'risk-mod' : 'risk-high';
    const protoBg = protoColor(p.protocol);
    return \`<tr>
      <td><span class="protocol-badge" style="border-left:3px solid \${protoBg}">\${p.protocolDisplay || p.protocol}</span></td>
      <td><span class="chain-badge chain-\${p.chain}">\${p.chain}</span></td>
      <td class="tokens">\${tokens}</td>
      <td class="apy-base">\${baseApy}</td>
      <td class="apy-reward">\${rewApy}</td>
      <td class="apy-total">\${totApy}</td>
      <td class="tvl">\${tvl}</td>
      <td><span class="risk \${riskCls}">\${risk}</span></td>
    </tr>\`;
  }).join('');
}

function updateStats(pools) {
  document.getElementById('pool-count').textContent = pools.length;
  const tvl = pools.reduce((s, p) => s + (p.tvlUsd || 0), 0);
  document.getElementById('total-tvl').textContent = fmtTvl(tvl);
}

function populateFilters(pools) {
  const chains    = [...new Set(pools.map(p => p.chain))].sort();
  const protocols = [...new Set(pools.map(p => p.protocol))].sort();
  const tokens    = [...new Set(pools.flatMap(p => p.tokens || []))].sort();

  fillSelect('chain-filter',    chains,    'All Chains');
  fillSelect('protocol-filter', protocols, 'All Protocols');
  fillSelect('token-filter',    tokens,    'All Tokens');
}

function fillSelect(id, values, placeholder) {
  const sel = document.getElementById(id);
  const cur = sel.value;
  sel.innerHTML = '<option value="">' + placeholder + '</option>' +
    values.map(v => \`<option value="\${v}" \${v===cur?'selected':''}>\${v}</option>\`).join('');
}

// ── Sorting ───────────────────────────────────────────────────────────────

function sortBy(col) {
  if (sortCol === col) sortDir *= -1;
  else { sortCol = col; sortDir = col === 'riskScore' || col === 'chain' || col === 'protocol' ? 1 : -1; }
  // Update header arrow highlights
  document.querySelectorAll('thead th').forEach(th => {
    th.classList.remove('sorted');
    const arrow = th.querySelector('.sort-arrow');
    if (arrow) arrow.textContent = '↕';
  });
  const ths = document.querySelectorAll('thead th');
  const colIndex = ['protocol','chain','tokens','apyBase','apyReward','apyTotal','tvlUsd','riskScore'].indexOf(col);
  if (colIndex >= 0) {
    ths[colIndex].classList.add('sorted');
    const arrow = ths[colIndex].querySelector('.sort-arrow');
    if (arrow) arrow.textContent = sortDir === -1 ? '↓' : '↑';
  }
  applyFilters();
}

// ── Refresh ───────────────────────────────────────────────────────────────

async function triggerRefresh() {
  const btn = document.getElementById('refresh-btn');
  btn.disabled = true;
  btn.classList.add('running');
  btn.textContent = 'Refreshing…';
  hideError();

  try {
    const r = await fetch('/api/refresh', { method: 'POST' });
    if (!r.ok && r.status !== 202) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error || 'HTTP ' + r.status);
    }
    await pollRefreshStatus();
    await loadPools();
  } catch (e) {
    showError('Refresh failed: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.classList.remove('running');
    btn.textContent = 'Refresh All';
  }
}

async function pollRefreshStatus() {
  for (let i = 0; i < 120; i++) {
    await sleep(2000);
    try {
      const r = await fetch('/api/refresh/status');
      if (!r.ok) continue;
      const s = await r.json();
      if (s.status === 'idle' || s.status === 'completed') return;
      if (s.status === 'error') throw new Error(s.error || 'Refresh error');
    } catch (e) {
      if (i > 5) throw e; // give it a few retries on network errors
    }
  }
  // Timed out — just reload whatever is in DB
}

// ── Helpers ───────────────────────────────────────────────────────────────

function fmtApy(v) {
  if (v === null || v === undefined) return '—';
  return (v || 0).toFixed(2) + '%';
}

function fmtTvl(v) {
  if (!v) return '$0';
  if (v >= 1e9)  return '$' + (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6)  return '$' + (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3)  return '$' + (v / 1e3).toFixed(1) + 'K';
  return '$' + v.toFixed(0);
}

function protoColor(p) {
  const colors = {
    venus:'#d89b0c',pancakeswap:'#d1884f',aave:'#b6509e',
    compound:'#00d395','lido-finance':'#00a3ff',curve:'#3465a4'
  };
  return colors[p] || '#8b949e';
}

function showLoading(v) {
  document.getElementById('loading').classList.toggle('visible', v);
}
function showError(msg) {
  const el = document.getElementById('error-banner');
  el.textContent = msg;
  el.classList.add('visible');
}
function hideError() {
  document.getElementById('error-banner').classList.remove('visible');
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Init ──────────────────────────────────────────────────────────────────
loadPools();
</script>
</body>
</html>`;

// API routes (all under /api)
app.use('/api', routes);

// 404 + error handlers (must be last)
app.use(notFound);
app.use(errorHandler);

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function start(): Promise<void> {
  const port = parseInt(process.env['PORT'] ?? '3001', 10);

  // Initialize DB (async WASM load + schema migration)
  try {
    await initDatabase();
    logger.info('[Startup] Database initialized');
  } catch (err) {
    logger.error('[Startup] Failed to initialize database', {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }

  // Optional auto-refresh
  const autoRefreshMinutes = parseInt(
    process.env['AUTO_REFRESH_INTERVAL_MINUTES'] ?? '0',
    10
  );
  if (autoRefreshMinutes > 0) {
    refreshManager.startAutoRefresh(autoRefreshMinutes);
    logger.info(`[Startup] Auto-refresh enabled: every ${autoRefreshMinutes} min`);
  } else {
    logger.info('[Startup] Auto-refresh disabled (manual refresh only)');
  }

  // Start server
  app.listen(port, () => {
    logger.info(`[Startup] DeFi Radar running on http://localhost:${port}`);
    logger.info(`[Startup] API docs: http://localhost:${port}/api/health`);
  });
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

function shutdown(signal: string): void {
  logger.info(`[Shutdown] Received ${signal}, shutting down gracefully`);
  refreshManager.stopAutoRefresh();
  closeDb();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// Handle unhandled promise rejections (e.g. from fire-and-forget refreshes)
process.on('unhandledRejection', (reason) => {
  logger.error('[Process] Unhandled promise rejection', {
    reason: reason instanceof Error ? reason.message : String(reason),
  });
});

start().catch((err) => {
  logger.error('[Startup] Fatal error', {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});

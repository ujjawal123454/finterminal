
/* ══════════════════════════════════════════════
   FinTerminal — app.js
   ══════════════════════════════════════════════ */

// Auto-detect API base: same origin when deployed, localhost for dev
const API = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
  ? 'http://localhost:3000'
  : window.location.origin;
let sessionId = localStorage.getItem('neo_session') || null;
let tvChart = null, priceSeries = null, ws = null, wsReconnectTimer = null;
let modalChart = null, modalSeries = null;
let currentAsset = 'NIFTY', lastPremium = null;
let ocData = [];

// ── Tab switching ──────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('panel-' + tab).classList.add('active');
    if (tab === 'option-chain') loadOptionChain();
    if (tab === 'market-pulse') loadMarketPulse();
    if (tab === 'ipo-bonds') loadIpoDashboard();
    if (tab === 'global') loadGlobal();
    if (tab === 'fii-dii') loadFiiDii();
  });
});

async function init() {
    console.log("[Init] Starting FinTerminal...");
    try {
        initChart();
        updateTicker();
        setInterval(updateTicker, 15000);
        
        // Start straddle polling
        fetchStraddlePremium();
        straddlePollTimer = setInterval(fetchStraddlePremium, 5000);
        
        renderWatchlist();
        setInterval(refreshWatchlistPrices, 30000);

        // Load data for the currently active tab
        const activeTab = document.querySelector('.tab-btn.active')?.dataset.tab;
        if (activeTab === 'ipo-bonds') loadIpoDashboard();
        if (activeTab === 'fii-dii') loadFiiDii();
        if (activeTab === 'global') loadGlobal();
        
    } catch (e) {
        console.error("[Init] Error during startup:", e);
    }
}

// ── Ticker ────────────────────────────────────
async function updateTicker() {
  try {
    const [idx, vix] = await Promise.all([
      fetch(`${API}/api/indices`).then(r => r.json()),
      fetch(`${API}/api/vix`).then(r => r.json())
    ]);
    setTicker('tn', idx.NIFTY);
    setTicker('tb', idx.BANKNIFTY);
    setTicker('tf', idx.FINNIFTY);
    setTicker('ts', idx.SENSEX);
    // Update sidebar market overview
    updateSidebar(idx, vix);
    const vc = vix.change >= 0;
    document.getElementById('tv-price').textContent = vix.vix?.toFixed(2) ?? '—';
    const tvch = document.getElementById('tv-change');
    tvch.textContent = `${vc?'+':''}${vix.change?.toFixed(2)} (${vix.change_pct?.toFixed(2)}%)`;
    tvch.className = 'ticker-change ' + (vc ? 'up' : 'down');
    document.getElementById('ticker-time').textContent = 'Updated ' + new Date().toLocaleTimeString('en-IN');
  } catch(e) { console.warn('Ticker err', e); }
}

function setTicker(id, d) {
  if (!d) return;
  const up = d.change >= 0;
  const priceEl = document.getElementById(id + '-price');
  const oldVal = priceEl.textContent;
  const newVal = d.price?.toLocaleString('en-IN', {minimumFractionDigits:2}) ?? '—';
  if (oldVal !== newVal) {
    priceEl.classList.remove('flash-up','flash-down');
    void priceEl.offsetWidth;
    priceEl.classList.add(up ? 'flash-up' : 'flash-down');
  }
  priceEl.textContent = newVal;
  const chEl = document.getElementById(id + '-change');
  chEl.textContent = `${up?'+':''}${d.change?.toFixed(2)} (${d.change_pct?.toFixed(2)}%)`;
  chEl.className = 'ticker-change ' + (up ? 'up' : 'down');
}

function updateSidebar(idx, vix) {
  const fmt = (d) => d ? `${d.price?.toLocaleString('en-IN')} <span class="${d.change >= 0 ? 'up' : 'down'}">${d.change >= 0 ? '+' : ''}${d.change?.toFixed(2)}</span>` : '—';
  const el = id => document.getElementById(id);
  if (el('sidebar-sensex')) el('sidebar-sensex').innerHTML = fmt(idx.SENSEX);
  if (el('sidebar-nifty')) el('sidebar-nifty').innerHTML = fmt(idx.NIFTY);
  if (el('sidebar-bnifty')) el('sidebar-bnifty').innerHTML = fmt(idx.BANKNIFTY);
  if (el('sidebar-vix') && vix) el('sidebar-vix').innerHTML = `${vix.vix?.toFixed(2)} <span class="${vix.change >= 0 ? 'up' : 'down'}">${vix.change >= 0 ? '+' : ''}${vix.change?.toFixed(2)}</span>`;
}

// Moved to init()

// ── Chart ─────────────────────────────────────
function initChart() {
  const el = document.getElementById('tvchart');
  tvChart = LightweightCharts.createChart(el, {
    layout: { background:{type:'solid',color:'transparent'}, textColor:'#7a8ba8', fontFamily:'JetBrains Mono' },
    grid: { vertLines:{color:'rgba(255,255,255,0.04)'}, horzLines:{color:'rgba(255,255,255,0.04)'} },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    rightPriceScale: { borderColor:'rgba(255,255,255,0.07)' },
    timeScale: { borderColor:'rgba(255,255,255,0.07)', timeVisible:true, secondsVisible:false },
    handleScroll: true, handleScale: true,
  });
  priceSeries = tvChart.addLineSeries({
    color:'#00d4ff', lineWidth:2,
    crosshairMarkerRadius:5, lastValueVisible:true,
    priceLineVisible:true,
    priceLineColor:'rgba(0,212,255,0.4)',
  });
  new ResizeObserver(() => {
    tvChart.applyOptions({ width: el.clientWidth, height: el.clientHeight });
  }).observe(el);
}

function onAssetChange() {
  currentAsset = document.getElementById('asset-select').value;
  document.getElementById('chart-title').textContent = `${currentAsset} ATM Straddle`;
  if (priceSeries) priceSeries.setData([]);
  lastPremium = null;
  fetchStraddlePremium(); // immediately fetch on change
}

// ── Straddle REST polling (works without Kotak Neo) ───────────────────────
let straddlePollTimer = null;
let straddleHistory = [];

async function fetchStraddlePremium() {
  try {
    const sym = document.getElementById('asset-select').value;
    const d = await fetch(`${API}/api/option-chain/${sym}`).then(r => r.json());
    if (!d.rows || !d.rows.length || !d.spot) return;

    const atm = d.atm;
    const atmRow = d.rows.find(r => r.strike === atm)
      || d.rows.reduce((best, r) => Math.abs(r.strike - d.spot) < Math.abs(best.strike - d.spot) ? r : best, d.rows[0]);

    if (!atmRow) return;
    const premium = (atmRow.ce?.ltp || 0) + (atmRow.pe?.ltp || 0);
    if (premium <= 0) return;

    // Update display
    document.getElementById('spot-price').textContent = d.spot.toLocaleString('en-IN');
    document.getElementById('atm-strike').textContent = atmRow.strike.toLocaleString('en-IN');
    document.getElementById('pcr-val').textContent = d.pcr;

    // Update chart
    const t = Math.floor(Date.now() / 1000);
    if (priceSeries) {
      // Avoid duplicate timestamps
      const last = straddleHistory[straddleHistory.length - 1];
      if (!last || last.time < t) {
        straddleHistory.push({ time: t, value: premium });
        // Keep last 500 points
        if (straddleHistory.length > 500) straddleHistory.shift();
        priceSeries.setData(straddleHistory);
      }
    }

    // Update sidebar premium
    if (lastPremium !== null) {
      const chg = premium - lastPremium;
      const pct = (chg / lastPremium * 100).toFixed(2);
      const el = document.getElementById('premium-change');
      el.textContent = `${chg >= 0 ? '+' : ''}${chg.toFixed(2)} (${pct}%)`;
      el.className = 'prem-change ' + (chg >= 0 ? 'up' : 'down');
    }
    document.getElementById('premium-value').textContent = '₹ ' + premium.toFixed(2);
    lastPremium = premium;

    // Mark as live via REST
    const dot = document.getElementById('live-dot');
    const st = document.getElementById('live-status');
    if (dot && !dot.classList.contains('on')) {
      dot.className = 'live-dot on';
      if (st) st.textContent = 'Live (Option Chain)';
    }
  } catch(e) {
    console.warn('Straddle poll error:', e);
  }
}

function setConnectionState(live) {
  isLive = live;
  const dot = document.getElementById('conn-dot');
  const lbl = document.getElementById('conn-label');
  const loginCard = document.getElementById('login-card');
  const statusEl = document.getElementById('neo-status');
  const liveDot = document.getElementById('live-dot');
  const liveStatus = document.getElementById('live-status');
  
  if (live) {
    if (dot) { dot.style.background = '#00ff88'; dot.style.boxShadow = '0 0 10px #00ff88'; }
    if (lbl) { lbl.textContent = 'Connected'; lbl.style.color = '#00ff88'; }
    if(loginCard) loginCard.style.display = 'none';
    if(liveDot) liveDot.className = 'live-dot on';
    if(liveStatus) liveStatus.textContent = 'Live Data (Kotak Neo)';
  } else {
    if (dot) { dot.style.background = '#ff4444'; dot.style.boxShadow = '0 0 10px #ff4444'; }
    if (lbl) { lbl.textContent = 'Disconnected'; lbl.style.color = '#ff4444'; }
    if(loginCard) loginCard.style.display = 'block';
    if(statusEl && statusEl.textContent === 'Connected') {
        statusEl.textContent = 'Session Expired';
        statusEl.style.color = '#ff4444';
    }
    if(liveDot) liveDot.className = 'live-dot';
    if(liveStatus) liveStatus.textContent = 'Offline';
  }
}

function startStraddlePolling() {
  fetchStraddlePremium();
  clearInterval(straddlePollTimer);
  straddlePollTimer = setInterval(fetchStraddlePremium, 60000); // every 60s
}


// ── Kotak Login ───────────────────────────────
async function loginNeo() {
  const btn = document.getElementById('neo-login-btn');
  const status = document.getElementById('neo-status');
  btn.disabled = true; btn.textContent = 'Connecting…';
  
  const ucc = document.getElementById('neo-ucc').value.trim();
  const mobile = document.getElementById('neo-mobile').value.trim();
  const password = document.getElementById('neo-password').value;
  const mpin = document.getElementById('neo-mpin').value;
  const totp = document.getElementById('neo-totp').value.trim();

  const body = { ucc, mobile, password, mpin, totp };
  
  try {
    const res = await fetch(`${API}/api/neo/login`, {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)
    }).then(r => r.ok ? r.json() : r.json().then(err => { throw new Error(err.detail || 'Login failed') }));

    if (res && res.success) {
      sessionId = res.session_id;
      localStorage.setItem('neo_session', sessionId);
      
      // Save credentials for next time (excluding TOTP)
      localStorage.setItem('neo_creds', JSON.stringify({ ucc, mobile, password, mpin }));
      
      status.textContent = '✓ ' + (res.message || 'Connected');
      status.style.color = 'var(--up)';
      setConnectionState(true);
      connectWS();
    } else {
      status.textContent = '✗ ' + (res?.message || 'Invalid response from server');
      status.style.color = 'var(--down)';
    }
  } catch(e) {
    status.textContent = '✗ ' + e.message;
    status.style.color = 'var(--down)';
  }
  btn.disabled = false; btn.innerHTML = `<svg viewBox="0 0 20 20" fill="none"><path d="M10 2v10M6 6l4-4 4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 14v2a2 2 0 002 2h8a2 2 0 002-2v-2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg> Connect to API`;
}

function loadSavedCreds() {
  try {
    const creds = JSON.parse(localStorage.getItem('neo_creds'));
    if (creds) {
      document.getElementById('neo-ucc').value = creds.ucc || '';
      document.getElementById('neo-mobile').value = creds.mobile || '';
      document.getElementById('neo-password').value = creds.password || '';
      document.getElementById('neo-mpin').value = creds.mpin || '';
    }
  } catch(e) {}
}


// ── WebSocket ─────────────────────────────────
function connectWS() {
  if (!sessionId) return;
  if (ws) { try{ws.close();}catch(e){} }
  clearTimeout(wsReconnectTimer);
  ws = new WebSocket(`ws://localhost:3000/ws`);
  ws.onopen = () => {
    ws.send(JSON.stringify({action:'authenticate', session_id:sessionId}));
  };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'tick') handleTick(msg.price);
    if (msg.type === 'session_expired') {
      localStorage.removeItem('neo_session'); sessionId = null;
      setConnectionState(false);
    }
    if (msg.type === 'ping') ws.send(JSON.stringify({type:'pong'}));
  };
  ws.onclose = () => {
    setConnectionState(false);
    wsReconnectTimer = setTimeout(() => { if(sessionId) connectWS(); }, 5000);
  };
  ws.onerror = () => ws.close();
}

function handleTick(price) {
  const t = Math.floor(Date.now()/1000);
  if (priceSeries) priceSeries.update({time:t, value:price});
  if (lastPremium !== null) {
    const chg = price - lastPremium;
    const chgPct = (chg/lastPremium*100).toFixed(2);
    const el = document.getElementById('premium-change');
    el.textContent = `${chg>=0?'+':''}${chg.toFixed(2)} (${chgPct}%)`;
    el.className = 'prem-change ' + (chg>=0?'up':'down');
  }
  document.getElementById('premium-value').textContent = '₹ ' + price.toFixed(2);
  lastPremium = price;
}

// ── Init ──────────────────────────────────────
let isLive = false;
window.addEventListener('DOMContentLoaded', () => {
  initChart();
  loadSavedCreds();
  startStraddlePolling();
  
  if (sessionId) {
    fetch(`${API}/api/session/${sessionId}`)
      .then(r => r.json())
      .then(d => {
        if (d.valid) {
          setConnectionState(true);
          document.getElementById('neo-status').textContent = '✓ Connected (Session Restored)';
          document.getElementById('neo-status').style.color = 'var(--up)';
          connectWS();
          // Auto-load option chain on restore
          loadOptionChain();
        } else {
          localStorage.removeItem('neo_session');
          setConnectionState(false);
        }
      })
      .catch(() => setConnectionState(false));
  }
});

// ══════════════════════════════════════════════
//  TAB 2 — OPTION CHAIN
// ══════════════════════════════════════════════
let ocRawRows = [], ocExpiries = [], ocSpot = 0, ocAtm = 0;

async function loadOptionChain() {
  const sym = document.getElementById('oc-symbol').value;
  const btn = document.getElementById('oc-refresh-btn');
  btn.disabled = true;
  document.getElementById('oc-tbody').innerHTML = `<tr><td colspan="15" class="oc-loading">Fetching data…</td></tr>`;
  try {
    const d = await fetch(`${API}/api/option-chain/${sym}`).then(r => r.json());
    
    // Even if there's an error field, use any data that came back
    if (d.rows && d.rows.length > 0) {
      ocRawRows = d.rows; ocExpiries = d.expiries || []; ocSpot = d.spot || 0; ocAtm = d.atm || 0;
      document.getElementById('oc-spot').textContent = ocSpot > 0 ? ocSpot.toLocaleString('en-IN') : '—';
      document.getElementById('oc-atm').textContent = ocAtm > 0 ? ocAtm.toLocaleString('en-IN') : '—';
      document.getElementById('oc-pcr').textContent = d.pcr || '—';
      document.getElementById('oc-exp').textContent = d.expiry || '—';
      const sel = document.getElementById('oc-expiry');
      if (d.expiries && d.expiries.length) {
        sel.innerHTML = d.expiries.slice(0,8).map(e => `<option value="${e}">${e}</option>`).join('');
      }
      // Show market-closed banner above table if data is stale
      if (d.error) {
        document.getElementById('oc-tbody').innerHTML = 
          `<tr><td colspan="15" style="background:rgba(255,165,0,0.08);color:#f59e0b;font-size:.8rem;padding:.4rem 1rem;text-align:center">` +
          `⚠ Market Closed — Showing today's closing data (${new Date().toLocaleDateString('en-IN')})</td></tr>` +
          renderOCRows(ocRawRows, ocAtm);
        scrollToAtm();
      } else {
        renderOCTable(ocRawRows, ocAtm);
      }
    } else if (d.error) {
      // No data at all — show proper closed message
      const loginMsg = sessionId ? '' : `<br><small>Login to Kotak Neo on the Straddle tab for real-time data.</small>`;
      document.getElementById('oc-tbody').innerHTML = 
        `<tr><td colspan="15" class="oc-loading">
          🔒 Market Closed — No data available<br>
          <small style="color:var(--muted)">Option chain data is available during market hours (9:15 AM – 3:30 PM IST)</small>
          ${loginMsg}
        </td></tr>`;
    } else {
      renderOCTable([], ocAtm);
    }
  } catch(e) {
    document.getElementById('oc-tbody').innerHTML = 
      `<tr><td colspan="15" class="oc-loading" style="color:var(--down)">Error: ${e.message}</td></tr>`;
  }
  btn.disabled = false;
}

function scrollToAtm() {
  setTimeout(() => {
    const allRows = document.querySelectorAll('#oc-tbody tr');
    const atmRow = Array.from(allRows).find(r => r.classList.contains('atm-row'));
    if (atmRow) atmRow.scrollIntoView({block:'center', behavior:'smooth'});
  }, 100);
}

function filterOCExpiry() { renderOCTable(ocRawRows, ocAtm); }

function buildupBadge(label) {
  const map = {'Long Buildup':'lb','Short Buildup':'sb','Long Unwinding':'lu','Short Covering':'sc'};
  const cls = map[label] || 'sc';
  return `<span class="badge badge-${cls}">${label}</span>`;
}

function fmtOI(n) {
  if (n >= 1e7) return (n/1e7).toFixed(1)+'Cr';
  if (n >= 1e5) return (n/1e5).toFixed(1)+'L';
  if (n >= 1e3) return (n/1e3).toFixed(1)+'K';
  return n;
}

function renderOCRows(rows, atm) {
  return rows.map(row => {
    const isAtm = row.strike === atm;
    const ce = row.ce, pe = row.pe;
    return `<tr class="${isAtm?'atm-row':''}"> 
      <td>${buildupBadge(ce.buildup||'')}</td>
      <td>${ce.delta||'—'}</td><td>${ce.iv||0}%</td>
      <td class="${(ce.oiChg||0)>=0?'up':'down'}">${(ce.oiChg||0)>=0?'+':''}${fmtOI(ce.oiChg||0)}</td>
      <td>${fmtOI(ce.oi||0)}</td><td>${fmtOI(ce.vol||0)}</td>
      <td style="font-weight:700">₹${(ce.ltp||0).toFixed(2)}</td>
      <td class="strike-col">${isAtm?'⭐ ':' '}${row.strike}</td>
      <td style="font-weight:700">₹${(pe.ltp||0).toFixed(2)}</td>
      <td>${fmtOI(pe.vol||0)}</td><td>${fmtOI(pe.oi||0)}</td>
      <td class="${(pe.oiChg||0)>=0?'up':'down'}">${(pe.oiChg||0)>=0?'+':''}${fmtOI(pe.oiChg||0)}</td>
      <td>${pe.iv||0}%</td><td>${pe.delta||'—'}</td>
      <td>${buildupBadge(pe.buildup||'')}</td>
    </tr>`;
  }).join('');
}

function renderOCTable(rows, atm) {
  if (!rows || !rows.length) {
    document.getElementById('oc-tbody').innerHTML = `<tr><td colspan="15" class="oc-loading">
      🔒 Market Closed — No option chain data<br>
      <small style="color:var(--muted)">Data available during market hours (9:15 AM – 3:30 PM IST)</small>
    </td></tr>`;
    return;
  }
  document.getElementById('oc-tbody').innerHTML = renderOCRows(rows, atm);
  scrollToAtm();
}

setInterval(() => {
  if (document.getElementById('panel-option-chain').classList.contains('active')) loadOptionChain();
}, 30000);

// ══════════════════════════════════════════════
//  TAB 3 — MARKET PULSE (PULLERS / DRAGGERS)
// ══════════════════════════════════════════════
let currentPDIndex = 'NIFTY';
let scannerTimer = null;

async function loadMarketPulse() {
  await Promise.all([loadPD(currentPDIndex), loadScanner()]);
}

async function loadPD(index, btn) {
  if (index) currentPDIndex = index;
  if (btn) {
    document.querySelectorAll('.pd-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  }
  try {
    const d = await fetch(`${API}/api/pullers-draggers/${currentPDIndex}`).then(r => r.json());
    
    // Update index info
    document.getElementById('pd-idx-name').textContent = d.index || currentPDIndex;
    document.getElementById('pd-idx-price').textContent = '₹' + (d.indexPrice || 0).toLocaleString('en-IN');
    const up = (d.indexChange || 0) >= 0;
    const chgEl = document.getElementById('pd-idx-chg');
    chgEl.textContent = `${up ? '▲' : '▼'} ${Math.abs(d.indexChange || 0).toFixed(2)} (${(d.indexPct || 0).toFixed(2)}%)`;
    chgEl.style.color = up ? 'var(--up)' : 'var(--down)';
    document.getElementById('pd-idx-time').textContent = d.timestamp || '';

    // Update counts
    document.getElementById('pd-pull-count').textContent = d.pullersCount || 0;
    document.getElementById('pd-drag-count').textContent = d.draggersCount || 0;

    // Draw gauge
    drawPDGauge(d.pullersCount || 0, d.draggersCount || 0, d.totalStocks || 50);

    // Render tables
    renderPDTable('pd-pullers-body', d.pullers || [], true);
    renderPDTable('pd-draggers-body', d.draggers || [], false);
  } catch (e) {
    console.warn('[PD] Error:', e);
  }
}

function renderPDTable(tbodyId, stocks, isPuller) {
  const tbody = document.getElementById(tbodyId);
  if (!tbody) return;
  if (!stocks.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="loading">No data</td></tr>`;
    return;
  }
  tbody.innerHTML = stocks.map(s => {
    const chgStr = `${s.pct >= 0 ? '+' : ''}${s.pct}%`;
    return `<tr onclick="openStockChart('${s.symbol}')">
      <td class="sym-cell">${s.symbol}</td>
      <td>₹${s.ltp?.toLocaleString('en-IN')}</td>
      <td class="${s.pct >= 0 ? 'up-cell' : 'dn-cell'}">${s.change >= 0 ? '+' : ''}${s.change}(${chgStr})</td>
      <td><span class="wp-cell ${isPuller ? 'wp-up' : 'wp-dn'}">${isPuller ? '▲' : '▼'} ${s.wPoint}</span></td>
    </tr>`;
  }).join('');
}

function drawPDGauge(pullers, draggers, total) {
  const canvas = document.getElementById('pd-gauge');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const cx = W / 2, cy = H - 15, r = H - 40;
  
  // Background arc
  ctx.beginPath(); ctx.arc(cx, cy, r, Math.PI, 0, false);
  ctx.lineWidth = 30; ctx.strokeStyle = 'rgba(255,255,255,0.04)'; ctx.stroke();

  const total2 = pullers + draggers || 1;
  const pullRatio = pullers / total2;
  const mid = Math.PI + pullRatio * Math.PI;

  // Puller arc (green, left side)
  if (pullers > 0) {
    ctx.beginPath(); ctx.arc(cx, cy, r, Math.PI, mid, false);
    ctx.lineWidth = 30; 
    const grd = ctx.createLinearGradient(0, cy, cx, cy);
    grd.addColorStop(0, '#10b981'); grd.addColorStop(1, '#34d399');
    ctx.strokeStyle = grd; ctx.stroke();
  }
  
  // Dragger arc (red, right side)
  if (draggers > 0) {
    ctx.beginPath(); ctx.arc(cx, cy, r, mid, 0, false);
    ctx.lineWidth = 30;
    const grd2 = ctx.createLinearGradient(cx, cy, W, cy);
    grd2.addColorStop(0, '#f87171'); grd2.addColorStop(1, '#ef4444');
    ctx.strokeStyle = grd2; ctx.stroke();
  }

  // Labels
  ctx.fillStyle = '#10b981'; ctx.font = 'bold 13px Inter'; ctx.textAlign = 'center';
  ctx.fillText('Pullers', cx - r * 0.5, cy - r * 0.3);
  ctx.fillStyle = '#ef4444';
  ctx.fillText('Draggers', cx + r * 0.5, cy - r * 0.3);
  
  // Center count
  ctx.fillStyle = '#f0f4ff'; ctx.font = 'bold 22px JetBrains Mono';
  ctx.fillText(`${pullers}/${draggers}`, cx, cy + 5);
}

// Live Scanner
async function loadScanner() {
  try {
    const events = await fetch(`${API}/api/live-scanner`).then(r => r.json());
    const feed = document.getElementById('scanner-feed');
    if (!feed) return;
    if (!events || !events.length) {
      feed.innerHTML = '<div class="loading">No stocks at day high/low right now</div>';
      return;
    }
    const now = new Date();
    feed.innerHTML = events.map(e => {
      const isHigh = e.type === 'HIGH';
      const timeStr = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      return `<div class="scan-item ${isHigh ? 'high-event' : 'low-event'}" onclick="openStockChart('${e.symbol}')">
        <span class="scan-time">${timeStr}</span>
        <span class="scan-sym">${e.symbol}</span>
        <span class="scan-action"><span class="${isHigh ? 'scan-high' : 'scan-low'}">${e.symbol} made ${isHigh ? 'High' : 'Low'} of ₹${e.price?.toLocaleString('en-IN')} ${isHigh ? '↑' : '↓'}</span></span>
      </div>`;
    }).join('');
  } catch (e) {
    console.warn('[Scanner]', e);
  }
}

async function loadGainersLosers() {
  const idx = document.getElementById('gl-index')?.value || 'NIFTY';
  try {
    const d = await fetch(`${API}/api/gainers-losers/${idx}`).then(r => r.json());
    const all = [...(d.gainers||[]),...(d.losers||[])];
    const maxPct = Math.max(...all.map(s => Math.abs(s.pct)), 1);
    const renderList = (items, id, isGain) => {
      const el = document.getElementById(id);
      if (!items.length) { el.innerHTML = `<div style="color:var(--muted);font-size:.78rem;padding:.5rem">No data</div>`; return; }
      el.innerHTML = items.map(s => {
        const w = Math.min((Math.abs(s.pct)/maxPct)*100,100).toFixed(1);
        return `<div class="gl-item" onclick="openStockChart('${s.symbol}')">
          <div class="gl-item-row"><span class="sym">${s.symbol}</span><span class="pct ${isGain?'up':'down'}">${isGain?'+':''}${s.pct}%</span></div>
          <div class="gl-bar-bg"><div class="gl-bar-fill ${isGain?'g':'l'}" style="width:${w}%"></div></div>
        </div>`;
      }).join('');
    };
    renderList(d.gainers,'gainers-list',true);
    renderList(d.losers,'losers-list',false);
  } catch(e) { console.warn('GL', e); }
}

// Auto-refresh Market Pulse every 30s when active
setInterval(() => {
  if (document.getElementById('panel-market-pulse')?.classList.contains('active')) {
    loadPD(currentPDIndex);
    loadScanner();
  }
}, 30000);


// ══════════════════════════════════════════════
//  TAB 4 — GLOBAL MARKETS
// ══════════════════════════════════════════════
async function loadGlobal() {
  try {
    const d = await fetch(`${API}/api/global`).then(r => r.json());
    const grid = document.getElementById('global-grid');
    grid.innerHTML = '';
    Object.entries(d).forEach(([name, info]) => {
      const up = info.change >= 0;
      const card = document.createElement('div');
      card.className = 'glass-card global-card';
      const cid = 'spark-' + name.replace(/[^a-z0-9]/gi,'_');
      card.innerHTML = `
        <div class="global-card-header">
          <span class="global-card-name">${name}</span>
          <span class="global-card-unit">${info.unit}</span>
        </div>
        <div class="global-card-price">${(info.price||0).toLocaleString('en-US',{minimumFractionDigits:2})}</div>
        <div class="global-card-change">
          <span class="global-card-chg" style="color:${up?'var(--up)':'var(--down)'};background:${up?'rgba(34,197,94,.12)':'rgba(239,68,68,.12)'}">
            ${up?'+':''}${(info.change||0).toFixed(2)} &nbsp; ${up?'+':''}${(info.change_pct||0).toFixed(2)}%
          </span>
        </div>
        <canvas id="${cid}" class="spark-canvas" height="40"></canvas>`;
      grid.appendChild(card);
      if ((info.spark||[]).length > 1) drawSparkline(cid, info.spark, up);
    });
    document.getElementById('global-refresh-time').textContent = 'Last updated: ' + new Date().toLocaleTimeString('en-IN');
  } catch(e) { console.warn('Global', e); }
}

function drawSparkline(id, data, up) {
  requestAnimationFrame(() => {
    const canvas = document.getElementById(id);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.offsetWidth || 260, H = 40;
    canvas.width = W; canvas.height = H;
    const min = Math.min(...data), max = Math.max(...data);
    const range = max - min || 1;
    const pts = data.map((v,i) => [i/(data.length-1)*W, H-((v-min)/range)*(H-6)-3]);
    const col = up ? '#22c55e' : '#ef4444';
    const grad = ctx.createLinearGradient(0,0,0,H);
    grad.addColorStop(0, col+'44'); grad.addColorStop(1, col+'00');
    ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
    pts.slice(1).forEach(([x,y]) => ctx.lineTo(x,y));
    ctx.strokeStyle=col; ctx.lineWidth=1.5; ctx.stroke();
    ctx.lineTo(W,H); ctx.lineTo(0,H); ctx.closePath();
    ctx.fillStyle=grad; ctx.fill();
  });
}

setInterval(() => {
  if (document.getElementById('panel-global').classList.contains('active')) loadGlobal();
}, 15000);

// ══════════════════════════════════════════════
//  TAB 5 — FII / DII
// ══════════════════════════════════════════════
async function loadFiiDii() {
  const tbody = document.getElementById("fii-tbody");
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="5" class="loading">Fetching institutional data…</td></tr>`;
  try {
    const data = await fetch(`${API}/api/fii-dii`).then(r => r.json());
    if (!data.length) {
      tbody.innerHTML = `<tr><td colspan="5" class="loading">No data available today.</td></tr>`;
      return;
    }
    tbody.innerHTML = data.map(row => {
        const val = parseFloat(row.netValue);
        const cls = val >= 0 ? "up" : "down";
        return `<tr>
            <td>${row.date}</td>
            <td>${row.category}</td>
            <td>${row.buyValue}</td>
            <td>${row.sellValue}</td>
            <td class="${cls}">${row.netValue}</td>
        </tr>`;
    }).join('');
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="5" class="loading" style="color:var(--down)">Error: ${e.message}</td></tr>`;
  }
}

// ══════════════════════════════════════════════
//  WATCHLIST LOGIC
// ══════════════════════════════════════════════
let watchlist = JSON.parse(localStorage.getItem('finterminal_watchlist') || '[]');

function saveWatchlist() {
    localStorage.setItem('finterminal_watchlist', JSON.stringify(watchlist));
    renderWatchlist();
}

async function renderWatchlist() {
    const container = document.getElementById('watchlist-items');
    if (!container) return;
    if (watchlist.length === 0) {
        container.innerHTML = '<div class="loading">No stocks added</div>';
        return;
    }
    
    container.innerHTML = watchlist.map(item => {
        const chg = item.current ? ((item.current - item.addPrice) / item.addPrice * 100).toFixed(2) : '—';
        const up = parseFloat(chg) >= 0;
        return `
            <div class="watchlist-item" onclick="openStockChart('${item.symbol}')">
                <div class="wl-info">
                    <span class="wl-symbol">${item.symbol}</span>
                    <span class="wl-add-price">Added @ ₹${item.addPrice}</span>
                </div>
                <div class="wl-data">
                    <span class="wl-price">₹${item.current || '—'}</span>
                    <span class="wl-pct" style="color:${up?'var(--up)':'var(--down)'}">${chg}%</span>
                </div>
            </div>
        `;
    }).join('');
}

async function refreshWatchlistPrices() {
    if (watchlist.length === 0) return;
    for (let item of watchlist) {
        try {
            const q = await fetch(`${API}/api/stock-quote/${item.symbol}`).then(r => r.json());
            if (q && q.ltp) item.current = q.ltp;
        } catch (e) { console.warn('WL refresh err', item.symbol, e); }
    }
    renderWatchlist();
}

function toggleWatchlistCurrent() {
    const symbol = document.getElementById('modal-title').textContent;
    const ltp = parseFloat(document.getElementById('q-ltp').textContent.replace('₹','').replace(',',''));
    if (!symbol || isNaN(ltp)) return;

    const idx = watchlist.findIndex(i => i.symbol === symbol);
    if (idx >= 0) {
        watchlist.splice(idx, 1);
        alert(`${symbol} removed from watchlist`);
    } else {
        watchlist.push({ symbol, addPrice: ltp, current: ltp, date: new Date().toISOString() });
        alert(`${symbol} added to watchlist @ ₹${ltp}`);
    }
    saveWatchlist();
}

// Initial loads
document.addEventListener('DOMContentLoaded', () => {
    init();
    
    // Close modal on escape
    window.addEventListener('keydown', e => {
      if (e.key === 'Escape') closeModal();
    });
});

// ── Stock Modal Logic ─────────────────────────
async function openStockChart(symbol) {
  if (!symbol) return;
  symbol = symbol.toUpperCase().trim();
  const modal = document.getElementById('stock-modal');
  modal.classList.add('active');
  
  document.getElementById('modal-title').textContent = symbol;
  document.getElementById('modal-source').textContent = 'Fetching...';
  
  // Clear previous data
  updateModalQuote(null);
  if (modalSeries) modalSeries.setData([]);

  try {
    // Parallel fetch for quote and chart
    const [quote, chart] = await Promise.all([
      fetch(`${API}/api/stock-quote/${symbol}`).then(r => r.ok ? r.json() : null),
      fetch(`${API}/api/stock-chart/${symbol}`).then(r => r.ok ? r.json() : [])
    ]);

    if (quote) {
      updateModalQuote(quote);
    } else {
      document.getElementById('modal-source').textContent = 'Error fetching quote';
    }

    if (!modalChart) {
      initModalChart();
    }

    if (chart && chart.length) {
      modalSeries.setData(chart);
      modalChart.timeScale().fitContent();
    }
  } catch (e) {
    console.error('Modal load error:', e);
    document.getElementById('modal-source').textContent = 'Error: ' + e.message;
  }
}

function initModalChart() {
  const container = document.getElementById('modal-chart-container');
  modalChart = LightweightCharts.createChart(container, {
    layout: { background:{type:'solid',color:'transparent'}, textColor:'#7a8ba8', fontFamily:'JetBrains Mono' },
    grid: { vertLines:{color:'rgba(255,255,255,0.04)'}, horzLines:{color:'rgba(255,255,255,0.04)'} },
    timeScale: { borderColor:'rgba(255,255,255,0.07)', timeVisible:true },
    rightPriceScale: { borderColor:'rgba(255,255,255,0.07)' },
  });
  
  modalSeries = modalChart.addCandlestickSeries({
    upColor: '#22c55e', downColor: '#ef4444', borderVisible: false,
    wickUpColor: '#22c55e', wickDownColor: '#ef4444'
  });

  new ResizeObserver(() => {
    modalChart.applyOptions({ width: container.clientWidth, height: container.clientHeight });
  }).observe(container);
}

function updateModalQuote(q) {
  const ids = ['q-ltp', 'q-chg', 'q-open', 'q-high', 'q-low', 'q-vol'];
  if (!q) {
    ids.forEach(id => document.getElementById(id).textContent = '—');
    return;
  }
  
  document.getElementById('modal-source').textContent = q.source || 'Unknown';
  document.getElementById('q-ltp').textContent = '₹' + q.ltp.toLocaleString('en-IN');
  
  const chgEl = document.getElementById('q-chg');
  chgEl.textContent = `${q.change >= 0 ? '+' : ''}${q.change.toFixed(2)} (${q.pct.toFixed(2)}%)`;
  chgEl.className = 'q-val ' + (q.change >= 0 ? 'up' : 'down');
  
  document.getElementById('q-open').textContent = q.open.toLocaleString('en-IN');
  document.getElementById('q-high').textContent = q.high.toLocaleString('en-IN');
  document.getElementById('q-low').textContent = q.low.toLocaleString('en-IN');
  document.getElementById('q-vol').textContent = fmtOI(q.volume);
}

function closeModal() {
  document.getElementById('stock-modal').classList.remove('active');
}

// ══════════════════════════════════════════════
//  TAB 4b — IPO & BONDS
// ══════════════════════════════════════════════
let currentIpoView = "mainline";

const IPO_TITLES = {
  mainline: "Mainline IPOs",
  sme: "SME IPOs",
  gmp: "GMP Analysis — Analyst Recommendations",
  bonds: "Public Bonds / NCD"
};

async function loadIpoDashboard(type = null) {
    if (type) currentIpoView = type;
    const container = document.getElementById("ipo-cards-container");
    const title = document.getElementById("ipo-view-title");
    const countEl = document.getElementById("ipo-count");
    
    if (!container || !title) return;

    title.textContent = IPO_TITLES[currentIpoView] || currentIpoView.toUpperCase();
    container.innerHTML = '<div class="loading">Loading IPO data...</div>';
    if (countEl) countEl.textContent = '';

    try {
        const data = await fetch(`${API}/api/ipo?type=${currentIpoView}`).then(r => r.json());
        if (!data || data.length === 0) {
            container.innerHTML = '<div class="loading">No data available for this category.</div>';
            return;
        }
        if (countEl) countEl.textContent = `${data.length} results`;

        if (currentIpoView === 'gmp') {
            renderGMPCards(container, data);
        } else if (currentIpoView === 'bonds') {
            renderBondCards(container, data);
        } else {
            renderIPOCards(container, data);
        }
    } catch (e) {
        container.innerHTML = `<div class="loading" style="color:var(--down)">Failed to load: ${e.message}</div>`;
    }
}

function renderIPOCards(container, data) {
    container.innerHTML = data.map(row => {
        const keys = Object.keys(row).filter(k => !k.startsWith('Unnamed'));
        const company = row.Company || row['Company Name'] || row.company || '—';
        const price = row.Price || row['Issue Price'] || row.price || '—';
        const sub = row['Total Subscription'] || row.Subscription || '—';
        const qib = row.QIB || '—';
        const nii = row.NII || '—';
        const retail = row.Retail || '—';
        const listDate = row.Date || row['Listing Date'] || row['Demat Account Credit Date'] || '—';
        const allotDate = row['Allotment Date'] || '—';
        const allotStatus = row['Allotment Status'] || '';
        const type = row['Unnamed: 1'] || '';

        // Parse subscription for color coding
        const subNum = parseFloat(String(sub).replace('x',''));
        const subClass = isNaN(subNum) ? '' : subNum >= 1 ? 'sub-high' : 'sub-low';

        return `<div class="glass-card ipo-card">
            <div class="ipo-card-head">
                <span class="ipo-card-name">${company}</span>
                ${type ? `<span class="ipo-card-type">${type}</span>` : ''}
            </div>
            <div class="ipo-card-body">
                <div class="ipo-field"><span class="ipo-field-label">Price</span><span class="ipo-field-val">${price}</span></div>
                <div class="ipo-field"><span class="ipo-field-label">Total Subscription</span><span class="ipo-field-val" style="color:${subNum >= 1 ? 'var(--up)' : 'var(--down)'}">${sub}</span></div>
                <div class="ipo-field"><span class="ipo-field-label">QIB</span><span class="ipo-field-val">${qib}</span></div>
                <div class="ipo-field"><span class="ipo-field-label">NII (HNI)</span><span class="ipo-field-val">${nii}</span></div>
                <div class="ipo-field"><span class="ipo-field-label">Retail</span><span class="ipo-field-val">${retail}</span></div>
                <div class="ipo-field"><span class="ipo-field-label">Listing Date</span><span class="ipo-field-val">${listDate}</span></div>
            </div>
            <div class="ipo-card-foot">
                ${allotDate !== '—' ? `<span class="ipo-tag allot">📅 Allotment: ${allotDate}</span>` : ''}
                ${allotStatus === 'Check' ? `<span class="ipo-tag listing">⏳ Check Allotment</span>` : ''}
                ${subNum >= 3 ? `<span class="ipo-tag sub-high">🔥 ${sub} Subscribed</span>` : ''}
            </div>
        </div>`;
    }).join('');
}

function renderGMPCards(container, data) {
    container.innerHTML = data.map(row => {
        const company = row.Company || '—';
        const apply = parseInt(row.Apply) || 0;
        const mayApply = parseInt(row['May Apply']) || 0;
        const neutral = parseInt(row.Neutral) || 0;
        const avoid = parseInt(row.Avoid) || 0;
        const notRated = parseInt(row['Not Rated']) || 0;
        const total = apply + mayApply + neutral + avoid + notRated || 1;
        const applyPct = Math.round((apply + mayApply) / total * 100);
        const avoidPct = Math.round(avoid / total * 100);
        
        // Sentiment
        let sentiment = 'Neutral', sentClass = 'listing';
        if (applyPct >= 60) { sentiment = `${applyPct}% Positive`; sentClass = 'gmp-up'; }
        else if (avoidPct >= 30) { sentiment = `${avoidPct}% Negative`; sentClass = 'gmp-dn'; }

        return `<div class="glass-card ipo-card">
            <div class="ipo-card-head">
                <span class="ipo-card-name">${company}</span>
                <span class="ipo-tag ${sentClass}">${sentiment}</span>
            </div>
            <div class="gmp-bar">
                <div class="gmp-bar-fill apply" style="width:${applyPct}%"></div>
            </div>
            <div class="gmp-reco">
                <span class="gmp-reco-tag" style="background:rgba(16,185,129,.15);color:var(--up)">✅ Apply: ${apply}</span>
                <span class="gmp-reco-tag" style="background:rgba(245,158,11,.15);color:var(--gold)">🤔 May Apply: ${mayApply}</span>
                <span class="gmp-reco-tag" style="background:rgba(255,255,255,.08);color:var(--muted)">⚖️ Neutral: ${neutral}</span>
                <span class="gmp-reco-tag" style="background:rgba(239,68,68,.15);color:var(--down)">❌ Avoid: ${avoid}</span>
                <span class="gmp-reco-tag" style="background:rgba(255,255,255,.05);color:var(--muted)">Not Rated: ${notRated}</span>
            </div>
            <div style="margin-top:.6rem;font-size:.72rem;color:var(--muted)">Total Analysts: ${total} • Apply Rate: ${applyPct}%</div>
        </div>`;
    }).join('');
}

function renderBondCards(container, data) {
    if (!data.length) {
        container.innerHTML = '<div class="loading">No bond/NCD issues available currently.</div>';
        return;
    }
    const keys = Object.keys(data[0]).filter(k => !k.startsWith('Unnamed'));
    container.innerHTML = data.map(row => {
        return `<div class="glass-card ipo-card">
            <div class="ipo-card-head">
                <span class="ipo-card-name">${row[keys[0]] || '—'}</span>
            </div>
            <div class="ipo-card-body">
                ${keys.slice(1).map(k => `<div class="ipo-field"><span class="ipo-field-label">${k}</span><span class="ipo-field-val">${row[k] || '—'}</span></div>`).join('')}
            </div>
        </div>`;
    }).join('');
}

// Event delegation for IPO menu
document.addEventListener('click', (e) => {
    if (e.target.classList.contains('ipo-menu-btn')) {
        document.querySelectorAll(".ipo-menu-btn").forEach(b => b.classList.remove("active"));
        e.target.classList.add("active");
        loadIpoDashboard(e.target.dataset.view);
    }
});
// Update global tab listener for IPO

// Admin shortcut: Ctrl+Shift+K to toggle Kotak Neo login
window.addEventListener('keydown', e => {
    if (e.ctrlKey && e.shiftKey && e.key === 'K') {
        const card = document.getElementById('login-card');
        if (card) card.style.display = card.style.display === 'none' ? 'block' : 'none';
    }
});

/* ═══════════════════════════════════════════════════════════════
   FinTerminal — Modern, Mobile-First App Logic
   ═══════════════════════════════════════════════════════════════ */

// Detect API URL (same origin for production, localhost:3000 for development)
const API = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
  ? 'http://localhost:3000'
  : window.location.origin;

// State Variables
let token = localStorage.getItem('finterminal_token') || null;
let user = null;
let activeDashboardTab = 'straddle';

// Charting Variables
let tvChart = null;
let priceSeries = null;
let straddleHistory = [];
let lastPremium = null;
let currentAsset = 'NIFTY';

// Market Pulse Variables
let currentMPIndex = 'NIFTY';

// Interval Timers
let tickerInterval = null;
let straddleInterval = null;
let marketPulseInterval = null;
let trialCountdownInterval = null;
let authCheckInterval = null;

// Simulated OTP Code (for easy developer testing)
let activeSimulatedOtp = null;

// Remaining trial seconds
let trialRemainingSeconds = 0;

/* ════════════════════════════════════════════════
   APPLICATION STARTUP & INITIALIZATION
   ════════════════════════════════════════════════ */

window.addEventListener('DOMContentLoaded', () => {
    initApp();
});

async function initApp() {
    console.log("[Init] Initializing FinTerminal...");
    
    // Switch between Auth screen or main terminal content
    if (!token) {
        showAuthOverlay(true);
    } else {
        const authenticated = await verifySession();
        if (authenticated) {
            startTerminalDashboard();
        } else {
            handleLogout();
        }
    }
}

// Check session with server
async function verifySession() {
    try {
        const res = await fetch(`${API}/api/auth/me`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (res.ok) {
            user = await res.json();
            localStorage.setItem('finterminal_user', JSON.stringify(user));
            trialRemainingSeconds = user.trial_remaining;
            return true;
        }
        return false;
    } catch (e) {
        console.warn("[Session] Could not verify session with server:", e);
        // Fallback to offline cached details if network is down
        const cached = localStorage.getItem('finterminal_user');
        if (cached) {
            user = JSON.parse(cached);
            return true;
        }
        return false;
    }
}

// Start all background polling & dashboard items
function startTerminalDashboard() {
    showAuthOverlay(false);
    
    // Check access limits (paywall check)
    if (checkAccessLimits()) {
        return; // locked, don't start dashboards
    }

    document.getElementById('logout-btn').style.display = 'inline-flex';
    document.getElementById('mstock-banner').style.display = 'flex';

    // Initialize Lightweight Chart
    initChart();

    // Start background polling loops
    runTickerPoll();
    tickerInterval = setInterval(runTickerPoll, 15000);

    runStraddlePoll();
    straddleInterval = setInterval(runStraddlePoll, 5000);

    // Start trial countdown UI logic
    startTrialCountdown();
    
    // Periodically sync user status from server every 30s
    authCheckInterval = setInterval(async () => {
        const ok = await verifySession();
        if (!ok) {
            handleLogout();
        } else {
            checkAccessLimits();
        }
    }, 30000);
}

// Stop all dashboard polling loops
function stopTerminalDashboard() {
    clearInterval(tickerInterval);
    clearInterval(straddleInterval);
    clearInterval(marketPulseInterval);
    clearInterval(trialCountdownInterval);
    clearInterval(authCheckInterval);
    
    if (tvChart) {
        try {
            tvChart.remove();
            tvChart = null;
            priceSeries = null;
        } catch(e) {}
    }
}

/* ════════════════════════════════════════════════
   ACCESS CONTROL & TRIAL COUNTDOWN
   ════════════════════════════════════════════════ */

function checkAccessLimits() {
    if (!user) return true;

    const paywallScreen = document.getElementById('paywall-screen');
    const paywallReason = document.getElementById('paywall-reason');
    const timerContainer = document.getElementById('trial-timer-container');

    // Revoked Access
    if (user.access === 'revoked') {
        stopTerminalDashboard();
        paywallScreen.style.display = 'flex';
        paywallReason.innerHTML = `⚠️ Your access has been <strong>revoked</strong> by the administrator. If you believe this is an error, please contact support.`;
        document.querySelector('.client-code-form').style.display = 'none';
        timerContainer.style.display = 'none';
        return true;
    }

    // Full Access Unlocked
    if (user.access === 'full') {
        paywallScreen.style.display = 'none';
        timerContainer.style.display = 'flex';
        timerContainer.className = 'trial-badge success';
        document.getElementById('trial-timer-label').textContent = '✅ Premium Unlocked';
        return false;
    }

    // Trial Access
    if (user.access === 'trial') {
        if (trialRemainingSeconds > 0) {
            // Still in trial
            paywallScreen.style.display = 'none';
            timerContainer.style.display = 'flex';
            timerContainer.className = 'trial-badge';
            updateTrialTimerDisplay();
            return false;
        } else {
            // Trial expired
            stopTerminalDashboard();
            paywallScreen.style.display = 'flex';
            timerContainer.style.display = 'none';
            
            if (user.client_code) {
                paywallReason.innerHTML = `⏳ Your client code <strong>${escapeHtml(user.client_code)}</strong> is currently <strong>pending approval</strong>.<br>The administrator will verify your mStock account creation shortly. To speed up approval, ensure you registered with our link.`;
                document.querySelector('.client-code-form h4').textContent = 'Update Client Code';
            } else {
                paywallReason.innerHTML = `⏳ Your <strong>30-minute free trial</strong> has expired!<br>Open an account with mStock through our link to get <strong>Lifetime Free Access</strong>, or enter your client code if already opened.`;
            }
            return true;
        }
    }
    return false;
}

function startTrialCountdown() {
    clearInterval(trialCountdownInterval);
    updateTrialTimerDisplay();

    trialCountdownInterval = setInterval(() => {
        if (user && user.access === 'trial') {
            if (trialRemainingSeconds > 0) {
                trialRemainingSeconds--;
                updateTrialTimerDisplay();
            } else {
                clearInterval(trialCountdownInterval);
                checkAccessLimits();
            }
        }
    }, 1000);
}

function updateTrialTimerDisplay() {
    const label = document.getElementById('trial-timer-label');
    if (!label) return;

    if (trialRemainingSeconds <= 0) {
        label.textContent = "Trial Expired";
        return;
    }

    const mins = Math.floor(trialRemainingSeconds / 60);
    const secs = trialRemainingSeconds % 60;
    label.textContent = `Trial: ${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

/* ════════════════════════════════════════════════
   USER SIGNUP / LOGIN / LOGOUT LOGIC
   ════════════════════════════════════════════════ */

function showAuthOverlay(show) {
    document.getElementById('auth-screen').style.display = show ? 'flex' : 'none';
}

function switchAuthTab(tab) {
    const isLogin = tab === 'login';
    document.getElementById('tab-login-toggle').classList.toggle('active', isLogin);
    document.getElementById('tab-signup-toggle').classList.toggle('active', !isLogin);
    document.getElementById('login-form-panel').style.display = isLogin ? 'block' : 'none';
    document.getElementById('signup-form-panel').style.display = isLogin ? 'none' : 'block';
    
    // Clear alert on toggle
    const alertEl = document.getElementById('auth-alert');
    alertEl.style.display = 'none';
}

// Send OTP Simulation
async function handleSendOtp() {
    const mobile = document.getElementById('signup-mobile').value.trim();
    const btn = document.getElementById('btn-send-otp');
    const alertEl = document.getElementById('auth-alert');
    
    if (!mobile || mobile.length < 10) {
        showAuthAlert("Please enter a valid 10-digit mobile number.", "error");
        return;
    }

    btn.disabled = true;
    btn.textContent = "Sending...";

    try {
        const res = await fetch(`${API}/api/auth/send-otp`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mobile })
        });
        const data = await res.json();
        if (res.ok && data.success) {
            activeSimulatedOtp = data.debug_otp;
            
            // Show simulated developer banner so they can copy it instantly
            const devBanner = document.getElementById('dev-otp-notification');
            const devOtpText = document.getElementById('dev-otp-text');
            devOtpText.textContent = `Simulated SMS Sent. OTP is: ${activeSimulatedOtp}`;
            devBanner.style.display = 'flex';
            
            showToast(`Simulated OTP code sent successfully!`, "success");
        } else {
            showAuthAlert(data.detail || "Error generating OTP.", "error");
        }
    } catch(e) {
        showAuthAlert("Cannot reach server. Is the backend running?", "error");
    }

    btn.disabled = false;
    btn.textContent = "Send OTP";
}

// Signup submission
async function submitSignup() {
    const email = document.getElementById('signup-email').value.trim();
    const mobile = document.getElementById('signup-mobile').value.trim();
    const otp = document.getElementById('signup-otp').value.trim();
    const password = document.getElementById('signup-password').value;
    const clientCode = document.getElementById('signup-clientcode').value.trim();
    const btn = document.querySelector('#signup-form-panel .btn-primary');
    const spinner = document.getElementById('signup-spinner');

    if (!email || !mobile || !otp || !password) {
        showAuthAlert("All fields are required to register.", "error");
        return;
    }

    spinner.style.display = 'inline-block';
    btn.disabled = true;

    try {
        const res = await fetch(`${API}/api/auth/signup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email,
                mobile,
                otp,
                password,
                client_code: clientCode
            })
        });
        const data = await res.json();

        if (res.ok && data.success) {
            token = data.token;
            user = data.user;
            
            localStorage.setItem('finterminal_token', token);
            localStorage.setItem('finterminal_user', JSON.stringify(user));
            trialRemainingSeconds = user.trial_start ? 1800 : 1800; // 30 mins
            
            document.getElementById('dev-otp-notification').style.display = 'none';
            showToast("Registered successfully!", "success");
            startTerminalDashboard();
        } else {
            showAuthAlert(data.detail || "Registration failed. Please check details or OTP.", "error");
        }
    } catch(e) {
        showAuthAlert("Cannot connect to server. Check connection.", "error");
    }

    spinner.style.display = 'none';
    btn.disabled = false;
}

// Login submission
async function submitLogin() {
    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;
    const btn = document.querySelector('#login-form-panel .btn-primary');
    const spinner = document.getElementById('login-spinner');

    if (!email || !password) {
        showAuthAlert("Please enter both email and password.", "error");
        return;
    }

    spinner.style.display = 'inline-block';
    btn.disabled = true;

    try {
        const res = await fetch(`${API}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
        });
        const data = await res.json();

        if (res.ok && data.success) {
            token = data.token;
            user = data.user;
            
            localStorage.setItem('finterminal_token', token);
            localStorage.setItem('finterminal_user', JSON.stringify(user));
            trialRemainingSeconds = user.trial_remaining || 0;
            
            showToast("Welcome to FinTerminal!", "success");
            startTerminalDashboard();
        } else {
            showAuthAlert(data.detail || "Invalid email or password.", "error");
        }
    } catch(e) {
        showAuthAlert("Connection error.", "error");
    }

    spinner.style.display = 'none';
    btn.disabled = false;
}

// Logout
function handleLogout() {
    token = null;
    user = null;
    trialRemainingSeconds = 0;
    
    localStorage.removeItem('finterminal_token');
    localStorage.removeItem('finterminal_user');
    
    stopTerminalDashboard();
    
    // Reset forms
    document.getElementById('login-email').value = '';
    document.getElementById('login-password').value = '';
    document.getElementById('signup-email').value = '';
    document.getElementById('signup-mobile').value = '';
    document.getElementById('signup-otp').value = '';
    document.getElementById('signup-password').value = '';
    document.getElementById('signup-clientcode').value = '';
    document.getElementById('paywall-client-code').value = '';
    
    document.getElementById('logout-btn').style.display = 'none';
    document.getElementById('mstock-banner').style.display = 'none';
    document.getElementById('paywall-screen').style.display = 'none';
    document.getElementById('trial-timer-container').style.display = 'none';
    
    switchAuthTab('login');
    showAuthOverlay(true);
}

// Submit Client Code in Paywall Screen
async function submitPaywallClientCode() {
    const clientCode = document.getElementById('paywall-client-code').value.trim();
    const alertEl = document.getElementById('paywall-alert');

    if (!clientCode) {
        showPaywallAlert("Please enter a client code first.", "error");
        return;
    }

    try {
        const res = await fetch(`${API}/api/auth/client-code`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ client_code: clientCode })
        });
        const data = await res.json();

        if (res.ok) {
            // Update local user details
            user.client_code = data.client_code;
            user.access = data.access;
            localStorage.setItem('finterminal_user', JSON.stringify(user));

            if (user.access === 'full') {
                showToast("Lifetime Premium unlocked successfully!", "success");
                startTerminalDashboard();
            } else {
                showPaywallAlert("Client code saved! Status: Pending Approval. We will verify shortly.", "info");
                checkAccessLimits();
            }
        } else {
            showPaywallAlert(data.detail || "Failed to submit client code.", "error");
        }
    } catch(e) {
        showPaywallAlert("Server error.", "error");
    }
}

// Helpers
function showAuthAlert(msg, type) {
    const el = document.getElementById('auth-alert');
    el.textContent = msg;
    el.className = `alert show ${type}`;
}

function showPaywallAlert(msg, type) {
    const el = document.getElementById('paywall-alert');
    el.textContent = msg;
    el.className = `alert show ${type}`;
}

/* ════════════════════════════════════════════════
   DASHBOARD TAB SELECTION & VIEW MANAGERS
   ════════════════════════════════════════════════ */

function switchDashboardTab(tab) {
    activeDashboardTab = tab;
    
    document.querySelectorAll('.dashboard-tabs .tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tab);
    });

    document.querySelectorAll('.tab-panel').forEach(panel => {
        panel.classList.toggle('active', panel.id === `panel-${tab}`);
    });

    // Clear and re-run custom queries based on tab
    if (tab === 'straddle') {
        clearInterval(marketPulseInterval);
        runStraddlePoll();
    } else if (tab === 'market-pulse') {
        clearInterval(marketPulseInterval);
        runMarketPulsePoll();
        marketPulseInterval = setInterval(runMarketPulsePoll, 10000);
    }
}

/* ════════════════════════════════════════════════
   ATM STRADDLE GRAPH & DETAILS
   ════════════════════════════════════════════════ */

function initChart() {
    const el = document.getElementById('tvchart');
    if (!el || tvChart) return;

    try {
        if (typeof LightweightCharts === 'undefined') {
            console.error("LightweightCharts library is not loaded.");
            el.innerHTML = `<div class="loading" style="color:var(--down)">Failed to load Chart Library. Please check your network connection or server status.</div>`;
            return;
        }

        tvChart = LightweightCharts.createChart(el, {
            layout: {
                background: { type: 'solid', color: 'transparent' },
                textColor: '#8096b7',
                fontFamily: "'Plus Jakarta Sans', sans-serif"
            },
            grid: {
                vertLines: { color: 'rgba(255, 255, 255, 0.04)' },
                horzLines: { color: 'rgba(255, 255, 255, 0.04)' }
            },
            crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
            rightPriceScale: { borderColor: 'rgba(255, 255, 255, 0.08)' },
            timeScale: {
                borderColor: 'rgba(255, 255, 255, 0.08)',
                timeVisible: true,
                secondsVisible: false
            },
            handleScroll: true,
            handleScale: true
        });

        priceSeries = tvChart.addLineSeries({
            color: '#00f2fe',
            lineWidth: 2.5,
            crosshairMarkerRadius: 5,
            lastValueVisible: true,
            priceLineVisible: true,
            priceLineColor: 'rgba(0, 242, 254, 0.3)'
        });

        new ResizeObserver(() => {
            if (tvChart && el) {
                tvChart.applyOptions({ width: el.clientWidth, height: el.clientHeight });
            }
        }).observe(el);
    } catch(e) {
        console.error("Failed to initialize Lightweight Charts:", e);
        el.innerHTML = `<div class="loading" style="color:var(--down)">Chart Initialization Error.</div>`;
    }
}


function onAssetChange() {
    currentAsset = document.getElementById('asset-select').value;
    document.getElementById('chart-title').textContent = `${currentAsset} ATM Straddle`;
    if (priceSeries) priceSeries.setData([]);
    straddleHistory = [];
    lastPremium = null;
    runStraddlePoll();
}

async function runStraddlePoll() {
    if (!token || (user && user.access !== 'full' && trialRemainingSeconds <= 0)) return;
    
    try {
        const res = await fetch(`${API}/api/option-chain/${currentAsset}`);
        if (!res.ok) return;
        const d = await res.json();
        
        if (!d.rows || !d.rows.length || !d.spot) return;

        const atm = d.atm;
        const atmRow = d.rows.find(r => r.strike === atm)
          || d.rows.reduce((best, r) => Math.abs(r.strike - d.spot) < Math.abs(best.strike - d.spot) ? r : best, d.rows[0]);

        if (!atmRow) return;
        const premium = (atmRow.ce?.ltp || 0) + (atmRow.pe?.ltp || 0);
        if (premium <= 0) return;

        // Update UI panels
        document.getElementById('spot-price').textContent = d.spot.toLocaleString('en-IN', { minimumFractionDigits: 2 });
        document.getElementById('atm-strike').textContent = atmRow.strike.toLocaleString('en-IN');
        document.getElementById('pcr-val').textContent = d.pcr || '—';

        // Add point to premium history chart
        const t = Math.floor(Date.now() / 1000);
        if (priceSeries) {
            const last = straddleHistory[straddleHistory.length - 1];
            if (!last || last.time < t) {
                straddleHistory.push({ time: t, value: premium });
                if (straddleHistory.length > 500) straddleHistory.shift();
                priceSeries.setData(straddleHistory);
            }
        }

        // Combined premium change calculation
        if (lastPremium !== null) {
            const chg = premium - lastPremium;
            const pct = (chg / lastPremium * 100).toFixed(2);
            const el = document.getElementById('premium-change');
            el.textContent = `${chg >= 0 ? '+' : ''}${chg.toFixed(2)} (${pct}%)`;
            el.className = 'prem-change ' + (chg >= 0 ? 'up' : 'down');
        }
        document.getElementById('premium-value').textContent = '₹ ' + premium.toFixed(2);
        lastPremium = premium;

        // Connection State
        const dot = document.getElementById('live-dot');
        const st = document.getElementById('live-status');
        if (dot) {
            dot.className = 'live-dot on';
            st.textContent = 'Live Terminal Connected';
        }
    } catch(e) {
        console.warn("[Straddle] Polling Error:", e);
        const dot = document.getElementById('live-dot');
        const st = document.getElementById('live-status');
        if (dot) {
            dot.className = 'live-dot';
            st.textContent = 'Reconnecting...';
        }
    }
}

/* ════════════════════════════════════════════════
   MARKET PULSE (PULLERS & DRAGGERS)
   ════════════════════════════════════════════════ */

function changeMarketPulseIndex(idx) {
    currentMPIndex = idx;
    document.querySelectorAll('.pd-index-tabs .pd-tab').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.idx === idx);
    });
    
    document.getElementById('pd-idx-name').textContent = idx === 'NIFTY' ? 'NIFTY 50' : 'BANKNIFTY';
    
    // Clear list, reload immediately
    document.getElementById('pullers-tbody').innerHTML = `<tr><td colspan="4" class="loading">Loading Pullers...</td></tr>`;
    document.getElementById('draggers-tbody').innerHTML = `<tr><td colspan="4" class="loading">Loading Draggers...</td></tr>`;
    document.getElementById('scanner-list').innerHTML = `<div class="loading">Loading Scanner...</div>`;
    
    runMarketPulsePoll();
}

async function runMarketPulsePoll() {
    if (activeDashboardTab !== 'market-pulse') return;
    if (!token || (user && user.access !== 'full' && trialRemainingSeconds <= 0)) return;

    try {
        // Fetch Pullers & Draggers
        const res = await fetch(`${API}/api/pullers-draggers/${currentMPIndex}`);
        if (!res.ok) return;
        const d = await res.json();

        // Update headers / prices
        document.getElementById('pd-idx-price').textContent = d.index_price?.toLocaleString('en-IN', { minimumFractionDigits: 2 }) ?? '—';
        const chgEl = document.getElementById('pd-idx-chg');
        const isUp = d.index_change >= 0;
        chgEl.textContent = `${isUp ? '+' : ''}${d.index_change?.toFixed(2)} (${d.index_change_pct?.toFixed(2)}%)`;
        chgEl.className = `pd-idx-chg ${isUp ? 'up' : 'down'}`;

        // Sentiment Ratio Gauge
        const adv = d.advances || 0;
        const dec = d.declines || 0;
        const ratio = adv + dec > 0 ? Math.round((adv / (adv + dec)) * 100) : 50;
        const ratioText = `${adv} Advances / ${dec} Declines`;
        
        const sentEl = document.getElementById('pd-sentiment-label');
        sentEl.textContent = ratio > 55 ? 'Bullish' : ratio < 45 ? 'Bearish' : 'Neutral';
        sentEl.style.color = ratio > 55 ? 'var(--up)' : ratio < 45 ? 'var(--down)' : 'var(--accent)';
        document.getElementById('pd-sentiment-ratio').textContent = ratioText;

        // Build Pullers Table
        const pullers = d.pullers || [];
        const pullersTbody = document.getElementById('pullers-tbody');
        if (pullers.length === 0) {
            pullersTbody.innerHTML = `<tr><td colspan="4" class="loading">No Pullers Found</td></tr>`;
        } else {
            pullersTbody.innerHTML = pullers.map(item => `
                <tr>
                    <td class="sym-cell">${escapeHtml(item.symbol)}</td>
                    <td>${item.price?.toFixed(2)}</td>
                    <td class="up-cell">+${item.change_pct?.toFixed(2)}%</td>
                    <td class="wp-cell up">+${item.weightage?.toFixed(2)}</td>
                </tr>
            `).join('');
        }

        // Build Draggers Table
        const draggers = d.draggers || [];
        const draggersTbody = document.getElementById('draggers-tbody');
        if (draggers.length === 0) {
            draggersTbody.innerHTML = `<tr><td colspan="4" class="loading">No Draggers Found</td></tr>`;
        } else {
            draggersTbody.innerHTML = draggers.map(item => `
                <tr>
                    <td class="sym-cell">${escapeHtml(item.symbol)}</td>
                    <td>${item.price?.toFixed(2)}</td>
                    <td class="dn-cell">${item.change_pct?.toFixed(2)}%</td>
                    <td class="wp-cell down">${item.weightage?.toFixed(2)}</td>
                </tr>
            `).join('');
        }

        // Poll the Live Scanner
        runLiveScannerPoll();

    } catch(e) {
        console.warn("[MarketPulse] Polling error:", e);
    }
}

async function runLiveScannerPoll() {
    try {
        const res = await fetch(`${API}/api/live-scanner`);
        if (!res.ok) return;
        const events = await res.json();

        const listEl = document.getElementById('scanner-list');
        if (!listEl) return;

        if (events.length === 0) {
            listEl.innerHTML = `<div class="loading" style="font-size:0.75rem;">No new scanner events</div>`;
            return;
        }

        listEl.innerHTML = events.map(evt => {
            const isHigh = evt.type === 'HIGH';
            return `
                <div class="scanner-item ${isHigh ? 'high' : 'low'}">
                    <span class="sym">${escapeHtml(evt.symbol)}</span>
                    <span style="color:var(--muted); font-size:0.65rem; font-family:var(--font);">${evt.index}</span>
                    <span>₹${evt.price?.toFixed(2)}</span>
                    <span class="badge">${isHigh ? 'High' : 'Low'}</span>
                    <span class="${isHigh ? 'up' : 'down'}" style="font-weight:700;">${isHigh ? '+' : ''}${evt.pct?.toFixed(2)}%</span>
                </div>
            `;
        }).join('');
    } catch(e) {
        console.warn("[Scanner] Polling error:", e);
    }
}

/* ════════════════════════════════════════════════
   GENERAL INDICES TICKER BAR POLLING
   ════════════════════════════════════════════════ */

async function runTickerPoll() {
    try {
        const [idx, vix] = await Promise.all([
            fetch(`${API}/api/indices`).then(r => r.json()),
            fetch(`${API}/api/vix`).then(r => r.json())
        ]);
        
        setTickerItem('tn', idx.NIFTY);
        setTickerItem('tb', idx.BANKNIFTY);
        setTickerItem('tf', idx.FINNIFTY);
        setTickerItem('ts', idx.SENSEX);
        
        // India VIX Update
        if (vix) {
            const up = vix.change >= 0;
            const priceEl = document.getElementById('tv-price');
            priceEl.textContent = vix.vix?.toFixed(2) ?? '—';
            
            const chgEl = document.getElementById('tv-change');
            chgEl.textContent = `${up ? '+' : ''}${vix.change?.toFixed(2)} (${vix.change_pct?.toFixed(2)}%)`;
            chgEl.className = `ticker-change ${up ? 'up' : 'down'}`;
        }

        // Update Sidebar overview numbers
        updateSidebarWidget(idx, vix);

        document.getElementById('ticker-time').textContent = 'Updated ' + new Date().toLocaleTimeString('en-IN');
    } catch(e) {
        console.warn("[Ticker] Polling error:", e);
    }
}

function setTickerItem(id, d) {
    if (!d) return;
    const up = d.change >= 0;
    const priceEl = document.getElementById(`${id}-price`);
    if (!priceEl) return;

    const oldPrice = priceEl.textContent;
    const newPrice = d.price?.toLocaleString('en-IN', { minimumFractionDigits: 2 }) ?? '—';
    
    if (oldPrice !== newPrice) {
        priceEl.classList.remove('flash-up', 'flash-down');
        void priceEl.offsetWidth;
        priceEl.classList.add(up ? 'flash-up' : 'flash-down');
    }
    priceEl.textContent = newPrice;

    const chgEl = document.getElementById(`${id}-change`);
    if (chgEl) {
        chgEl.textContent = `${up ? '+' : ''}${d.change?.toFixed(2)} (${d.change_pct?.toFixed(2)}%)`;
        chgEl.className = `ticker-change ${up ? 'up' : 'down'}`;
    }
}

function updateSidebarWidget(idx, vix) {
    const fmtVal = (d) => d ? `${d.price?.toLocaleString('en-IN')} <span class="${d.change >= 0 ? 'up' : 'down'}">${d.change >= 0 ? '+' : ''}${d.change?.toFixed(2)}</span>` : '—';
    
    const sensexEl = document.getElementById('sidebar-sensex');
    const niftyEl = document.getElementById('sidebar-nifty');
    const bniftyEl = document.getElementById('sidebar-bnifty');
    const vixEl = document.getElementById('sidebar-vix');

    if (sensexEl) sensexEl.innerHTML = fmtVal(idx.SENSEX);
    if (niftyEl) niftyEl.innerHTML = fmtVal(idx.NIFTY);
    if (bniftyEl) bniftyEl.innerHTML = fmtVal(idx.BANKNIFTY);
    if (vixEl && vix) {
        vixEl.innerHTML = `${vix.vix?.toFixed(2)} <span class="${vix.change >= 0 ? 'up' : 'down'}">${vix.change >= 0 ? '+' : ''}${vix.change?.toFixed(2)}</span>`;
    }
}

/* ════════════════════════════════════════════════
   TOASTS & SECURITY
   ════════════════════════════════════════════════ */

function showToast(msg, type = 'info') {
    const toast = document.getElementById('toast');
    if (!toast) return;

    toast.textContent = (type === 'success' ? '✓ ' : type === 'error' ? '✗ ' : 'ℹ ') + msg;
    toast.className = `toast-popup show ${type}`;
    
    clearTimeout(toast._timeout);
    toast._timeout = setTimeout(() => {
        toast.classList.remove('show');
    }, 4000);
}

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, "&amp;")
              .replace(/</g, "&lt;")
              .replace(/>/g, "&gt;")
              .replace(/"/g, "&quot;")
              .replace(/'/g, "&#039;");
}

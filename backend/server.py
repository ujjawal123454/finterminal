import os, json, asyncio, time, math, hashlib, secrets, re
from pathlib import Path
from typing import Dict, Optional
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
from dotenv import load_dotenv
import pandas as pd
from curl_cffi import requests as req_lib

load_dotenv()

# ── Admin Auth ───────────────────────────────────────────────────────────────
ENV_FILE = Path(__file__).parent / ".env"
admin_tokens: Dict[str, float] = {}  # token -> expiry timestamp (24h)

def get_env_val(key: str) -> str:
    """Read a key from .env file."""
    if not ENV_FILE.exists(): return ""
    for line in ENV_FILE.read_text(encoding='utf-8').splitlines():
        if line.startswith(f"{key}="):
            return line[len(key)+1:].strip()
    return ""

def set_env_val(key: str, value: str):
    """Write/update a key in .env file."""
    content = ENV_FILE.read_text(encoding='utf-8') if ENV_FILE.exists() else ""
    lines = content.splitlines(keepends=True)
    found = False
    new_lines = []
    for line in lines:
        if line.startswith(f"{key}="):
            new_lines.append(f"{key}={value}\n")
            found = True
        else:
            new_lines.append(line)
    if not found:
        if new_lines and not new_lines[-1].endswith('\n'):
            new_lines.append('\n')
        new_lines.append(f"{key}={value}\n")
    ENV_FILE.write_text(''.join(new_lines), encoding='utf-8')

def hash_password(pwd: str) -> str:
    return hashlib.sha256(pwd.encode()).hexdigest()

def verify_admin_token(authorization: Optional[str] = Header(None)) -> bool:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Unauthorized")
    token = authorization[7:]
    exp = admin_tokens.get(token, 0)
    if time.time() > exp:
        admin_tokens.pop(token, None)
        raise HTTPException(status_code=401, detail="Token expired")
    return True

app = FastAPI(title="StraddleChart Financial Terminal")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])

# Serve frontend static files
FRONTEND_DIR = Path(__file__).parent.parent  # straddle-chart-app/

@app.get("/")
async def serve_index():
    return FileResponse(str(FRONTEND_DIR / "index.html"))

@app.get("/admin")
async def serve_admin():
    return FileResponse(str(FRONTEND_DIR / "admin.html"))

@app.get("/app.js")
async def serve_appjs():
    return FileResponse(str(FRONTEND_DIR / "app.js"), media_type="application/javascript")

@app.get("/style.css")
async def serve_css():
    return FileResponse(str(FRONTEND_DIR / "style.css"), media_type="text/css")

# ── Session Store ────────────────────────────────────────────────────────────
SESSION_FILE = Path(__file__).parent / "sessions.json"
neo_clients: Dict[str, object] = {}

def save_session(session_id, data):
    sessions = {}
    if SESSION_FILE.exists():
        try: sessions = json.loads(SESSION_FILE.read_text(encoding='utf-8'))
        except: pass
    sessions[session_id] = data
    SESSION_FILE.write_text(json.dumps(sessions, indent=2), encoding='utf-8')

def load_sessions():
    if not SESSION_FILE.exists(): return
    try:
        from neo_api_client import NeoAPI
        sessions = json.loads(SESSION_FILE.read_text(encoding='utf-8'))
        consumer_key = os.getenv("KOTAK_CONSUMER_KEY", "")
        for sid, data in sessions.items():
            age = (time.time() - data.get("saved_at", 0)) / 3600
            if age > 23: continue
            # Need edit_token to call APIs — if not saved, skip (need fresh login)
            if not data.get("edit_token"):
                print(f"[SKIP] Session {sid} has no edit_token — need fresh login")
                continue
            try:
                client = NeoAPI(environment='prod', access_token=None,
                                neo_fin_key=data.get("neo_fin_key"), consumer_key=consumer_key)
                # Restore all 2FA session fields
                cfg = client.api_client.configuration
                cfg.edit_token  = data.get("edit_token")
                cfg.edit_sid    = data.get("edit_sid")
                cfg.edit_rid    = data.get("edit_rid")
                cfg.serverId    = data.get("serverId")
                cfg.data_center = data.get("data_center")
                cfg.base_url    = data.get("base_url")
                cfg.neo_fin_key = data.get("neo_fin_key")
                cfg.access_token = data.get("edit_token")  # patch for SDK
                cfg.bearer_token = data.get("edit_token")  # patch for SDK
                neo_clients[sid] = client
                print(f"[OK] Restored session: {sid} (age: {age:.1f}h)")
            except Exception as e:
                print(f"[ERR] Could not restore {sid}: {e}")
    except Exception as e:
        print(f"[ERR] load_sessions: {e}")

load_sessions()

# Cleanup: remove sessions with no edit_token from session file
try:
    if SESSION_FILE.exists():
        sessions = json.loads(SESSION_FILE.read_text(encoding='utf-8'))
        cleaned = {k: v for k, v in sessions.items() if v.get("edit_token")}
        if len(cleaned) != len(sessions):
            SESSION_FILE.write_text(json.dumps(cleaned, indent=2), encoding='utf-8')
            print(f"[Cleanup] Removed {len(sessions) - len(cleaned)} invalid sessions")
except Exception as e:
    print(f"[Cleanup] Error: {e}")

# ── NSE Session (for Indian market data) ────────────────────────────────────
NSE_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Connection": "keep-alive",
    "Referer": "https://www.nseindia.com/option-chain",
    "X-Requested-With": "XMLHttpRequest",
    "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
}
nse = req_lib.Session(impersonate="chrome")
nse.headers.update(NSE_HEADERS)
_nse_session_refreshed = 0

def ensure_nse_session():
    global _nse_session_refreshed, nse
    if time.time() - _nse_session_refreshed > 180:
        try:
            nse = req_lib.Session(impersonate="chrome")
            nse.headers.update(NSE_HEADERS)
            nse.get("https://www.nseindia.com", timeout=10)
            time.sleep(0.5)
            nse.get("https://www.nseindia.com/option-chain", timeout=10)
            time.sleep(0.5)
            _nse_session_refreshed = time.time()
            print(f"[NSE] Session refreshed, cookies: {len(nse.cookies)}")
        except Exception as e:
            print(f"[NSE] Session refresh failed: {e}")

def nse_get(url):
    ensure_nse_session()
    r = nse.get(url, timeout=12)
    r.raise_for_status()
    data = r.json()
    if isinstance(data, dict) and not data:
        raise ValueError("NSE returned empty response (bot blocked or market closed)")
    return data


# ── Black-Scholes Greeks (no scipy needed) ───────────────────────────────────
def _norm_cdf(x):
    return (1.0 + math.erf(x / math.sqrt(2.0))) / 2.0

def _norm_pdf(x):
    return math.exp(-0.5 * x * x) / math.sqrt(2 * math.pi)

def bs_greeks(S, K, T, r, sigma, opt):
    if T <= 0 or sigma <= 0 or S <= 0 or K <= 0:
        return dict(delta=0, gamma=0, theta=0, vega=0, iv=round(sigma*100,2))
    d1 = (math.log(S/K) + (r + 0.5*sigma**2)*T) / (sigma*math.sqrt(T))
    d2 = d1 - sigma*math.sqrt(T)
    pdf1 = _norm_pdf(d1)
    if opt == 'CE':
        delta = _norm_cdf(d1)
        theta = (-S*pdf1*sigma/(2*math.sqrt(T)) - r*K*math.exp(-r*T)*_norm_cdf(d2)) / 365
    else:
        delta = _norm_cdf(d1) - 1
        theta = (-S*pdf1*sigma/(2*math.sqrt(T)) + r*K*math.exp(-r*T)*_norm_cdf(-d2)) / 365
    gamma = pdf1 / (S*sigma*math.sqrt(T))
    vega = S*pdf1*math.sqrt(T) / 100
    return dict(delta=round(delta,4), gamma=round(gamma,6), theta=round(theta,2), vega=round(vega,2), iv=round(sigma*100,2))

def implied_vol_approx(price, S, K, T, r, opt):
    """Approximate IV using Brenner-Subrahmanyam formula"""
    if T <= 0 or S <= 0: return 0.20
    intrinsic = max(0, S-K) if opt=='CE' else max(0, K-S)
    if price <= intrinsic: return 0.001
    try:
        sigma = math.sqrt(2*math.pi/T) * price / S
        sigma = max(0.01, min(sigma, 5.0))
        for _ in range(20):
            d1 = (math.log(S/K) + (r + 0.5*sigma**2)*T) / (sigma*math.sqrt(T))
            d2 = d1 - sigma*math.sqrt(T)
            if opt == 'CE': theo = S*_norm_cdf(d1) - K*math.exp(-r*T)*_norm_cdf(d2)
            else: theo = K*math.exp(-r*T)*_norm_cdf(-d2) - S*_norm_cdf(-d1)
            vega = S*_norm_pdf(d1)*math.sqrt(T)
            if vega < 1e-8: break
            sigma -= (theo - price) / vega
            sigma = max(0.001, min(sigma, 5.0))
        return round(sigma, 4)
    except: return 0.20

def build_up_label(price_chg, oi_chg):
    if price_chg >= 0 and oi_chg >= 0: return "Long Buildup"
    if price_chg < 0 and oi_chg >= 0: return "Short Buildup"
    if price_chg < 0 and oi_chg < 0: return "Long Unwinding"
    return "Short Covering"

# ── Models ────────────────────────────────────────────────────────────────────
class LoginRequest(BaseModel):
    mobile: str; password: str; mpin: str; totp: str; ucc: str

class AdminLoginRequest(BaseModel):
    password: str

class AdminConfigRequest(BaseModel):
    consumer_key: str
    consumer_secret: Optional[str] = ""

class AdminPasswordRequest(BaseModel):
    new_password: str

# ── Neo Data Fetcher ─────────────────────────────────────────────────────────
class NeoDataFetcher:
    def __init__(self):
        self.tokens = {}  # Symbol -> Token
        self.expiry_cache = {} # Symbol -> nearest_expiry
        self.last_scrip_update = 0

    def get_client(self):
        if not neo_clients: return None
        return list(neo_clients.values())[0]

    async def get_quotes(self, tokens: list):
        client = self.get_client()
        if not client: return []
        try:
            # quotes is a synchronous call in the SDK
            resp = client.quotes(instrument_tokens=tokens, quote_type="LTP")
            if isinstance(resp, dict) and "items" in resp:
                return resp["items"]
            return []
        except: return []

    def get_nearest_expiry(self, symbol):
        # Cache for 1 hour
        if symbol in self.expiry_cache:
            data, ts = self.expiry_cache[symbol]
            if time.time() - ts < 3600:
                return data

        client = self.get_client()
        if not client: return None, []
        try:
            # Search for one CE to get the expiry list
            resp = client.search_scrip(exchange_segment="nse_fo", symbol=symbol, option_type="CE")
            if isinstance(resp, list) and len(resp) > 0:
                valid = [s for s in resp if s.get("pSymbolName","").upper() == symbol.upper()]
                
                # Parse and sort expiries chronologically
                import datetime
                expiries = set()
                now = datetime.datetime.now()
                for s in valid:
                    exp_str = s.get("pExpiryDate")
                    if exp_str:
                        try:
                            dt = datetime.datetime.strptime(exp_str, "%d%b%Y")
                            if dt >= now - datetime.timedelta(days=1): # Allow today
                                expiries.add((dt, exp_str))
                        except: pass
                
                sorted_expiries = sorted(list(expiries), key=lambda x: x[0])
                if sorted_expiries:
                    exp_list = [x[1] for x in sorted_expiries]
                    res = (exp_list[0], exp_list)
                    self.expiry_cache[symbol] = (res, time.time())
                    return res
        except: pass
        return None, []

    async def get_neo_option_chain(self, symbol):
        client = self.get_client()
        if not client: 
            print("[NeoOC] No active client")
            return None
        
        try:
            # 1. Get spot
            indices = await self.get_index_quotes()
            if not indices or symbol not in indices: 
                print(f"[NeoOC] Could not get spot for {symbol}")
                return None
            spot = indices[symbol]["price"]
            
            # Strike step logic
            step = 50
            if "BANK" in symbol: step = 100
            elif "FIN" in symbol: step = 40
            
            atm = round(spot / step) * step
            
            # 2. Get nearest expiry
            expiry_res = self.get_nearest_expiry(symbol)
            if not expiry_res or not expiry_res[0]: 
                print(f"[NeoOC] No expiry found for {symbol}")
                return None
            expiry, all_expiries = expiry_res
            
            # 3. Find tokens for ~10 strikes above and below ATM
            strikes = [atm + (i * step) for i in range(-12, 13)]
            
            # 4. Search for scrips
            print(f"[NeoOC] Searching scrips for {symbol} {expiry}...")
            resp = client.search_scrip(exchange_segment="nse_fo", symbol=symbol, expiry=expiry)
            if not isinstance(resp, list):
                print(f"[NeoOC] search_scrip failed: {resp}")
                return None
            
            scrips = [s for s in resp if s.get("pSymbolName","").upper() == symbol.upper() and s.get("pExpiryDate") == expiry]
            if not scrips:
                print(f"[NeoOC] No scrips found after filtering for {symbol} {expiry}")
                return None

            # 5. Map strikes to tokens
            tokens_to_fetch = []
            strike_map = {} # strike -> {CE: token, PE: token}
            for s in scrips:
                try:
                    # Kotak typically returns strikes multiplied by 100 or 1000 in search
                    stk = s.get("dStrikePrice;", s.get("pStrikePrice", s.get("dStrikePrice")))
                    if stk is None: continue
                    stk = float(stk)
                    if stk > 100000: stk = stk / 100
                    
                    if stk not in strikes: continue
                    typ = s.get("pOptionType")
                    if stk not in strike_map: strike_map[stk] = {}
                    
                    token = s.get("pInstToken", s.get("pSymbol"))
                    if not token: continue
                    
                    strike_map[stk][typ] = token
                    tokens_to_fetch.append({"instrument_token": str(token), "exchange_segment": "nse_fo"})
                except Exception as e:
                    continue

            if not tokens_to_fetch:
                print(f"[NeoOC] No tokens found for strikes {strikes}")
                return None

            # 6. Get live quotes
            print(f"[NeoOC] Fetching quotes for {len(tokens_to_fetch)} tokens...")
            quotes_resp = client.quotes(instrument_tokens=tokens_to_fetch)
            if not isinstance(quotes_resp, list):
                print(f"[NeoOC] quotes call failed: {quotes_resp}")
                return None
            
            q_map = {str(q.get("exchange_token")): q for q in quotes_resp}
            
            rows = []
            for stk in sorted(strike_map.keys()):
                ce_token = str(strike_map[stk].get("CE"))
                pe_token = str(strike_map[stk].get("PE"))
                ce_q = q_map.get(ce_token, {})
                pe_q = q_map.get(pe_token, {})
                
                rows.append({
                    "strike": stk,
                    "ce": {"ltp": float(ce_q.get("ltp", 0)), "oi": int(ce_q.get("open_int", 0)), "vol": int(ce_q.get("last_volume", 0)), 
                           "chg": float(ce_q.get("change", 0)), "oiChg": 0},
                    "pe": {"ltp": float(pe_q.get("ltp", 0)), "oi": int(pe_q.get("open_int", 0)), "vol": int(pe_q.get("last_volume", 0)), 
                           "chg": float(pe_q.get("change", 0)), "oiChg": 0}
                })
            
            if rows:
                atm_row = min(rows, key=lambda x: abs(x["strike"] - spot))
                if atm_row["ce"]["ltp"] == 0 and atm_row["pe"]["ltp"] == 0:
                    print(f"[NeoOC] Market closed — returning strike structure with error flag for {symbol}")
                    # Return data structure but with error flag — frontend will show 'Market Closed'
                    return {
                        "symbol": symbol, "spot": spot, "atm": atm, "expiry": expiry,
                        "expiries": all_expiries[:8], "rows": rows, "pcr": 0,
                        "error": "Market Closed — Showing today's closing data",
                        "source": "Kotak Neo (EOD)"
                    }
            
            return {
                "symbol": symbol, "spot": spot, "atm": atm, "expiry": expiry,
                "expiries": all_expiries[:8], "rows": rows, "pcr": 0, "source": "Kotak Neo (Real-time)"
            }
        except Exception as e:
            import traceback
            print(f"[NeoOC] Fatal Error: {e}")
            traceback.print_exc()
            return None

    async def get_index_quotes(self):
        """Get index spot prices — tries Neo first, falls back to Yahoo Finance."""
        client = self.get_client()
        if client:
            # Try Kotak Neo quotes with nse_fo segment for index tokens
            for seg in ["nse_cm", "nse_fo"]:
                try:
                    tokens = [
                        {"instrument_token": "26000", "exchange_segment": seg},
                        {"instrument_token": "26001", "exchange_segment": seg},
                        {"instrument_token": "26037", "exchange_segment": seg},
                    ]
                    resp = client.quotes(instrument_tokens=tokens, quote_type="LTP")
                    if isinstance(resp, dict) and "items" in resp and len(resp.get("items", [])) > 0:
                        data = {i["instrument_token"]: i for i in resp["items"]}
                        def val(k, field):
                            v = data.get(k, {}).get(field, 0)
                            return float(v) if v else 0
                        res = {
                            "NIFTY":     {"price": val("26000","ltp"), "change": val("26000","change"), "change_pct": val("26000","pChange")},
                            "BANKNIFTY": {"price": val("26001","ltp"), "change": val("26001","change"), "change_pct": val("26001","pChange")},
                            "FINNIFTY":  {"price": val("26037","ltp"), "change": val("26037","change"), "change_pct": val("26037","pChange")},
                        }
                        if res["NIFTY"]["price"] > 0:
                            print(f"[Neo] Index quotes via {seg}: NIFTY={res['NIFTY']['price']}")
                            return res
                except Exception as e:
                    print(f"[Neo] quotes({seg}) failed: {e}")
                    continue

        # Reliable fallback: Yahoo Finance
        try:
            hdrs = {"User-Agent": "Mozilla/5.0"}
            mapping = {"NIFTY": "^NSEI", "BANKNIFTY": "^NSEBANK", "FINNIFTY": "NIFTY_FIN_SERVICE.NS"}
            res = {}
            for name, sym in mapping.items():
                url = f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}?interval=1m&range=1d"
                r = req_lib.get(url, headers=hdrs, timeout=5).json()
                meta = r["chart"]["result"][0]["meta"]
                price = float(meta.get("regularMarketPrice", 0))
                prev  = float(meta.get("chartPreviousClose") or meta.get("previousClose") or price)
                chg   = price - prev
                res[name] = {"price": round(price,2), "change": round(chg,2), "change_pct": round(chg/prev*100 if prev else 0, 2)}
            if res.get("NIFTY",{}).get("price", 0) > 0:
                return res
        except Exception as e:
            print(f"[Neo] Yahoo index fallback failed: {e}")
        return None

    async def get_stock_quote(self, symbol: str):
        """Fetch detailed quote for a stock."""
        client = self.get_client()
        # Ensure .NS for Yahoo
        yf_sym = symbol if "." in symbol else f"{symbol}.NS"
        
        # 1. Try Kotak Neo if logged in
        if client:
            try:
                # Search for scrip to get token
                search = client.search_scrip(exchange_segment="nse_cm", symbol=symbol)
                if isinstance(search, list) and len(search) > 0:
                    token = search[0].get("pInstToken")
                    if token:
                        resp = client.quotes(instrument_tokens=[{"instrument_token": str(token), "exchange_segment": "nse_cm"}])
                        if isinstance(resp, list) and len(resp) > 0:
                            q = resp[0]
                            return {
                                "symbol": symbol,
                                "ltp": float(q.get("ltp", 0)),
                                "open": float(q.get("open", 0)),
                                "high": float(q.get("high", 0)),
                                "low": float(q.get("low", 0)),
                                "close": float(q.get("close", 0)),
                                "change": float(q.get("change", 0)),
                                "pct": float(q.get("pChange", 0)),
                                "volume": int(q.get("v", 0)),
                                "source": "Kotak Neo"
                            }
            except Exception as e:
                print(f"[Neo] Stock quote failed for {symbol}: {e}")

        # 2. Fallback to Yahoo Finance
        try:
            import yfinance as yf
            ticker = yf.Ticker(yf_sym)
            info = ticker.fast_info
            # fast_info is better for real-time-ish
            price = info.last_price
            prev = info.previous_close
            chg = price - prev
            return {
                "symbol": symbol,
                "ltp": round(price, 2),
                "open": round(info.open, 2),
                "high": round(info.day_high, 2),
                "low": round(info.day_low, 2),
                "close": round(prev, 2),
                "change": round(chg, 2),
                "pct": round((chg/prev*100) if prev else 0, 2),
                "volume": int(info.last_volume),
                "source": "Live Feed"
            }
        except Exception as e:
            print(f"[YF] Stock quote failed for {symbol}: {e}")
            return None

    async def get_stock_chart(self, symbol: str, interval: str = "1m"):
        """Fetch intraday OHLC data for charting."""
        yf_sym = symbol if "." in symbol else f"{symbol}.NS"
        try:
            import yfinance as yf
            # period '1d' or '5d'
            df = yf.download(yf_sym, period="1d", interval=interval, progress=False)
            if df.empty:
                df = yf.download(yf_sym, period="5d", interval="5m", progress=False)
            
            if df.empty: return []

            # Handle MultiIndex columns (yfinance >= 0.2.40)
            if isinstance(df.columns, pd.MultiIndex):
                df.columns = df.columns.get_level_values(0)

            # Format for Lightweight Charts
            chart_data = []
            for index, row in df.iterrows():
                chart_data.append({
                    "time": int(index.timestamp()),
                    "open": float(row['Open']),
                    "high": float(row['High']),
                    "low": float(row['Low']),
                    "close": float(row['Close']),
                    "volume": float(row['Volume'])
                })
            return chart_data
        except Exception as e:
            print(f"[YF] Chart data failed for {symbol}: {e}")
            return []

neo_fetcher = NeoDataFetcher()

# ─────────────────────────────────────────────────────────────────────────────
# ENDPOINTS
# ─────────────────────────────────────────────────────────────────────────────

# 1. Index Ticker (existing)
INDEX_SYMBOLS = {"NIFTY": "^NSEI", "BANKNIFTY": "^NSEBANK", "FINNIFTY": "NIFTY_FIN_SERVICE.NS", "SENSEX": "^BSESN"}

@app.get("/api/indices")
async def get_indices():
    results = {}
    
    # Priority: Kotak Neo Real-time for NSE indices
    neo_data = await neo_fetcher.get_index_quotes()
    if neo_data:
        results.update(neo_data)

    # Fallback: Yahoo Finance for any missing indices (always fetch SENSEX from Yahoo)
    hdrs = {"User-Agent": "Mozilla/5.0", "Accept": "application/json"}
    for name, sym in INDEX_SYMBOLS.items():
        if name in results and name != "SENSEX":
            continue  # Already have from Neo
        try:
            url = f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}?interval=1m&range=5d"
            r = req_lib.get(url, headers=hdrs, timeout=5).json()
            meta = r["chart"]["result"][0]["meta"]
            price = meta.get("regularMarketPrice", 0)
            prev = meta.get("chartPreviousClose") or meta.get("previousClose") or price
            chg = price - prev
            results[name] = {"price": round(price,2), "change": round(chg,2), "change_pct": round(chg/prev*100 if prev else 0,2)}
        except Exception as e:
            if name not in results:
                results[name] = {"price": 0, "change": 0, "change_pct": 0, "error": str(e)}
    return results

# 2. Global Markets (Brent, NASDAQ, Dow, Gold, USDINR, S&P)
GLOBAL_SYMBOLS = {
    "Brent Crude": {"sym": "BZ=F", "unit": "USD/bbl"},
    "NASDAQ 100 Futures": {"sym": "NQ=F", "unit": "pts"},
    "Dow Futures": {"sym": "YM=F", "unit": "pts"},
    "S&P 500": {"sym": "ES=F", "unit": "pts"},
    "Gold (USD)": {"sym": "GC=F", "unit": "USD/oz"},
    "USD/INR": {"sym": "USDINR=X", "unit": "INR"},
}

@app.get("/api/global")
def get_global():
    results = {}
    hdrs = {"User-Agent": "Mozilla/5.0"}
    for name, info in GLOBAL_SYMBOLS.items():
        try:
            url = f"https://query1.finance.yahoo.com/v8/finance/chart/{info['sym']}?interval=5m&range=5d"
            r = req_lib.get(url, headers=hdrs, timeout=6).json()
            meta = r["chart"]["result"][0]["meta"]
            price = meta.get("regularMarketPrice", 0)
            prev = meta.get("chartPreviousClose") or meta.get("previousClose") or price
            chg = price - prev
            closes = r["chart"]["result"][0].get("indicators", {}).get("quote", [{}])[0].get("close", [])
            closes = [c for c in closes if c is not None][-20:]
            results[name] = {"price": round(price,2), "change": round(chg,2),
                             "change_pct": round(chg/prev*100 if prev else 0,2),
                             "unit": info["unit"], "spark": closes}
        except Exception as e:
            results[name] = {"price": 0, "change": 0, "change_pct": 0, "unit": info.get("unit",""), "spark": [], "error": str(e)}
    return results

# 3. VIX
@app.get("/api/vix")
def get_vix():
    hdrs = {"User-Agent": "Mozilla/5.0"}
    try:
        url = "https://query1.finance.yahoo.com/v8/finance/chart/%5EINDIAVIX?interval=1m&range=1d"
        r = req_lib.get(url, headers=hdrs, timeout=5).json()
        meta = r["chart"]["result"][0]["meta"]
        price = meta.get("regularMarketPrice", 0)
        prev = meta.get("previousClose", price) or price
        return {"vix": round(price,2), "change": round(price-prev,2), "change_pct": round((price-prev)/prev*100 if prev else 0,2)}
    except Exception as e:
        return {"vix": 0, "change": 0, "change_pct": 0, "error": str(e)}

# 4. Option Chain
@app.get("/api/option-chain/{symbol}")
async def get_option_chain(symbol: str):
    symbol = symbol.upper()
    
    # Priority: Kotak Neo Real-time
    neo_data = await neo_fetcher.get_neo_option_chain(symbol)
    if neo_data:
        return neo_data

    # Fallback: NSE Scraping
    try:
        url = f"https://www.nseindia.com/api/option-chain-indices?symbol={symbol}"
        data = nse_get(url)
        if not data or "records" not in data:
            return {"symbol": symbol, "spot": 0, "expiry": "", "expiries": [], "pcr": 0, "rows": [], "atm": 0, "error": "Market Closed (Data Unavailable)"}
        
        records = data.get("records", {})
        exp_dates = records.get("expiryDates", [])
        spot = records.get("underlyingValue", 0)
        r = 0.065  # risk-free rate
        rows = []
        expiry = exp_dates[0] if exp_dates else ""

        for item in records.get("data", []):
            if item.get("expiryDate") != expiry: continue
            strike = item.get("strikePrice", 0)
            ce = item.get("CE", {}); pe = item.get("PE", {})
            
            try:
                import datetime
                exp_dt = datetime.datetime.strptime(expiry, "%d-%b-%Y")
                T = max((exp_dt - datetime.datetime.now()).days / 365, 0.001)
            except: T = 30/365

            ce_ltp = ce.get("lastPrice", 0); pe_ltp = pe.get("lastPrice", 0)
            ce_oi = ce.get("openInterest", 0); pe_oi = pe.get("openInterest", 0)
            ce_chg = ce.get("change", 0); pe_chg = pe.get("change", 0)
            ce_oichg = ce.get("changeinOpenInterest", 0); pe_oichg = pe.get("changeinOpenInterest", 0)

            ce_iv = implied_vol_approx(ce_ltp, spot, strike, T, r, 'CE')
            pe_iv = implied_vol_approx(pe_ltp, spot, strike, T, r, 'PE')
            ce_greeks = bs_greeks(spot, strike, T, r, ce_iv, 'CE')
            pe_greeks = bs_greeks(spot, strike, T, r, pe_iv, 'PE')

            rows.append({
                "strike": strike,
                "ce": {"ltp": ce_ltp, "oi": ce_oi, "oiChg": ce_oichg, "vol": ce.get("totalTradedVolume",0),
                       "chg": ce_chg, "buildup": build_up_label(ce_chg, ce_oichg), **ce_greeks},
                "pe": {"ltp": pe_ltp, "oi": pe_oi, "oiChg": pe_oichg, "vol": pe.get("totalTradedVolume",0),
                       "chg": pe_chg, "buildup": build_up_label(pe_chg, pe_oichg), **pe_greeks},
            })

        total_ce_oi = sum(r["ce"]["oi"] for r in rows)
        total_pe_oi = sum(r["pe"]["oi"] for r in rows)
        pcr = round(total_pe_oi / total_ce_oi, 2) if total_ce_oi else 0

        return {"symbol": symbol, "spot": spot, "expiry": expiry,
                "expiries": exp_dates[:5], "pcr": pcr, "rows": rows, "atm": round(spot/50)*50}
    except Exception as e:
        return {"symbol": symbol, "spot": 0, "expiry": "", "expiries": [], "pcr": 0, "rows": [], "atm": 0, "error": str(e)}

# ── Yahoo Finance helpers for Indian market stocks ───────────────────────────
NIFTY50_SYMBOLS = [
    "RELIANCE.NS","TCS.NS","HDFCBANK.NS","BHARTIARTL.NS","ICICIBANK.NS",
    "SBIN.NS","INFOSYS.NS","HINDUNILVR.NS","ITC.NS","LT.NS",
    "KOTAKBANK.NS","AXISBANK.NS","MARUTI.NS","SUNPHARMA.NS","NESTLEIND.NS",
    "TITAN.NS","WIPRO.NS","ULTRACEMCO.NS","BAJFINANCE.NS","BAJAJFINSV.NS",
    "HCLTECH.NS","POWERGRID.NS","NTPC.NS","ONGC.NS","TATAMOTORS.NS",
]
_yf_cache = {"data": [], "ts": 0}

async def get_nifty_movers():
    global _yf_cache
    if time.time() - _yf_cache["ts"] < 60: # 1 min cache
        return _yf_cache["data"]
    
    client = neo_fetcher.get_client()
    if client:
        try:
            # Map .NS to Neo format (just the symbol for NSE CM)
            tokens = []
            for s in NIFTY50_SYMBOLS:
                # We need to find tokens for these. For CM, tokens are often static but search is safer.
                # However, searching 50 times is slow.
                # Let's use the most common Nifty stocks tokens if we had them.
                # Since we don't have a static list, we'll try to fetch a few top ones via search.
                pass
        except: pass

    # Current yfinance logic as base/fallback
    hdrs = {"User-Agent": "Mozilla/5.0"}
    results = []
    for sym in NIFTY50_SYMBOLS:
        try:
            url = f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}?interval=1d&range=5d"
            r = req_lib.get(url, headers=hdrs, timeout=5).json()
            meta = r["chart"]["result"][0]["meta"]
            price = meta.get("regularMarketPrice", 0)
            prev = meta.get("chartPreviousClose") or meta.get("previousClose") or price
            chg = price - prev
            pct = round(chg/prev*100, 2) if prev else 0
            results.append({"symbol": sym.replace(".NS",""), "ltp": round(price,2),
                            "change": round(chg,2), "pct": pct, "volume": 0})
        except: pass
    _yf_cache = {"data": results, "ts": time.time()}
    return results

# 5. Gainers & Losers
@app.get("/api/gainers-losers/{index}")
async def get_gainers_losers(index: str):
    # Try NSE first, fallback to yfinance
    idx_label = {"NIFTY":"NIFTY 50","BANKNIFTY":"NIFTY BANK","FINNIFTY":"NIFTY FIN SERVICE"}.get(index.upper(),"NIFTY 50")
    try:
        data = nse_get(f"https://www.nseindia.com/api/equity-stockIndices?index={idx_label.replace(' ','%20')}")
        stocks = data.get("data", [])[1:]
        if not stocks: raise ValueError("Empty NSE data")
        gainers = sorted([s for s in stocks if s.get("pChange",0) > 0], key=lambda x: x.get("pChange",0), reverse=True)[:5]
        losers  = sorted([s for s in stocks if s.get("pChange",0) < 0], key=lambda x: x.get("pChange",0))[:5]
        def fmt(s): return {"symbol":s.get("symbol",""),"ltp":s.get("lastPrice",0),
                            "change":round(s.get("change",0),2),"pct":round(s.get("pChange",0),2),"volume":s.get("totalTradedVolume",0)}
        return {"gainers":[fmt(s) for s in gainers],"losers":[fmt(s) for s in losers],"source":"NSE"}
    except Exception as e:
        print(f"[GL] NSE failed ({e}), using yfinance")
        stocks = await get_nifty_movers()
        gainers = sorted([s for s in stocks if s["pct"] > 0], key=lambda x: x["pct"], reverse=True)[:5]
        losers  = sorted([s for s in stocks if s["pct"] < 0], key=lambda x: x["pct"])[:5]
        return {"gainers":gainers,"losers":losers,"source":"Yahoo Finance (15min delay)"}

# 6. 52-Week High / Low stocks
@app.get("/api/day-extremes")
async def get_day_extremes():
    try:
        data  = nse_get("https://www.nseindia.com/api/live-analysis-variations?index=new52weekhigh")
        data2 = nse_get("https://www.nseindia.com/api/live-analysis-variations?index=new52weeklow")
        if not isinstance(data, dict) or not isinstance(data2, dict): raise ValueError("Bad NSE response")
        def fmt(s, typ): return {"symbol":s.get("symbol",s.get("symbolName","")),"price":s.get("ltp",s.get("ltP",0)),
                                  "pct":round(s.get("pChange",s.get("per_chg",0)),2),"type":typ}
        return {"highs":[fmt(s,"52W High") for s in data.get("data",[])[:8]],
                "lows":[fmt(s,"52W Low") for s in data2.get("data",[])[:8]],"source":"NSE"}
    except Exception as e:
        print(f"[Extremes] NSE failed ({e}), using yfinance")
        stocks = await get_nifty_movers()
        highs = sorted([s for s in stocks if s["pct"] > 0], key=lambda x: x["pct"], reverse=True)[:8]
        lows  = sorted([s for s in stocks if s["pct"] < 0], key=lambda x: x["pct"])[:8]
        def fmt2(s, typ): return {"symbol":s["symbol"],"price":s["ltp"],"pct":s["pct"],"type":typ}
        return {"highs":[fmt2(s,"Day Top Gainer") for s in highs],"lows":[fmt2(s,"Day Top Loser") for s in lows],"source":"Live Feed (Delayed)"}

# 6b. Stock Details & Chart
@app.get("/api/stock-quote/{symbol}")
async def get_stock_details(symbol: str):
    res = await neo_fetcher.get_stock_quote(symbol.upper())
    if not res: raise HTTPException(status_code=404, detail="Stock not found")
    return res

@app.get("/api/stock-chart/{symbol}")
async def get_stock_chart_data(symbol: str, interval: str = "1m"):
    res = await neo_fetcher.get_stock_chart(symbol.upper(), interval)
    return res

@app.get("/api/intraday-high-low")
async def get_intraday_high_low():
    try:
        data = nse_get("https://www.nseindia.com/api/equity-stockIndices?index=NIFTY%2050")
        stocks = data.get("data", [])[1:]
        highs = [s for s in stocks if s.get("lastPrice", 0) >= s.get("dayHigh", 1) * 0.998]
        lows = [s for s in stocks if s.get("lastPrice", 0) <= s.get("dayLow", 0) * 1.002]
        def fmt(s): return {"symbol":s.get("symbol"), "ltp":s.get("lastPrice"), "high":s.get("dayHigh"), "low":s.get("dayLow"), "pct":s.get("pChange")}
        return {
            "highs": [fmt(s) for s in sorted(highs, key=lambda x: x.get("pChange", 0), reverse=True)[:10]],
            "lows": [fmt(s) for s in sorted(lows, key=lambda x: x.get("pChange", 0))[:10]],
            "source": "NSE"
        }
    except Exception as e:
        print(f"[IntradayHL] failed: {e}")
        return {"highs": [], "lows": [], "error": str(e)}

# ── Pullers / Draggers ────────────────────────────────────────────────────────
IDX_MAP = {
    "NIFTY": "NIFTY 50",
    "BANKNIFTY": "NIFTY BANK",
    "FINNIFTY": "NIFTY FIN SERVICE",
    "SENSEX": "SENSEX",
}

_pd_cache = {}

@app.get("/api/pullers-draggers/{index}")
async def get_pullers_draggers(index: str):
    idx_label = IDX_MAP.get(index.upper(), "NIFTY 50")
    cache_key = index.upper()
    now = time.time()
    if cache_key in _pd_cache and now - _pd_cache[cache_key]["ts"] < 30:
        return _pd_cache[cache_key]["data"]

    try:
        if idx_label == "SENSEX":
            url = "https://www.nseindia.com/api/equity-stockIndices?index=BSE%20SENSEX"
            try:
                data = nse_get(url)
            except:
                url2 = "https://www.nseindia.com/api/equity-stockIndices?index=NIFTY%2050"
                data = nse_get(url2)
        else:
            url = f"https://www.nseindia.com/api/equity-stockIndices?index={idx_label.replace(' ', '%20')}"
            data = nse_get(url)

        all_stocks = data.get("data", [])
        index_row = all_stocks[0] if all_stocks else {}
        stocks = all_stocks[1:]
        if not stocks:
            raise ValueError("Empty stock list")

        total_count = len(stocks)
        # Calculate weighted points (approximate): change * (1/total_count) as weight proxy
        results = []
        for s in stocks:
            change = s.get("change", 0)
            pct = round(s.get("pChange", 0), 2)
            ltp = s.get("lastPrice", 0)
            # Weighted point: approximate contribution
            w_point = round(change * (100 / total_count) / max(ltp, 1) * ltp / 100, 2) if ltp else 0
            results.append({
                "symbol": s.get("symbol", ""),
                "ltp": ltp,
                "change": round(change, 2),
                "pct": pct,
                "wPoint": round(abs(pct) * 0.5, 2),  # Simplified weight
                "open": s.get("open", 0),
                "high": s.get("dayHigh", 0),
                "low": s.get("dayLow", 0),
                "volume": s.get("totalTradedVolume", 0),
                "prevClose": s.get("previousClose", 0),
            })

        pullers = sorted([s for s in results if s["pct"] > 0], key=lambda x: x["wPoint"], reverse=True)
        draggers = sorted([s for s in results if s["pct"] < 0], key=lambda x: x["wPoint"], reverse=True)

        resp = {
            "index": idx_label,
            "indexPrice": index_row.get("lastPrice", 0),
            "indexChange": round(index_row.get("change", 0), 2),
            "indexPct": round(index_row.get("pChange", 0), 2),
            "timestamp": index_row.get("lastUpdateTime", ""),
            "pullersCount": len(pullers),
            "draggersCount": len(draggers),
            "totalStocks": total_count,
            "pullers": pullers[:15],
            "draggers": draggers[:15],
        }
        _pd_cache[cache_key] = {"data": resp, "ts": now}
        return resp
    except Exception as e:
        print(f"[PD] Error for {index}: {e}")
        import traceback; traceback.print_exc()
        if cache_key in _pd_cache:
            return _pd_cache[cache_key]["data"]
        return {"index": idx_label, "pullers": [], "draggers": [], "pullersCount": 0, "draggersCount": 0, "totalStocks": 0, "error": str(e)}

# ── Live Scanner (Day High/Low across indices) ────────────────────────────────
_scanner_cache = {"data": [], "ts": 0}

@app.get("/api/live-scanner")
async def get_live_scanner():
    now = time.time()
    if _scanner_cache["data"] and now - _scanner_cache["ts"] < 15:
        return _scanner_cache["data"]
    try:
        events = []
        for idx_name, idx_label in [("NIFTY", "NIFTY%2050"), ("BANKNIFTY", "NIFTY%20BANK")]:
            try:
                data = nse_get(f"https://www.nseindia.com/api/equity-stockIndices?index={idx_label}")
                stocks = data.get("data", [])[1:]
                for s in stocks:
                    ltp = s.get("lastPrice", 0)
                    high = s.get("dayHigh", 0)
                    low = s.get("dayLow", 0)
                    sym = s.get("symbol", "")
                    if ltp and high and ltp >= high * 0.999:
                        events.append({"symbol": sym, "type": "HIGH", "price": ltp, "level": high, "index": idx_name, "pct": round(s.get("pChange", 0), 2)})
                    elif ltp and low and ltp <= low * 1.001:
                        events.append({"symbol": sym, "type": "LOW", "price": ltp, "level": low, "index": idx_name, "pct": round(s.get("pChange", 0), 2)})
            except Exception as e2:
                print(f"[Scanner] Error for {idx_name}: {e2}")

        # Sort by absolute pct (most active first)
        events.sort(key=lambda x: abs(x["pct"]), reverse=True)
        _scanner_cache["data"] = events[:30]
        _scanner_cache["ts"] = now
        return events[:30]
    except Exception as e:
        print(f"[Scanner] Error: {e}")
        return _scanner_cache["data"] if _scanner_cache["data"] else []


from market_scraper import ChittorgarhScraper

scraper = ChittorgarhScraper()
ipo_cache = {"data": None, "expiry": 0}

@app.get("/api/ipo")
async def get_ipo_data(type: str = "mainline"):
    # Cache for 1 hour
    now = time.time()
    if not ipo_cache["data"] or now > ipo_cache["expiry"]:
        print("[IPO] Refreshing cache...")
        try:
            # Fetch each independently to avoid one failure blocking all
            mainline = scraper.get_mainline_ipo()
            sme = scraper.get_sme_ipo()
            gmp = scraper.get_gmp()
            bonds = scraper.get_bonds()
            
            ipo_cache["data"] = {
                "mainline": mainline if mainline else [],
                "sme": sme if sme else [],
                "gmp": gmp if gmp else [],
                "bonds": bonds if bonds else []
            }
            ipo_cache["expiry"] = now + 3600
        except Exception as e:
            print(f"IPO Global Fetch Error: {e}")
            if not ipo_cache["data"]:
                raise HTTPException(status_code=500, detail=f"Failed to fetch IPO data: {str(e)}")
    
    return ipo_cache["data"].get(type, [])

@app.get("/api/bonds")
async def get_bonds_data():
    return await get_ipo_data("bonds")

fii_cache = {"data": [], "expiry": 0}

@app.get("/api/fii-dii")
async def get_fii_dii():
    now = time.time()
    if fii_cache["data"] and now < fii_cache["expiry"]:
        return fii_cache["data"]
    try:
        data = scraper.get_fii_dii()
        if data:
            fii_cache["data"] = data
            fii_cache["expiry"] = now + 300  # 5 min cache
        return data if data else []
    except Exception as e:
        print(f"FII/DII Error: {e}")
        import traceback; traceback.print_exc()
        return fii_cache["data"] if fii_cache["data"] else []

# FII/DII and IPO handled above


# 8. Session check
@app.get("/api/session/{session_id}")
def check_session(session_id: str):
    return {"valid": session_id in neo_clients}

# 9. Login
@app.post("/api/neo/login")
async def login_neo(req: LoginRequest):
    from neo_api_client import NeoAPI
    consumer_key = os.getenv("KOTAK_CONSUMER_KEY")
    if not consumer_key or consumer_key == "YOUR_CONSUMER_KEY_HERE":
        raise HTTPException(status_code=500, detail="Backend missing KOTAK_CONSUMER_KEY in .env")
    try:
        client = NeoAPI(environment='prod', access_token=None, neo_fin_key=None, consumer_key=consumer_key)
        client.api_client.configuration.access_token = None  # patch

        # Step 1: TOTP Login (sends OTP to mobile, verifies TOTP)
        mobile = f"+91{req.mobile}" if not req.mobile.startswith('+') else req.mobile
        login_resp = client.totp_login(mobile_number=mobile, ucc=req.ucc, totp=req.totp)
        print(f"[Login] totp_login response: {login_resp}")

        if isinstance(login_resp, dict) and login_resp.get("stat") == "Not_Ok":
            errs = login_resp.get("error", [{}])
            raise Exception(errs[0].get("message", "TOTP Login failed"))

        # Step 2: MPIN Validation — this sets edit_token, edit_sid, base_url, etc.
        val_resp = client.totp_validate(mpin=req.mpin)
        print(f"[Login] totp_validate response: {val_resp}")

        if isinstance(val_resp, dict) and val_resp.get("stat") == "Not_Ok":
            errs = val_resp.get("error", [{}])
            raise Exception(errs[0].get("message", "MPIN Validation failed"))

        # Read all auth fields from config after successful 2FA
        cfg = client.api_client.configuration
        session_id = f"sess_{req.ucc}_{req.mobile[-4:]}"
        neo_clients[session_id] = client

        # Save ALL session fields needed to restore later
        save_session(session_id, {
            "edit_token":  cfg.edit_token,
            "edit_sid":    cfg.edit_sid,
            "edit_rid":    cfg.edit_rid,
            "serverId":    cfg.serverId,
            "data_center": cfg.data_center,
            "base_url":    cfg.base_url,
            "neo_fin_key": cfg.neo_fin_key,
            "saved_at":    time.time()
        })
        print(f"[OK] Login success. edit_token={'SET' if cfg.edit_token else 'MISSING'}, base_url={cfg.base_url}")
        return {"success": True, "session_id": session_id, "message": "Successfully authenticated!"}
    except Exception as e:
        print(f"[ERR] Kotak Login Error: {e}")
        import traceback; traceback.print_exc()
        raise HTTPException(status_code=400, detail=f"Authentication failed: {str(e)}")

# 10. WebSocket
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    client_instance = None
    try:
        auth_message = await websocket.receive_text()
        data = json.loads(auth_message)
        if data.get("action") == "authenticate":
            session_id = data.get("session_id")
            if session_id in neo_clients:
                client_instance = neo_clients[session_id]
                await websocket.send_text(json.dumps({"type": "status", "message": "Connected to Kotak Neo Live Feed"}))
            else:
                await websocket.send_text(json.dumps({"type": "session_expired", "message": "Session not found. Please login again."}))
                await websocket.close(); return

        loop = asyncio.get_running_loop()
        def on_message(message):
            try:
                if isinstance(message, list):
                    for tick in message:
                        if 'ltp' in tick:
                            asyncio.run_coroutine_threadsafe(websocket.send_text(json.dumps({"type": "tick", "price": float(tick['ltp'])})), loop)
            except Exception as e: print("tick error:", e)

        if client_instance:
            client_instance.on_message = on_message
            client_instance.on_error = lambda e: print("Neo WS Error:", e)
            client_instance.subscribe(instrument_tokens=[{"instrument_token": "26000", "exchange_segment": "nse_cm"}], isIndex=True)

        while True:
            try:
                msg = await asyncio.wait_for(websocket.receive_text(), timeout=30)
                if msg == "ping": await websocket.send_text(json.dumps({"type": "pong"}))
            except asyncio.TimeoutError:
                await websocket.send_text(json.dumps({"type": "ping"}))
    except WebSocketDisconnect: print("Frontend disconnected.")
    except Exception as e: print(f"WS Error: {e}")

# 9. Neo Debug
@app.get("/api/neo-debug")
def neo_debug():
    client = neo_fetcher.get_client()
    if not client:
        return {"status": "No active Neo session", "sessions": list(neo_clients.keys())}
    
    try:
        # Test basic quote
        test_tokens = [{"instrument_token": "26000", "exchange_segment": "nse_cm"}]
        resp = client.quotes(instrument_tokens=test_tokens, quote_type="LTP")
        return {
            "status": "Connected",
            "active_session": True,
            "test_quote": resp,
            "available_sessions": list(neo_clients.keys())
        }
    except Exception as e:
        return {"status": "Connected but erroring", "error": str(e)}

# ══════════════════════════════════════════════════════════════════════════════
# ADMIN ENDPOINTS
# ══════════════════════════════════════════════════════════════════════════════

@app.post("/api/admin/login")
async def admin_login(req: AdminLoginRequest):
    stored_hash = get_env_val("ADMIN_PASSWORD_HASH")
    if not stored_hash:
        # First time setup — accept default password 'admin1234' or set one
        default_hash = hash_password("admin1234")
        set_env_val("ADMIN_PASSWORD_HASH", default_hash)
        stored_hash = default_hash
    if hash_password(req.password) != stored_hash:
        raise HTTPException(status_code=401, detail="Invalid admin password")
    token = secrets.token_hex(32)
    admin_tokens[token] = time.time() + 86400  # 24h
    return {"token": token, "message": "Admin login successful"}

@app.get("/api/admin/status")
async def admin_status(authorization: Optional[str] = Header(None)):
    verify_admin_token(authorization)
    sessions_list = list(neo_clients.keys())
    # Get extra info from sessions file
    base_url = "—"
    dc = "—"
    try:
        if SESSION_FILE.exists():
            sdata = json.loads(SESSION_FILE.read_text(encoding='utf-8'))
            if sdata:
                first = list(sdata.values())[0]
                base_url = first.get("base_url", "—")
                dc = first.get("data_center", "—")
    except: pass
    return {
        "sessions_count": len(sessions_list),
        "session_ids": sessions_list,
        "base_url": base_url,
        "data_center": dc,
        "consumer_key": os.getenv("KOTAK_CONSUMER_KEY", ""),
    }

@app.post("/api/admin/kill-session")
async def admin_kill_session(authorization: Optional[str] = Header(None)):
    verify_admin_token(authorization)
    count = len(neo_clients)
    neo_clients.clear()
    # Clear sessions file
    try:
        if SESSION_FILE.exists():
            SESSION_FILE.write_text('{}', encoding='utf-8')
    except: pass
    return {"message": f"Cleared {count} session(s) successfully"}

@app.get("/api/admin/config")
async def admin_get_config(authorization: Optional[str] = Header(None)):
    verify_admin_token(authorization)
    return {
        "consumer_key": os.getenv("KOTAK_CONSUMER_KEY", ""),
        "consumer_secret": "*" * 8 if os.getenv("KOTAK_CONSUMER_SECRET") else "",
    }

@app.post("/api/admin/config")
async def admin_save_config(req: AdminConfigRequest, authorization: Optional[str] = Header(None)):
    verify_admin_token(authorization)
    set_env_val("KOTAK_CONSUMER_KEY", req.consumer_key)
    if req.consumer_secret and req.consumer_secret != "*" * 8:
        set_env_val("KOTAK_CONSUMER_SECRET", req.consumer_secret)
    # Reload env
    load_dotenv(override=True)
    os.environ["KOTAK_CONSUMER_KEY"] = req.consumer_key
    return {"message": "Config saved. New keys will be used on next login."}

@app.post("/api/admin/change-password")
async def admin_change_password(req: AdminPasswordRequest, authorization: Optional[str] = Header(None)):
    verify_admin_token(authorization)
    if len(req.new_password) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters")
    set_env_val("ADMIN_PASSWORD_HASH", hash_password(req.new_password))
    # Invalidate all admin tokens
    admin_tokens.clear()
    return {"message": "Password updated. Please log in again."}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=3000, ws="wsproto")

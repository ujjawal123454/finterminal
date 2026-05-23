# ── Python 3.11 slim ──────────────────────────────────────────────────────────
FROM python:3.11-slim

WORKDIR /app

# System deps for curl_cffi, lxml, git
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    libcurl4-openssl-dev \
    libssl-dev \
    git \
    && rm -rf /var/lib/apt/lists/*

# ── Step 1: Install all well-behaved packages ─────────────────────────────────
RUN pip install --no-cache-dir \
    fastapi \
    "uvicorn>=0.20.0" \
    wsproto \
    "websockets>=10.4,<14" \
    python-dotenv \
    "pandas>=2.0.0" \
    lxml \
    curl_cffi \
    beautifulsoup4 \
    "requests>=2.28.0" \
    "urllib3>=1.26,<2" \
    "websocket-client==1.8.0" \
    "bidict==0.22.1" \
    "PyJWT==2.6.0" \
    "pyjsparser==2.7.1" \
    "python-dateutil>=2.8.2" \
    "six==1.16.0" \
    yfinance

# ── Step 2: Install neo_api_client WITHOUT deps (avoids all conflicts) ────────
RUN pip install --no-cache-dir --no-deps \
    "git+https://github.com/Kotak-Neo/Kotak-neo-api-v2.git@v2.0.1#egg=neo_api_client"

# ── Copy app ──────────────────────────────────────────────────────────────────
COPY . .

# ── Run (Render sets $PORT automatically) ────────────────────────────────────
WORKDIR /app/backend
CMD ["sh", "-c", "uvicorn server:app --host 0.0.0.0 --port $PORT"]

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

# Cache-bust: 2026-05-23-v5
# ── Step 1: Core framework ────────────────────────────────────────────────────
RUN pip install --no-cache-dir \
    "fastapi==0.115.0" \
    "uvicorn==0.30.6" \
    "wsproto==1.2.0" \
    "starlette==0.41.0"

# ── Step 2: websockets pinned to last version with .legacy submodule ──────────
RUN pip install --no-cache-dir "websockets==12.0"

# ── Step 3: Data & HTTP packages ─────────────────────────────────────────────
RUN pip install --no-cache-dir \
    "python-dotenv==1.0.0" \
    "pandas==2.2.3" \
    "lxml==5.3.0" \
    "beautifulsoup4==4.12.3" \
    "requests==2.32.3" \
    "urllib3==1.26.14" \
    "yfinance==0.2.54" \
    "curl_cffi==0.7.4"

# ── Step 4: neo_api_client hard-deps (installed manually to avoid conflicts) ──
RUN pip install --no-cache-dir \
    "websocket-client==1.8.0" \
    "bidict==0.22.1" \
    "PyJWT==2.6.0" \
    "pyjsparser==2.7.1" \
    "python-dateutil==2.8.2" \
    "six==1.16.0"

# ── Step 5: neo_api_client WITHOUT its broken dep list ───────────────────────
RUN pip install --no-cache-dir --no-deps \
    "git+https://github.com/Kotak-Neo/Kotak-neo-api-v2.git@v2.0.1#egg=neo_api_client"

# ── Verify websockets.legacy is importable ────────────────────────────────────
RUN python -c "from websockets.legacy import client; print('websockets.legacy OK')"

# ── Copy app ──────────────────────────────────────────────────────────────────
COPY . .

# ── Run ───────────────────────────────────────────────────────────────────────
WORKDIR /app/backend
CMD ["sh", "-c", "uvicorn server:app --host 0.0.0.0 --port $PORT"]

#!/usr/bin/env bash
set -e

echo "==> Step 1: Upgrade pip..."
pip install --upgrade pip

echo "==> Step 2: Core framework (no compiled packages pinned)..."
pip install --no-cache-dir \
    "fastapi" \
    "uvicorn==0.30.6" \
    "wsproto==1.2.0" \
    "aiofiles==23.2.1" \
    "python-dotenv==1.0.0"

echo "==> Step 3: websockets pinned to last version WITH .legacy module..."
pip install --no-cache-dir "websockets==12.0"

echo "==> Step 4: HTTP & Data packages..."
pip install --no-cache-dir \
    "requests==2.32.3" \
    "urllib3==1.26.14" \
    "certifi" \
    "idna" \
    "charset-normalizer" \
    "beautifulsoup4" \
    "lxml" \
    "yfinance" \
    "pandas" \
    "numpy" \
    "pytz" \
    "python-dateutil" \
    "six==1.16.0" \
    "multitasking" \
    "frozendict" \
    "curl_cffi" \
    "platformdirs"

echo "==> Step 5: neo_api_client hard-deps (no websockets - already installed)..."
pip install --no-cache-dir \
    "websocket-client==1.8.0" \
    "bidict==0.22.1" \
    "PyJWT==2.6.0" \
    "pyjsparser==2.7.1" \
    "peewee"

echo "==> Step 6: neo_api_client --no-deps (skips websockets==8.1 + asyncio==3.4.3)..."
pip install --no-cache-dir --no-deps \
    "git+https://github.com/Kotak-Neo/Kotak-neo-api-v2.git@v2.0.1#egg=neo_api_client"

echo "==> Step 7: Verify critical imports work..."
python -c "
import fastapi, uvicorn, pandas, requests
from websockets.legacy import client
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
print('ALL IMPORTS OK!')
"

echo "==> Build complete!"

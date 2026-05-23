#!/usr/bin/env bash
set -e

echo "==> Step 1: Core framework (pinned, stable versions)..."
pip install --no-cache-dir \
    "fastapi==0.115.5" \
    "starlette==0.41.3" \
    "uvicorn==0.30.6" \
    "wsproto==1.2.0" \
    "aiofiles==23.2.1" \
    "anyio==4.4.0" \
    "h11==0.14.0" \
    "click==8.1.7" \
    "pydantic==2.9.2" \
    "pydantic-core==2.23.4" \
    "typing-extensions==4.12.2"

echo "==> Step 2: websockets pinned to last version WITH .legacy module..."
pip install --no-cache-dir "websockets==12.0"

echo "==> Step 3: Data & HTTP packages..."
pip install --no-cache-dir \
    "python-dotenv==1.0.0" \
    "pandas==2.2.3" \
    "numpy==1.26.4" \
    "lxml==5.3.0" \
    "beautifulsoup4==4.12.3" \
    "requests==2.32.3" \
    "urllib3==1.26.14" \
    "certifi==2024.8.30" \
    "idna==3.10" \
    "charset-normalizer==3.4.0" \
    "yfinance==0.2.54" \
    "curl_cffi==0.7.4" \
    "multitasking==0.0.11" \
    "frozendict==2.4.4" \
    "pytz==2024.2" \
    "python-dateutil==2.9.0" \
    "six==1.16.0" \
    "platformdirs==4.3.6"

echo "==> Step 4: neo_api_client hard-deps (manually to skip conflicts)..."
pip install --no-cache-dir \
    "websocket-client==1.8.0" \
    "bidict==0.22.1" \
    "PyJWT==2.6.0" \
    "pyjsparser==2.7.1" \
    "peewee==3.17.6"

echo "==> Step 5: neo_api_client --no-deps (avoids websockets==8.1 + asyncio conflicts)..."
pip install --no-cache-dir --no-deps \
    "git+https://github.com/Kotak-Neo/Kotak-neo-api-v2.git@v2.0.1#egg=neo_api_client"

echo "==> Step 6: Verify critical imports..."
python -c "
from websockets.legacy import client
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
print('All imports OK!')
"

echo "==> Build complete!"

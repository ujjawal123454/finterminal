#!/usr/bin/env bash
set -e

echo "==> Installing core packages..."
pip install --no-cache-dir \
    "fastapi==0.115.0" \
    "uvicorn==0.30.6" \
    "wsproto==1.2.0" \
    "starlette==0.41.0" \
    "python-dotenv==1.0.0" \
    "pandas==2.2.3" \
    "lxml==5.3.0" \
    "beautifulsoup4==4.12.3" \
    "requests==2.32.3" \
    "urllib3==1.26.14" \
    "yfinance==0.2.54" \
    "curl_cffi==0.7.4" \
    "websocket-client==1.8.0" \
    "bidict==0.22.1" \
    "PyJWT==2.6.0" \
    "pyjsparser==2.7.1" \
    "python-dateutil==2.8.2" \
    "six==1.16.0"

echo "==> Installing websockets==12.0 (has legacy submodule)..."
pip install --no-cache-dir "websockets==12.0"

echo "==> Installing neo_api_client WITHOUT deps..."
pip install --no-cache-dir --no-deps \
    "git+https://github.com/Kotak-Neo/Kotak-neo-api-v2.git@v2.0.1#egg=neo_api_client"

echo "==> Verifying websockets.legacy..."
python -c "from websockets.legacy import client; print('OK: websockets.legacy works')"

echo "==> Build complete!"

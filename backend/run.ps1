$env:PATH += ";C:\Program Files\Git\cmd;C:\Users\asus\AppData\Local\Programs\Python\Python311"
$env:PYTHONUTF8 = "1"
$env:PYTHONIOENCODING = "utf-8"
$python = "C:\Users\asus\AppData\Local\Programs\Python\Python311\python.exe"

# Only install dependencies if not already installed (check for fastapi)
$installed = & $python -c "import fastapi; print('ok')" 2>&1
if ($installed -ne 'ok') {
    Write-Host "Installing dependencies..."
    & $python -m pip install -r requirements.txt
} else {
    Write-Host "Dependencies already installed. Skipping pip install."
}

Write-Host "Starting Kotak Neo Backend Server on port 3000..."
& $python server.py

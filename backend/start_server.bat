@echo off
echo ==========================================
echo Starting Kotak Neo Python Backend Setup...
echo ==========================================

REM Check if python is installed
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo Python is not installed or not in your PATH!
    echo Please wait for the winget installation to finish, or restart this window.
    pause
    exit /b 1
)

echo.
echo Installing requirements via pip...
pip install -r requirements.txt

echo.
echo Starting FastAPI Server...
python server.py

pause

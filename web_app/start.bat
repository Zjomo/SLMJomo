@echo off
chcp 65001 >nul
echo.
echo ========================================
echo Fresnel Lens Phase Diagram Generation System - Startup Script
echo ========================================
echo.

cd /d "%~dp0"

echo [1/2] Check dependencies...
pip install -r requirements.txt --quiet

echo [2/2] Start the Web server...
echo.
echo Server started!
 Access in your browser at: http://127.0.0.1:5000
echo Press Ctrl+C to stop the server
echo.

python app.py

pause
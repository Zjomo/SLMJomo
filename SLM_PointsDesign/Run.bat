@echo off
title Double Ring Spot Generator - SLM_PointsDesign
cd /d "%~dp0"

rem ============ 1. Check Python environment ============
python --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python not found. Please install Python and check "Add Python to PATH".
    pause
    exit /b 1
)

rem ============ 2. Check and auto-install third-party dependencies ============
python -c "import numpy" >nul 2>&1
if errorlevel 1 call :install numpy
python -c "import PIL" >nul 2>&1
if errorlevel 1 call :install Pillow

rem Re-verify dependencies
python -c "import numpy, PIL" >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Dependency installation failed. Please run manually: python -m pip install numpy Pillow
    pause
    exit /b 1
)

rem ============ 3. Start main program ============
echo [INFO] Environment ready. Starting...
python double_ring_app.py
if errorlevel 1 (
    echo.
    echo [ERROR] Program exited unexpectedly. Please report the error above.
    pause
)
exit /b 0

:install
echo [INFO] Missing %1. Installing...
python -m pip install %1
if errorlevel 1 (
    echo [INFO] Default index failed. Trying Tsinghua mirror...
    python -m pip install %1 -i https://pypi.tuna.tsinghua.edu.cn/simple
)
goto :eof

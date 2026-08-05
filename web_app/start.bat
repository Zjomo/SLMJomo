@echo off
chcp 65001 >nul
echo.
echo ========================================
echo 菲涅尔透镜相位图生成系统 - 启动脚本
echo ========================================
echo.

cd /d "%~dp0"

echo [1/2] 检查依赖...
pip install -r requirements.txt --quiet

echo [2/2] 启动Web服务器...
echo.
echo 服务已启动！
echo 请在浏览器中访问: http://127.0.0.1:5000
echo 按 Ctrl+C 停止服务器
echo.

python app.py

pause
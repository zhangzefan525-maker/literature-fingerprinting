@echo off
:: 设置当前目录为脚本所在目录，防止路径错误
cd /d "%~dp0"

echo ================================================
echo Starting Literature Fingerprinting Visualizer...
echo ================================================
echo.

:: 检查是否安装了依赖 (可选，为了保险起见)
:: pip install -r requirements.txt

:: 启动 Streamlit
:: 使用 8502 端口以避免之前的端口占用报错
echo Opening browser...
streamlit run app.py --server.port 9999

:: 如果程序意外退出，暂停显示报错信息，而不是直接闪退
pause

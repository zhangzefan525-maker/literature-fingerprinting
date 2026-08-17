@echo off
:: 设置当前目录为脚本所在目录，防止路径错误
cd /d "%~dp0"

echo ================================================
echo   文印 - 文学指纹交互分析系统
echo ================================================
echo.

:: 首次运行时若演示数据缺失，则自动生成
if not exist "data\processed\all_books.json" (
    echo [1/2] 首次运行：正在生成 4 本示例书籍的指纹数据（约 1-2 分钟）...
    python generate_data.py
) else (
    echo [1/2] 示例数据已就绪，跳过生成。
)

echo.
echo [2/2] 启动 API 服务器...
echo 浏览器将自动打开 http://localhost:5000/visualization
echo.

:: 打开浏览器（服务器启动后如未自动跳转，请手动刷新一次）
start "" http://localhost:5000/visualization

:: 前台运行 Flask 服务器，按 Ctrl+C 停止
python api_server.py

:: 如果程序意外退出，暂停显示报错信息，而不是直接闪退
pause

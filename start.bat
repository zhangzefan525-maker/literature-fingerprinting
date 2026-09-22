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
echo 服务就绪后会自动打开 http://localhost:5000/visualization
echo 若浏览器没有自动打开，请手动访问上面这个地址。
echo.

:: 先起一个后台助手轮询端口，通了再打开浏览器。
:: 原来这一行写在 python api_server.py 之前，首次打开必然撞 ERR_CONNECTION_REFUSED，
:: 看起来就像程序没启动成功。最多等 60 秒（按墙上时钟算，不是按次数——连不上的时候
:: 一次尝试要 2 秒多，按次数写会拖到好几分钟），超时也照开（用户至少能看到浏览器的
:: 报错，而不是「什么都没发生」）。服务器本身仍然在前台运行，Ctrl+C 照常能停。
start "" /b powershell -NoProfile -Command "$u='http://127.0.0.1:5000/api/books'; $deadline=(Get-Date).AddSeconds(60); while((Get-Date) -lt $deadline){ try{ Invoke-WebRequest -UseBasicParsing -Uri $u -TimeoutSec 2 | Out-Null; break } catch { Start-Sleep -Milliseconds 500 } }; Start-Process 'http://localhost:5000/visualization'"

:: 前台运行 Flask 服务器，按 Ctrl+C 停止
python api_server.py

:: 如果程序意外退出，暂停显示报错信息，而不是直接闪退
pause

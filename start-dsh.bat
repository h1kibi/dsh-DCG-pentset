@echo off
REM dsh-pentest 一键启动脚本（Windows）

setlocal enabledelayedexpansion

echo ╔════════════════════════════════════════════════════════════════╗
echo ║  dsh-pentest 启动脚本                                         ║
echo ╚════════════════════════════════════════════════════════════════╝
echo.

REM 配置
set PROJECT_DIR=C:\Projects\Agent-projects\dsh-DCG-pentest
set DSH_PROFILE=pentest
set PORT=3090
set LOG_FILE=%TEMP%\dsh-pentest-%RANDOM%.log

echo 📋 配置信息:
echo   项目目录: %PROJECT_DIR%
echo   Profile: %DSH_PROFILE%
echo   端口: %PORT%
echo   日志: %LOG_FILE%
echo.

REM 检查先决条件
echo 🔍 检查先决条件...

where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo ❌ Node.js 未安装
    exit /b 1
)
for /f "tokens=*" %%i in ('node --version') do set NODE_VER=%%i
echo   ✓ Node.js %NODE_VER%

where docker >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo ❌ Docker 未安装
    exit /b 1
)
echo   ✓ Docker 已安装

docker network ls | findstr pentest-lab-internal >nul
if %ERRORLEVEL% NEQ 0 (
    echo ❌ Docker 网络 pentest-lab-internal 不存在
    exit /b 1
)
echo   ✓ Docker 网络 pentest-lab-internal 就绪

REM 检查 PostgreSQL
docker ps | findstr pentest-db-full >nul
if %ERRORLEVEL% NEQ 0 (
    echo ⚠️  PostgreSQL 容器未运行，正在启动...
    docker start pentest-db-full
    timeout /t 5 /nobreak
)
echo   ✓ PostgreSQL 运行中

REM 清理旧进程
echo.
echo 🧹 清理旧进程...
taskkill /F /IM node.exe /FI "WINDOWTITLE eq dsh*" 2>nul || echo   (无旧进程)
timeout /t 2 /nobreak
echo   ✓ 旧进程已清理

REM 启动 dsh-pentest
echo.
echo 🚀 启动 dsh-pentest...
cd /d "%PROJECT_DIR%"

REM 后台启动
start "dsh-pentest" /B cmd /c "set DSH_PROFILE=%DSH_PROFILE% && node start-personal.mjs > %LOG_FILE% 2>&1"
echo   进程已启动

REM 等待启动
echo.
echo ⏳ 等待服务启动（最多 120 秒）...
set /a count=0
:wait_loop
timeout /t 1 /nobreak >nul
findstr /M "http://" "%LOG_FILE%" >nul 2>&1
if %ERRORLEVEL% EQU 0 goto startup_success

set /a count+=1
if %count% GTR 120 goto startup_failed

echo -n "."
goto wait_loop

:startup_success
echo.
echo.
echo ╔════════════════════════════════════════════════════════════════╗
echo ║  ✅ dsh-pentest 已启动！                                      ║
echo ╚════════════════════════════════════════════════════════════════╝
echo.
echo 🌐 访问地址：
echo.

REM 提取 URL
for /f "delims=" %%i in ('findstr /R "http://" "%LOG_FILE%"') do (
    set "LAST_LINE=%%i"
)
set "URL=%LAST_LINE:*http://=http://%"
set "URL=%URL: =%"

echo    %URL%
echo.
echo 📋 说明：
echo    1. 复制上面的地址到浏览器
echo    2. 创建新作业
echo    3. 选择五个阶段中的一个
echo    4. 启动 Worker Agent
echo    5. 做人工决策
echo.
echo 📚 文档：
echo    • QUICK-REFERENCE.md              快速参考（打印版）
echo    • DEEP-DIVE-SKILLS-STATE-MACHINE.md  完整剖析
echo    • IMPLEMENTATION-GUIDE.md         实操指南
echo    • DOCS-INDEX.md                   文档导航
echo.
echo 🛑 停止服务：
echo    taskkill /F /IM node.exe
echo.
echo 📖 查看日志：
echo    type %LOG_FILE%
echo.
pause
exit /b 0

:startup_failed
echo.
echo ❌ 启动失败
echo.
echo 📖 错误日志：
type "%LOG_FILE%" | tail -50
pause
exit /b 1

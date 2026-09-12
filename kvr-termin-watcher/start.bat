@echo off
setlocal
cd /d "%~dp0"
title KVR Termin Watcher

echo === KVR Termin Watcher ===
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js khong duoc tim thay. Hay cai Node.js 20 LTS tu https://nodejs.org roi chay lai.
  pause
  exit /b 1
)
for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node"') do set NODE_MAJOR=%%v
if %NODE_MAJOR% LSS 20 (
  echo [ERROR] Can Node.js 20 tro len. Phien ban hien tai:
  node -v
  pause
  exit /b 1
)

if not exist config.json (
  copy config.example.json config.json >nul
  echo [INFO] Da tao config.json tu config.example.json.
  echo        Mo config.json de dien Telegram botToken / chatId neu muon nhan tin nhan, roi chay lai start.bat.
  pause
  exit /b 0
)

if not exist node_modules (
  echo [INFO] Dang cai thu vien npm ^(chi lan dau^)...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo [ERROR] npm install that bai.
    pause
    exit /b 1
  )
)

set "PW_DIR=%LOCALAPPDATA%\ms-playwright"
if defined PLAYWRIGHT_BROWSERS_PATH set "PW_DIR=%PLAYWRIGHT_BROWSERS_PATH%"
dir /b "%PW_DIR%\chromium-*" >nul 2>&1
if errorlevel 1 (
  echo [INFO] Dang tai Chromium cho Playwright ^(chi lan dau, ~150 MB^)...
  call npx playwright install chromium
  if errorlevel 1 (
    echo [ERROR] Khong tai duoc Chromium.
    pause
    exit /b 1
  )
)

if not exist alert.wav (
  echo [INFO] Dang tao alert.wav...
  node scripts\gen-alert.js
)

echo [INFO] Dang build...
call npm run build --silent
if errorlevel 1 (
  echo [ERROR] Build that bai.
  pause
  exit /b 1
)

echo.
echo [INFO] Khoi dong watcher. Nhan Ctrl+C de dung.
echo.
node dist\src\index.js
set EXIT=%ERRORLEVEL%
echo.
if not "%EXIT%"=="0" echo [INFO] Watcher da thoat voi ma %EXIT%.
pause
exit /b %EXIT%

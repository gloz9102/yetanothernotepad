@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul

cd /d "%~dp0"
set "PROJECT_DIR=%~dp0"
set "REQUIRED_NODE=24"
set "BUILD_EXIT=1"

if exist ".nvmrc" set /p REQUIRED_NODE=<".nvmrc"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js !REQUIRED_NODE!가 없음. Node.js 24 LTS를 먼저 설치해야 함.
  goto build_failed
)

for /f "tokens=1 delims=." %%V in ('node --version') do set "NODE_MAJOR=%%V"
if not "!NODE_MAJOR!"=="v!REQUIRED_NODE!" (
  echo Node.js !REQUIRED_NODE!가 필요함. 현재 버전:
  node --version
  echo nvm-windows를 사용한다면 설치된 정확한 24.x.x 버전으로 먼저 전환해야 함.
  goto build_failed
)

where corepack >nul 2>nul
if errorlevel 1 (
  echo corepack이 없음. Node.js !REQUIRED_NODE! 설치 상태를 확인해야 함.
  goto build_failed
)

where cargo >nul 2>nul
if errorlevel 1 (
  echo Rust가 없음. https://rustup.rs 에서 먼저 설치해야 함.
  goto build_failed
)

echo 의존성 설치 중...
call corepack pnpm install --frozen-lockfile
if errorlevel 1 goto build_failed

echo.
echo Windows NSIS 설치 파일 빌드 중...
call corepack pnpm tauri build --bundles nsis
if errorlevel 1 goto build_failed

set "BUILD_EXIT=0"
set "OUTPUT_DIR=%PROJECT_DIR%src-tauri\target\release\bundle\nsis"
echo.
echo 빌드 완료: !OUTPUT_DIR!
if exist "!OUTPUT_DIR!" start "" explorer "!OUTPUT_DIR!"
goto finish

:build_failed
echo.
echo 빌드 실패. 위 오류를 확인해야 함.

:finish
echo.
pause
exit /b !BUILD_EXIT!

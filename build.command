#!/bin/zsh

set -euo pipefail

PROJECT_DIR="${0:A:h}"
cd "$PROJECT_DIR"

# Finder에서 실행해도 nvm과 Rust가 잡히도록 기본 환경을 불러온다.
if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  source "$NVM_DIR/nvm.sh"
fi

if [[ -s "$HOME/.cargo/env" ]]; then
  source "$HOME/.cargo/env"
fi

pause() {
  echo
  read -k 1 "?아무 키나 누르면 창이 닫힘..."
  echo
}

trap 'status=$?; echo; if (( status == 0 )); then echo "빌드 완료: $PROJECT_DIR/src-tauri/target/release/bundle"; else echo "빌드 실패 (종료 코드: $status)"; fi; pause' EXIT

command -v node >/dev/null 2>&1 || {
  echo "Node.js가 없음. Node.js 24를 먼저 설치해야 함."
  exit 1
}

if command -v nvm >/dev/null 2>&1; then
  nvm use
fi

NODE_MAJOR="$(node --version | sed -E 's/^v([0-9]+).*/\1/')"
if [[ "$NODE_MAJOR" != "24" ]]; then
  echo "Node.js 24가 필요함. 현재 버전: $(node --version)"
  exit 1
fi

command -v corepack >/dev/null 2>&1 || {
  echo "corepack이 없음. Node.js 24 설치 상태를 확인해야 함."
  exit 1
}

command -v cargo >/dev/null 2>&1 || {
  echo "Rust가 없음. https://rustup.rs 에서 먼저 설치해야 함."
  exit 1
}

echo "의존성 설치 중..."
corepack pnpm install --frozen-lockfile

echo
echo "앱 설치 파일 빌드 중..."
corepack pnpm tauri build

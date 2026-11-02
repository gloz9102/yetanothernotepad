#!/bin/zsh

set -eo pipefail

PROJECT_DIR="${0:A:h}"
WINDOWS_TARGET="x86_64-pc-windows-msvc"
OUTPUT_DIR="$PROJECT_DIR/src-tauri/target/$WINDOWS_TARGET/release/bundle/nsis"
cd "$PROJECT_DIR"

# Finder에서 실행해도 nvm과 Rust가 잡히도록 기본 환경을 불러온다.
if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  source "$NVM_DIR/nvm.sh"
fi

if [[ -s "$HOME/.cargo/env" ]]; then
  source "$HOME/.cargo/env"
fi

add_llvm_to_path() {
  local llvm_prefix=""

  if command -v brew >/dev/null 2>&1; then
    llvm_prefix="$(brew --prefix llvm 2>/dev/null || true)"
  fi

  if [[ -n "$llvm_prefix" && -d "$llvm_prefix/bin" ]]; then
    export PATH="$llvm_prefix/bin:$PATH"
  fi
}

pause() {
  if [[ -t 0 ]]; then
    echo
    read -k 1 "?아무 키나 누르면 창이 닫힘..."
    echo
  fi
}

finish() {
  local exit_code=$?

  echo
  if (( exit_code == 0 )); then
    echo "Windows EXE 빌드 완료: $OUTPUT_DIR"
    open "$OUTPUT_DIR" >/dev/null 2>&1 || true
  else
    echo "Windows EXE 빌드 실패 (종료 코드: $exit_code)"
  fi

  pause
}

trap finish EXIT
set -u

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "이 스크립트는 macOS 전용임."
  exit 1
fi

command -v node >/dev/null 2>&1 || {
  echo "Node.js가 없음. Node.js 24를 먼저 설치해야 함."
  exit 1
}

if command -v nvm >/dev/null 2>&1; then
  if ! nvm use; then
    echo "Node.js 24가 설치되지 않았다면 'nvm install 24'를 먼저 실행해야 함."
    exit 1
  fi
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

command -v rustup >/dev/null 2>&1 || {
  echo "rustup이 없음. https://rustup.rs 에서 먼저 설치해야 함."
  exit 1
}

command -v brew >/dev/null 2>&1 || {
  echo "Homebrew가 없음. https://brew.sh 에서 먼저 설치해야 함."
  exit 1
}

add_llvm_to_path

BREW_PACKAGES=()
command -v makensis >/dev/null 2>&1 || BREW_PACKAGES+=(nsis)
command -v llvm-rc >/dev/null 2>&1 || BREW_PACKAGES+=(llvm)

NEED_WINDOWS_TARGET=0
rustup target list --installed | grep -qx "$WINDOWS_TARGET" || NEED_WINDOWS_TARGET=1

NEED_CARGO_XWIN=0
command -v cargo-xwin >/dev/null 2>&1 || NEED_CARGO_XWIN=1

if (( ${#BREW_PACKAGES[@]} > 0 || NEED_WINDOWS_TARGET || NEED_CARGO_XWIN )); then
  echo "Windows 교차 빌드 도구가 더 필요함:"
  (( ${#BREW_PACKAGES[@]} > 0 )) && echo "  brew install ${BREW_PACKAGES[*]}"
  (( NEED_WINDOWS_TARGET )) && echo "  rustup target add $WINDOWS_TARGET"
  (( NEED_CARGO_XWIN )) && echo "  cargo install --locked cargo-xwin"
  echo
  read "answer?지금 자동 설치하고 계속할까? [y/N] "

  if [[ "$answer" != [yY] ]]; then
    echo "설치 취소함."
    exit 1
  fi

  if (( ${#BREW_PACKAGES[@]} > 0 )); then
    brew install "${BREW_PACKAGES[@]}"
  fi

  if (( NEED_WINDOWS_TARGET )); then
    rustup target add "$WINDOWS_TARGET"
  fi

  if (( NEED_CARGO_XWIN )); then
    cargo install --locked cargo-xwin
  fi

  add_llvm_to_path
fi

command -v makensis >/dev/null 2>&1 || {
  echo "NSIS 설치 확인 실패: makensis를 찾을 수 없음."
  exit 1
}

command -v llvm-rc >/dev/null 2>&1 || {
  echo "LLVM 설치 확인 실패: llvm-rc를 찾을 수 없음."
  exit 1
}

command -v cargo-xwin >/dev/null 2>&1 || {
  echo "cargo-xwin 설치 확인 실패."
  exit 1
}

rustup target list --installed | grep -qx "$WINDOWS_TARGET" || {
  echo "Windows Rust target 설치 확인 실패: $WINDOWS_TARGET"
  exit 1
}

echo "의존성 설치 중..."
corepack pnpm install --frozen-lockfile

echo
echo "Windows x64 NSIS 설치 파일 교차 빌드 중..."
corepack pnpm tauri build \
  --runner cargo-xwin \
  --target "$WINDOWS_TARGET" \
  --bundles nsis

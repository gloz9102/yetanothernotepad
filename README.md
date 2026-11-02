# Yet Another Notepad

로컬 파일을 원본으로 사용하는 작고 빠른 Windows/macOS 텍스트·Markdown 편집기입니다. 계정이나 클라우드 없이 `.txt`, `.md`, `.markdown` 파일을 탭으로 열고 Markdown 원문과 리치뷰를 함께 볼 수 있습니다.

## MVP 기능

- `.txt` 원문 편집과 Markdown 원문/분할/리치뷰
- 저장 전 새 문서의 `TXT ↔ Markdown` 전환과 Markdown 분할 미리보기
- CodeMirror 기반 Undo/Redo, 찾기·바꾸기, 줄바꿈, 키보드 및 한글 IME 입력
- GFM 제목, 강조, 목록, 체크리스트, 표, 인용, 코드, 링크와 안전한 상대 이미지
- 중복 파일 탭 방지, dirty 표시, revision 충돌 검사와 같은 볼륨 내 파일 교체 저장
- UTF-8, UTF-8 BOM, UTF-16 LE/BE, CP949 및 LF/CRLF 보존
- 문서별 1초 지연·연속 입력 시 최대 5초 간격 복구본과 비정상 종료 복구
- 이벤트 기반 외부 파일 변경 감지와 안전한 다시 읽기/덮어쓰기 확인
- 드래그 앤 드롭 열기, 네이티브 File/Edit/View 메뉴, 키보드 탭 전환
- 시스템/라이트/다크 테마와 한국어/영어
- Windows 11 x64 NSIS, macOS 13+ Intel/Apple Silicon DMG

Raw HTML, Mermaid, 수식, 원격 이미지는 렌더링하지 않습니다. Markdown 리치뷰는 512 KiB까지 자동 갱신하고 512 KiB 초과 2 MiB 이하는 수동 갱신합니다. 2 MiB를 넘으면 원문 편집만 제공하며 문서와 로컬 이미지의 최대 크기는 각각 10 MiB입니다.

새 문서는 기본 TXT로 시작합니다. 저장하기 전에는 툴바의 `TXT | Markdown`으로 형식을 바꿀 수 있으며, Markdown으로 전환하면 내용과 Undo history를 유지한 채 분할 미리보기가 열립니다. 저장된 파일은 실제 확장자를 문서 형식으로 사용하므로 형식 전환이 표시되지 않습니다.

## 개발 환경

- Node.js 24 LTS
- pnpm 10.19
- 최신 stable Rust
- [Tauri 2 플랫폼 필수 구성 요소](https://v2.tauri.app/start/prerequisites/)

```bash
pnpm install --frozen-lockfile
pnpm tauri dev
```

`.nvmrc`가 Node 24를 지정합니다. 현재 셸의 Node 버전은 `node --version`으로 확인할 수 있습니다.

macOS에서는 Finder에서 `build.command`를 더블클릭하면 의존성 설치와 현재 CPU용 앱 설치 파일 빌드를 한 번에 실행합니다. 결과는 `src-tauri/target/release/bundle`에 생성됩니다.

Windows에서는 `build-windows.cmd`를 더블클릭하면 의존성 설치와 NSIS `.exe` 빌드를 한 번에 실행합니다. 성공하면 `src-tauri\target\release\bundle\nsis` 폴더를 자동으로 엽니다.

macOS에서 Windows x64 NSIS `.exe`를 교차 빌드하려면 `build-windows-on-mac.command`를 더블클릭합니다. 필요한 NSIS, LLVM, Windows Rust target, cargo-xwin이 없으면 설치 항목을 보여주고 동의를 받은 뒤 설치합니다. 결과는 `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis`에 생성됩니다. 이 교차 빌드는 Windows 네이티브 빌드나 CI보다 덜 검증된 방식입니다.

## 자주 쓰는 단축키

| 동작               | Windows                       | macOS                                                        |
| ------------------ | ----------------------------- | ------------------------------------------------------------ |
| 새 텍스트          | `Ctrl+N`                      | `Cmd+N`                                                      |
| 새 Markdown        | `Ctrl+Shift+N`                | `Cmd+Shift+N`                                                |
| 열기               | `Ctrl+O`                      | `Cmd+O`                                                      |
| 저장               | `Ctrl+S`                      | `Cmd+S`                                                      |
| 다른 이름으로 저장 | `Ctrl+Shift+S`                | `Cmd+Shift+S`                                                |
| 탭 닫기            | `Ctrl+W`                      | `Cmd+W`                                                      |
| 다음/이전 탭       | `Ctrl+Tab` / `Ctrl+Shift+Tab` | `Ctrl+Tab` / `Ctrl+Shift+Tab`, `Cmd+Shift+]` / `Cmd+Shift+[` |
| 1~9번 탭           | `Ctrl+1`~`9`                  | `Cmd+1`~`9`                                                  |
| 원문/리치뷰 전환   | `Ctrl+Shift+M`                | `Cmd+Shift+M`                                                |
| 원문 보기          | `Ctrl+Alt+1`                  | `Option+Cmd+1`                                               |
| 분할 보기          | `Ctrl+Alt+2`                  | `Option+Cmd+2`                                               |
| 리치뷰 보기        | `Ctrl+Alt+3`                  | `Option+Cmd+3`                                               |
| 찾기               | `Ctrl+F`                      | `Cmd+F`                                                      |
| 바꾸기             | 찾기 패널에서 선택            | 찾기 패널에서 선택                                           |
| 설정               | `Ctrl+,`                      | `Cmd+,`                                                      |

## 검증

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build

cd src-tauri
cargo fmt --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test --all-features
```

현재 플랫폼에서 설치 파일을 만들려면 저장소 루트에서 실행합니다.

```bash
pnpm tauri build
```

GitHub Actions는 프론트엔드와 Rust 검사가 성공한 뒤 Windows x64 NSIS, macOS Intel DMG, macOS Apple Silicon DMG를 각각 workflow artifact로 업로드합니다. MVP artifact는 코드 서명과 macOS 공증이 적용되지 않았으므로 운영체제가 실행 경고를 표시할 수 있습니다.

## 개인용 설치 및 검증 상태 (2026-09-10)

- Windows: CI에서 생성한 x64 NSIS 설치 파일을 실행합니다. WebView2 런타임이 필요합니다. Windows 전용 Rust 저장 회귀 테스트를 패키징 전에 실행하도록 구성했습니다.
- macOS: CPU에 맞는 DMG를 열고 앱을 Applications로 복사합니다. Intel과 Apple Silicon 파일을 구분합니다. 서명·공증 없는 개인용 빌드이므로 Gatekeeper 경고 없이 실행된다는 보장은 없습니다.
- Node 24.13.0 / pnpm 10.19.0으로 프론트 검사와 빌드를 수행했습니다. macOS ARM64 테스트 DMG 생성 및 읽기 전용 마운트·앱 복사를 확인했습니다. Intel 실행 파일 교차 빌드도 통과했습니다.
- DMG에서 테스트 폴더로 복사한 ARM64 앱의 실행, 한글 경로 저장·디스크 내용 비교·재열기, Cmd+Q 및 창 닫기 확인, 취소·저장 후 종료·버리기 종료, 강제 종료 후 미저장 내용 복구를 확인했습니다. HTTPS 링크의 기본 브라우저 실행, 로컬 이미지 표시, 외부 변경 충돌 시 원본 보존도 확인했습니다. 한글 입력은 붙여넣기로 확인했으며 IME 조합, 파일 연결·드래그 열기, HTTP·mailto 실제 실행은 미검증입니다.
- Windows 실제 실행·NSIS 설치 및 Intel Mac 실행은 미검증입니다. Mac에서 Windows 교차 검사를 시도했지만 MSVC 도구와 llvm-rc 부재로 중단됐습니다. CI 설정 자체가 Windows 검증 성공을 의미하지 않습니다.
- 검증용 앱 식별자는 별도로 지정하며 기본 앱 식별자와 사용자 복구 경로는 유지합니다.

## 저장·종료 동작

창 닫기와 종료 메뉴는 동일한 미저장 확인을 거칩니다. 저장 취소·실패, 마지막 복구 기록 실패, 휴지통 이동 실패 시 편집으로 복귀합니다. 최종 종료 처리 중에는 편집과 추가 명령을 잠시 차단합니다.

Windows는 같은 디렉터리의 임시 파일을 flush/sync한 뒤 MoveFileExW로 교체합니다. 기존 파일의 DACL을 복사하며 원본을 먼저 다른 이름으로 옮기지 않습니다. 실패한 임시 파일은 휴지통으로 이동하고, 이동하지 못하면 오류에 위치를 남깁니다. 이 절차는 임의의 전원 장애, 네트워크 드라이브, 모든 파일시스템에 대한 무손실 보장이 아닙니다.

문서별 저장·복구 요청을 직렬화합니다. 파일 쓰기 이후 복구·감시 갱신이 실패하면 새 revision과 저장 상태를 유지하면서 별도 경고를 표시합니다. 정상 저장은 디스크 내용을 다시 읽어 확인하며, 확인 실패도 경고합니다. 마지막 성공한 복구 기록 이후의 입력은 강제 종료 시 유실될 수 있습니다.

Markdown 외부 링크는 HTTP, HTTPS, mailto만 허용하며 실행 실패는 오류 대화상자에 표시합니다. 자동 업데이트·공개 배포·유료 서명·공증은 이번 보완 범위에 포함하지 않습니다.

## 데이터 안전 원칙

- 실제 파일은 사용자가 저장할 때만 변경됩니다.
- 저장 요청에는 문서 ID, 내용, 마지막으로 본 revision만 전달합니다.
- 디스크 revision이 달라지면 원본을 덮어쓰지 않고 충돌로 처리합니다.
- 복구본은 앱 로컬 데이터 폴더에 저장하고, 정상 종료 승인 후 휴지통으로 이동합니다. 휴지통 이동 실패 시 종료를 중단합니다.
- 외부 변경은 파일 시스템 이벤트 뒤 revision을 확인하며, 다시 읽기와 강제 덮어쓰기는 사용자 확인을 거칩니다.
- 상대 이미지는 문서 폴더 안으로 확인된 경로만 Rust 계층에서 읽습니다.

## 범위 밖

Linux, 모바일, 계정, 동기화, 보관함 검색, AI, 플러그인, 자동 업데이트, 앱스토어 배포 및 WYSIWYG 직접 편집은 이 MVP에 포함하지 않습니다.

---

## English

Yet Another Notepad is a small local-first text and Markdown editor for Windows and macOS. It offers tabbed `.txt`, `.md`, and `.markdown` editing, Markdown source/split/rich views, encoding and line-ending preservation, crash recovery, safe local image rendering, and external-change conflict handling. See the Korean sections above for setup, shortcuts, verification commands, and MVP boundaries.

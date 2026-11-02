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
- 선택한 모든 줄과 줄 번호 강조(여러 커서 포함)
- 분할 뷰에서 원문 선택 줄과 리치뷰 블록의 상호 강조
- 드래그 앤 드롭 열기(일부 파일이 열리지 않아도 나머지는 열고 실패를 알림), 네이티브 File/Edit/View 메뉴, 키보드 탭·뷰 모드 전환
- 시스템/라이트/다크 테마와 한국어/영어
- Windows 11 x64 NSIS, macOS 13+ Intel/Apple Silicon DMG

Raw HTML, Mermaid, 수식, 원격 이미지는 렌더링하지 않습니다. Markdown 리치뷰는 512 KiB까지 자동 갱신하고 512 KiB 초과 2 MiB 이하는 수동 갱신합니다. 2 MiB를 넘으면 원문 편집만 제공하며 문서와 로컬 이미지의 최대 크기는 각각 10 MiB입니다.

분할 뷰에서 원문의 커서나 선택 줄에 해당하는 리치뷰 블록(문단, 제목, 목록 항목, 표 행, 코드 블록)이 강조되고, 리치뷰에서 블록을 클릭하거나 선택하면 해당 원문 줄이 강조됩니다. 강조는 블록 단위이며 리치뷰가 수동 갱신 상태(512 KiB 초과)일 때는 동작하지 않습니다. 원문 쪽 강조는 원문의 선택을 바꾸거나 편집하면 사라집니다.

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

## 설치 및 검증 상태 (2026-11-02)

- Windows: x64 NSIS 설치 파일을 실행합니다. WebView2 런타임이 필요합니다. Windows 전용 Rust 저장 회귀 테스트를 패키징 전에 실행하도록 구성했습니다.
- macOS: CPU에 맞는 DMG를 열고 앱을 Applications로 복사합니다. Intel과 Apple Silicon 파일을 구분합니다. 서명·공증 없는 빌드이므로 Gatekeeper 경고 없이 실행된다는 보장은 없습니다.
- Node 24.13.0 / pnpm 10.19.0에서 lint, 타입 검사, 프론트엔드 테스트 53개, Rust 테스트 21개, clippy와 프론트엔드 빌드가 통과했습니다.
- macOS ARM64 DMG를 빌드해 읽기 전용으로 마운트한 뒤 앱 실행을 확인했습니다.
- macOS에서 `cargo-xwin`으로 Windows x64 NSIS 설치 파일 교차 빌드에 성공했고, 실행 파일이 콘솔 창 없이 시작하는 Windows GUI 서브시스템으로 빌드된 것을 확인했습니다.
- 이전 빌드는 Windows에서 실행되었으나 콘솔 창이 함께 열렸습니다. 이를 수정한 빌드의 Windows 설치·실행, Intel Mac 실행은 미검증입니다.
- 2026-09-10에 Intel 실행 파일 교차 빌드가 통과했고, ARM64 앱으로 한글 경로 저장·재열기, 종료 확인 흐름, 강제 종료 후 복구, HTTPS 링크 실행, 로컬 이미지 표시, 외부 변경 충돌 시 원본 보존을 확인했습니다. IME 조합 입력, 파일 연결로 열기, 드래그 열기, HTTP·mailto 실제 실행은 미검증입니다.
- 이번 변경(파일 드롭 처리, 뷰 모드·탭 단축키, 줄 강조, 분할 뷰 상호 강조)은 자동화 테스트로 검증했으며 실제 앱에서의 조작 확인은 아직 하지 않았습니다.
- 저장소에 CI 설정이 있으나 원격 저장소에서 실행된 이력은 아직 없습니다.
- 검증용 앱 식별자는 별도로 지정하며 기본 앱 식별자와 사용자 복구 경로는 유지합니다.

## 알려진 제약

- 원문 편집기 안에서 선택한 텍스트를 끌어 옮기는 기능은 지원하지 않습니다. Tauri의 네이티브 파일 드롭 처리가 macOS와 Windows에서 웹뷰 내부 드래그를 가로채기 때문이며, 대신 잘라내기·붙여넣기를 사용합니다.
- 분할 뷰 상호 강조는 블록 단위입니다. 코드 블록 안의 한 줄을 선택해도 코드 블록 전체가 강조되며, 각주처럼 원문 위치가 없는 생성 요소는 강조되지 않습니다.
- `Ctrl+Alt+숫자` 뷰 모드 단축키는 AltGr를 쓰는 일부 유럽 자판 배열과 겹칠 수 있습니다.

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

Yet Another Notepad is a small local-first text and Markdown editor for Windows and macOS. It offers tabbed `.txt`, `.md`, and `.markdown` editing, Markdown source/split/rich views with keyboard shortcuts, highlighting of every selected line, block-level linked highlighting between the source and rich view in split mode, encoding and line-ending preservation, crash recovery, safe local image rendering, and external-change conflict handling. See the Korean sections above for setup, shortcuts, verification commands, and MVP boundaries.

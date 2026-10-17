# Windows lightweight shell (Tauri 2)

This shell loads the same `src/renderer/` HTML/CSS/JavaScript as the Electron
reference. `scripts/prepare-tauri.mjs` stages only `src/renderer/` and
`src/shared/`, preserving their relative paths. Browser-only synthetic `mock.js` is excluded
from production assets. Runtime HTML/CSS/JavaScript is copied byte-for-byte;
there is no renderer rewrite.

## Supported now

- Resizable ordinary desktop window; optional always-on-top.
- Window size, position, and pin preference restored on next launch.
- Validated manual/imported timetable saved as local JSON.
- Native save dialog for `.ics` calendar and `.json` timetable export.
- Explicitly confirmed local cache clearing removes only `cache.json` and its
  incomplete-write file; window preferences and exported files remain untouched.
- Google Maps / AMap HTTPS links opened by the default browser only on request.
- No ACORN session, refresh schedule, network client, background login WebView,
  startup registration, keepalive, or tray process. Closing the window exits.
  The bridge's hide action minimizes so the window remains reachable.

## Explicitly not supported yet

Native ACORN login, MFA, cookie/session transfer, live refresh, and encrypted
migration from the Electron cache are not implemented. `login` and `refresh`
return an `unsupported` status; the capability flags are both false. This is an
offline shell, not an authenticated replacement for the Electron version.

The cache is plaintext JSON in Tauri's per-user app-data directory under
`com.acornwidget.lite` (`cache.json` and `window.json`). Treat exported JSON and
local course/grade data as private. No credentials are requested or saved.
A corrupt cache is left untouched and reported rather than silently replaced.

## Build on Windows 10/11

Install Node.js, the official Rust stable MSVC toolchain, Visual Studio Build
Tools with C++ desktop development and the Windows SDK. Then, from the project
root:

```sh
npm ci
npm run tauri:dev
npm run tauri:build
```

The NSIS installer is generated below `src-tauri/target/release/bundle/nsis/`.
It uses the system WebView2 runtime. The configured bootstrapper installs
WebView2 if missing; the application does not ship a separate Chromium runtime.
Initial installation may therefore need internet access. Normal offline
calendar use does not require an application network connection.

```sh
node --test src-tauri/tests/*.test.cjs
cargo test --manifest-path src-tauri/tests/data-harness/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml --target x86_64-pc-windows-msvc
```

The bridge/offline Node tests and pure native data/cache Rust tests passed on
Linux. The small data test harness imports the production module directly and
does not need a GUI SDK. A Windows-target `cargo check` (including tests) was
also completed from Linux during implementation.
This checks Rust types, Windows-specific dependencies, Tauri config/capabilities
and resources. An additional release executable was linked from Linux for
`x86_64-pc-windows-gnu`, with `tauri/custom-protocol` enabled and the shared runtime
assets embedded. That experimental build needs its companion `WebView2Loader.dll`
and an installed system WebView2 runtime. It is not an installer or a Windows
runtime certification. The normal Windows build above remains the recommended
MSVC/NSIS path.

Windows runtime behavior, installer size, working-set memory, and idle CPU still
require measurement on a real Windows machine; no memory or CPU advantage is
claimed from framework architecture or executable size alone. Include WebView2 child processes when
measuring memory, and compare equal data, windows, and idle intervals.

Official references:
- https://v2.tauri.app/start/prerequisites/
- https://v2.tauri.app/reference/config/
- https://v2.tauri.app/develop/calling-rust/
- https://v2.tauri.app/plugin/dialog/
- https://v2.tauri.app/plugin/opener/

## Experimental Linux → Windows GNU link (no installer)

With stable Rust, Node.js, and official Debian MinGW packages installed
(`gcc-mingw-w64-x86-64-posix`, `binutils-mingw-w64-x86-64`,
`mingw-w64-x86-64-dev`, plus their package-manager dependencies):

```sh
rustup target add x86_64-pc-windows-gnu
npm ci
npm run tauri:prepare
cargo build --manifest-path src-tauri/Cargo.toml \
  --target x86_64-pc-windows-gnu --release \
  --features tauri/custom-protocol --locked
```

For a task-local toolchain, prepend its `usr/bin` directory to `PATH` and set
`CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER` to its
`x86_64-w64-mingw32-gcc` executable. No proprietary Windows SDK is needed for
this GNU link. The ordinary Tauri CLI build also enables
`tauri/custom-protocol` automatically.

Keep these two outputs together:

- `src-tauri/target/x86_64-pc-windows-gnu/release/acorn-widget-lite.exe`
- `src-tauri/target/x86_64-pc-windows-gnu/release/WebView2Loader.dll`

A supported system WebView2 runtime must already be installed to try this
unbundled candidate. This process creates no installer, code signature,
startup entry, or public release. A successful cross-link does not verify
window behavior, file dialogs, or execution on a Windows computer. Do not
confuse the combined file size with installed WebView2 size or process RAM.

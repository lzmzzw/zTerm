# zTerm

[中文](README.zh-CN.md)

zTerm is a Tauri desktop terminal application for SSH, SFTP, command history,
server monitoring, and Codex-assisted operations. It is designed for a dense,
keyboard-friendly workstation layout: sessions on the left, split terminal
panes in the center, and files/history/monitor/Codex tools on the right.

![zTerm workbench](assets/screenshots/workbench.png)

## Features

- Save, search, group, and open SSH/RDP/local terminal sessions plus FTP/SFTP file-transfer sessions.
- Run SSH sessions through the system OpenSSH client and render them with xterm.
- Use split terminal panes with tabs. The current unnamed layout is saved automatically and restored on the next launch.
- Automatically open the configured default local terminal on startup or after closing tabs/panes when no connections remain.
- Use “通过zTerm打开” in Windows Explorer folder, background, and drive context menus to open a temporary local terminal at that directory. Running instances receive a new tab; temporary directory connections are not restored after restart. On Windows 11, the entry may appear under “Show more options”.
- Type `zterm` in the Windows Explorer address bar to open a temporary default local terminal in that directory. Argument-free launches inherit the caller's working directory, including when forwarding to a running instance or launching from a shortcut. The installer registers `App Paths` without changing the global `PATH`.
- Browse SFTP directories, create folders, upload, download, rename, delete, and retry transfers.
- Capture command history by session or local profile, search it, copy commands, and send commands back to the active terminal.
- Store connection credentials in the operating system keyring instead of plain SQLite rows.
- Launch the locally authenticated Codex CLI in the Agent sidebar, with one retained process per terminal tab.
- Give sidebar Codex a Visible Terminal Profile: every server command and output stays in zTerm scrollback, while additional saved SSH servers can be opened and operated in new tabs or horizontal/vertical splits.
- Give external Codex App clients a Headless Profile: native SSH execution and transfers return structured results without opening, reading, or writing terminal scrollback.
- Use Efficient Approval by default: inspections, transfers, and routine operations run automatically, while genuinely high-risk or irreversible actions are confirmed once in zTerm. Pending approval brings zTerm forward, opens the Agent approval surface, and returns the decision to the original Codex tool call without resubmission.
- Use Full Automation for trusted personal environments: writes, deletes, and critical commands run without approval and remain audited; only operations that require local secret input still wait for the user.
- Monitor SSH server CPU, memory, disk, load, uptime, and network traffic snapshots.

RDP sessions open in the Windows system Remote Desktop client. The app
keeps the session tab for navigation but does not embed or render the remote
desktop. Model management and built-in model invocation are intentionally
outside zTerm; the Agent sidebar is implemented entirely by the locally
authenticated Codex CLI.

## Screenshots

![Split terminals](assets/screenshots/split-terminals.png)

![File transfer](assets/screenshots/file-transfer.png)

![MCP settings](assets/screenshots/mcp-settings.png)

## Requirements

- Node.js `>=22.13`
- npm
- Rust stable toolchain
- Platform-specific Tauri system dependencies

Windows builds should use the MSVC Rust target
`x86_64-pc-windows-msvc` with Visual Studio Build Tools.

## Development

```bash
npm install
npm run dev
npm run dev:browser
npm run quality:check
npm run typecheck
npm run test:frontend
npm run build
```

`npm run dev:browser` is limited to UI development and visual regression in a regular browser. It explicitly enables a lightweight Tauri mock through Vite's `browser` mode; the default dev command, production builds, and real Tauri runtime do not enable it. Native terminal, SSH/SFTP, file, and system capabilities still require Tauri/WebView2 verification.

`npm run quality:check` enforces the single frontend IPC gateway, base/feature/app dependency direction, unique cross-file ownership of Tauri commands, and removal of exports with no external references. It is included in `npm run check`.

Rust and Tauri checks:

```bash
cd src-tauri
cargo fmt --check
cargo test
```

Desktop package build:

```bash
npm run tauri:build
```

## Releases

GitHub Actions builds release artifacts when a version tag is pushed:

```bash
git tag v0.1.0
git push origin v0.1.0
```

The release workflow builds four targets:

- Windows x64
- Linux x64
- Linux Arm64
- macOS Arm64

Unsigned macOS and Windows artifacts may show operating-system security prompts.
Code signing can be added later by configuring the relevant Tauri signing
secrets in GitHub Actions.

## Security Notes

Do not commit real hosts, usernames, passwords, API keys, private keys, tokens,
or smoke-test environment files. Local AI agent settings, internal project notes,
build output, runtime databases, and temporary credentials are ignored by
default.

On Windows, RDP files can be signed by setting
`ZTERM_RDP_SIGNING_CERT_THUMBPRINT` to the 40-character thumbprint of a code
signing certificate available to the current user. zTerm invokes `rdpsign.exe`
before starting `mstsc.exe`; missing or invalid configuration and signing
failures fall back to the existing unsigned RDP launch flow. Restart zTerm after
changing the environment variable.

## License

zTerm is licensed under the GNU General Public License version 3.0 only. See
[LICENSE](LICENSE) for details.

Third-party notices are listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

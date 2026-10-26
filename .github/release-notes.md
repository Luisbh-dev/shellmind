## Downloads

| Platform | Package |
| --- | --- |
| Windows 10/11 (x64) | `ShellMind-Setup-<version>-x64.exe` |
| macOS, Apple Silicon | `ShellMind-<version>-arm64.dmg` (or `.zip`) |
| macOS, Intel | `ShellMind-<version>-x64.dmg` (or `.zip`) |
| Linux x64, any distribution | `ShellMind-<version>-x86_64.AppImage` |
| Debian, Ubuntu (x64) | `shellmind_<version>_amd64.deb` |

`SHA256SUMS.txt` lists the checksum of every package: download it next to the packages and run `sha256sum -c SHA256SUMS.txt --ignore-missing` (on Windows, compare `Get-FileHash <package>` with its line). Each package also has a signed build provenance: `gh attestation verify <package> --repo Luisbh-dev/shellmind` checks that the release workflow built it from this tag.

The Linux packages need glibc 2.31 or newer: Debian 11+, Ubuntu 20.04+, Fedora, RHEL 9+.

## First start of an unsigned build

These builds are not signed with a publisher certificate, so the operating system warns the first time:

- **Windows**: SmartScreen shows "Windows protected your PC". Choose **More info → Run anyway**.
- **macOS**: the app is signed ad hoc, not notarized. Right-click (or Control-click) ShellMind in Applications, choose **Open**, then **Open** again; or run `xattr -dr com.apple.quarantine /Applications/ShellMind.app` once.
- **Linux AppImage**: make it executable (`chmod +x ShellMind-*.AppImage`). On Ubuntu 24.04 and later, AppArmor stops the sandbox of AppImages built on Electron: use the `.deb` there, which installs the AppArmor profile it needs.

Your data stays where it was: updating keeps the servers, settings and saved credentials.

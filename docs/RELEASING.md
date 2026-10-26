# Releasing ShellMind

A release is a version tag. Pushing `vX.Y.Z` runs [`.github/workflows/release.yml`](../.github/workflows/release.yml), which builds every desktop package on its own platform, smoke-tests each one as it ships, and attaches it to a **draft** GitHub Release. Publishing the draft is the last, manual step.

| Package | Built on | File |
| --- | --- | --- |
| Windows installer (NSIS, x64) | `windows-latest` | `ShellMind-Setup-X.Y.Z-x64.exe` |
| Linux AppImage and deb (x64) | `ubuntu-latest`, in a Debian 11 container | `ShellMind-X.Y.Z-x86_64.AppImage`, `shellmind_X.Y.Z_amd64.deb` |
| macOS, Apple Silicon (dmg, zip) | `macos-14` | `ShellMind-X.Y.Z-arm64.dmg`, `.zip` |
| macOS, Intel (dmg, zip) | `macos-15-intel` | `ShellMind-X.Y.Z-x64.dmg`, `.zip` |

Plus `SHA256SUMS.txt` for all of them. The packages carry `package.json`'s version, and the workflow refuses a tag that does not match it.

## 1. Before the tag

- `npm run typecheck && npm run lint && npm test && npm run build` pass, and CI is green on `main` (its weekly run also packages macOS and runs the Docker end-to-end suites).
- The end-to-end suites CI does not run pass locally: `SHELLMIND_E2E_UI=1 npm run test:e2e-ui`, the whole UI in Chromium against sshd containers ([test/e2e-ui/README.md](../test/e2e-ui/README.md)), and `npm run test:e2e -- test/e2e/windows-ssh.test.ts` against a Windows OpenSSH server, once with a throwaway administrator account and once with a standard one (variables in the README's [Testing](../README.md#testing) section). Delete the accounts afterwards.
- Set the version: `npm version X.Y.Z --no-git-tag-version` (package.json and the lock file), update the welcome screen's "What's new" list, `CHANGELOG.md` and the README (steps 1 to 3 of the release process in [ARCHITECTURE.md](ARCHITECTURE.md#release-process)), and commit as `release: version X.Y.Z`.
- Optional but recommended: build and check the packages locally (section 4), above all the Windows installer with `--launch`.

## 2. Tag and push

```bash
git tag vX.Y.Z
git push origin main vX.Y.Z
```

The workflow then:

1. **draft**: checks that the tag matches the version and creates the draft release, with the install notes of [`.github/release-notes.md`](../.github/release-notes.md), unless the tag has a release already.
2. **build** (four jobs, independent of each other): `npm ci`, `npm run build`, `node scripts/dist.mjs`, then `scripts/smoke-packaged.mjs` on the installer itself: Windows installs it silently into a temporary folder and uninstalls it again, a Mac mounts the dmg and unpacks the zip. Linux runs `npm run dist:linux`, whose container smoke-tests the AppImage and the deb. Only a package that passed is handed on, as a workflow artifact. These jobs can only read the repository: no token that could change the release reaches `npm ci` (every dependency's install scripts), the build or electron-builder's downloads.
3. **publish**: takes the packages of the platforms that built, records their signed build provenance (`gh attestation verify <package> --repo Luisbh-dev/shellmind`), and attaches them with `SHA256SUMS.txt`, the checksums of the files it built. Only this job and the draft one can write, and only their `gh` steps get the token; checkouts keep no credentials and every action is pinned by commit (Dependabot proposes the updates).

A failed job can be re-run on its own (Actions → Re-run failed jobs), then the publish job: on a draft, a package of the same name is replaced, and so is `SHA256SUMS.txt`. To build an existing tag again, run the workflow by hand (Actions → Release → Run workflow, with the tag).

## 3. Publish

Open the draft (Releases), write the notes for this version above the install section, check that the seven packages and `SHA256SUMS.txt` are there, and publish. Once a release is published, the workflow never replaces a package it has, so files people downloaded stay what they were; it only adds missing ones.

## 4. Building locally

The native modules (sqlite3, node-pty) come from `node_modules`, so each machine packages its own platform and architecture.

- **Windows** (or a Mac, for its architecture): `npm run dist -- --out <dir>` builds and packages; `--dir` gives the unpacked app only.
- **Linux**, from any machine with Docker: `npm run dist:linux -- --out <dir>`. It builds the committed `HEAD` in a Debian 11 container (`build/linux-builder.Dockerfile`) with node_modules of its own, so sqlite3 and node-pty are compiled against glibc 2.31 and the packages run on Debian 11+, Ubuntu 20.04+, Fedora and RHEL 9+. The afterPack check (`scripts/after-pack.mjs`) fails any Linux package whose native modules need a newer glibc than that.

Check a package the way the workflow does:

```bash
npm run smoke:packaged -- <dir>/ShellMind-Setup-X.Y.Z-x64.exe --launch   # Windows: install, check, start the app, uninstall
node scripts/smoke-linux-distros.mjs <dir>                              # Linux: Debian 12, Ubuntu 22.04/24.04, Fedora 40 containers
```

`smoke:packaged` checks that nothing but the app is shipped (no database, key, `.env` or log), that the package was built from the checkout's current commit (`npm run build` records it in `dist-electron/build-info.json`; a package from an earlier commit, or with uncommitted changes unless `--allow-uncommitted`, fails), the Electron fuses, that the native modules load, that the bundled backend starts on a fresh database (health, token enforced, every migration, a saved password stored encrypted), and that its RDP gateway, under the app's own runtime (BoringSSL), secures a connection to a fake RDP server whose certificate does not allow digital signatures, like Windows' self-signed ones, knows every suite of that fallback, and refuses the fallback when an attacker in the middle forces it on a server whose certificate allows digital signatures (`scripts/check-rdp-tls.mjs`; `node scripts/check-rdp-tls.mjs --server <dist-server>` runs it with the project's Electron). The Windows installer must also leave no copy of itself in `%LOCALAPPDATA%\shellmind-updater` after installing or uninstalling: electron-builder stores one there for electron-updater, which ShellMind does not use, and `build/installer.nsh` deletes it. `--launch` also starts the app with a temporary user data folder and checks its backend, the credentials key the OS keychain protects (`data-key.enc`) and its database, then closes it. Your own `%APPDATA%\shellmind` is never touched.

Prefer the workflow's packages: they carry a provenance attestation, and `SHA256SUMS.txt` describes exactly them. If a local package must go to a draft (`gh release upload vX.Y.Z <file> --clobber`), build it from the tagged commit after the last merge, smoke-test it (it fails when the package was built from another commit), and regenerate `SHA256SUMS.txt` from one flat folder holding every package of the release (`sha256sum -- * > SHA256SUMS.txt`), so that `sha256sum -c` finds the files where users download them.

## 5. Signing

Nothing is required: without credentials the Windows installer is unsigned (SmartScreen: *More info → Run anyway*) and the Mac app is signed **ad hoc**. electron-builder no longer does that on its own, and Apple Silicon refuses to start an app whose signature does not match its files (the Electron fuses and asar integrity change them), so `scripts/dist.mjs` sets `mac.identity` to `-` and turns the hardened runtime off. Users open such an app with right-click → *Open*, or `xattr -dr com.apple.quarantine /Applications/ShellMind.app`.

To sign, add repository secrets; the same jobs pick them up:

| Platform | Secrets |
| --- | --- |
| Windows | `WIN_CSC_LINK` (the .pfx, base64), `WIN_CSC_KEY_PASSWORD` |
| macOS | `CSC_LINK` (a *Developer ID Application* .p12, base64), `CSC_KEY_PASSWORD` |
| macOS notarization | `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`, or `APPLE_API_KEY` (the .p8 text), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` |

With a Developer ID the Mac app is signed with the hardened runtime and notarized when the Apple credentials are there. The secrets reach only the jobs of their platform.

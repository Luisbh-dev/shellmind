# End-to-end UI suite

Playwright specs that drive the whole app in Chromium, the way a user does:
every feature against real SSH servers in Docker. Opt-in; it is not part of
`npm test`.

## Run it

Needs Docker (Linux engine) and Playwright's Chromium
(`npx playwright install chromium`, once).

```sh
SHELLMIND_E2E_UI=1 npm run test:e2e-ui                    # every spec
SHELLMIND_E2E_UI=1 npm run test:e2e-ui -- terminal        # specs whose file matches
SHELLMIND_E2E_UI=1 npm run test:e2e-ui -- -g "Auto-Run"   # tests whose title matches
```

PowerShell: `$env:SHELLMIND_E2E_UI = '1'; npm run test:e2e-ui`.

Arguments after `--` go to `playwright test`. A run takes a few minutes; the
first one also builds the test images. Failures keep a trace, a screenshot
and the page's accessibility snapshot under `test-results/e2e-ui/`
(`npx playwright show-trace <trace.zip>`), the HTML report goes to
`playwright-report/`, and the backend and Vite logs of the run to
`test-results/e2e-ui-logs/`.

## What a run starts

The global setup (`support/globalSetup.ts`) starts, for this run only:

- sshd containers named `shellmind-test-e2eui-<host>-<pid>`, published on
  random loopback ports and removed at the end (the images
  `shellmind-test-e2eui-host` and `shellmind-test-e2eui-dind` stay as a build
  cache; `docker rmi` them to reclaim the space):
  - `alpha`, `beta`, `rekey`: Alpine 3.20.0 with OpenSSH, bash, sudo, a web
    page on 127.0.0.1:8080 and a growing log (`test/fixtures/e2e-ui/host`).
    `rekey` gets a new host key during the known-hosts spec.
  - `dind`: sshd in front of its own Docker engine (Docker in Docker,
    `--privileged`), with a running and a created container.
- a local Anthropic-compatible provider (`support/aiMock.ts`) that streams
  every answer; the backend reaches it through `MINIMAX_PROXY_URL`.
- the backend from its sources (tsx) with a temp database, data key and
  session token, on a free port; it never sees the developer's `.env`,
  database, ssh-agent or running app.
- the Vite dev server on a free port, pointed at that backend
  (`VITE_API_BASE`), with its dependency cache in the temp directory.

The UI asks for the token like any browser would; the specs open it with
`?token=` (see `support/test.ts`). Data is created through the API or the UI,
with a random suffix in every name. The local shell spec opens the default
shell of the machine running the suite and only echoes a word in it.

## Writing specs

- Select by role and accessible name (`getByRole`, `getByLabel`); the
  helpers in `support/ui.ts` cover the sidebar, workspace tabs, the palette,
  the app's selects and the terminal.
- Terminals draw on a canvas. `enableReadableTerminals(page)` turns on the
  terminal's screen reader support, whose accessible rows `expectTerminalText`
  reads. Check effects on the server with `inside(container, script)`.
- Never press "Open in external client" in the RDP tab: it starts the
  system's Remote Desktop app.
- While writing a spec, keep one environment up and run against it: start
  `support/globalSetup.ts` from a small script of your own, then pass its
  state as `SHELLMIND_E2E_UI_STATE` (the JSON it puts in that variable). The
  global setup then reuses it and leaves it running. Names carry random
  suffixes, so specs can run again against the same backend.

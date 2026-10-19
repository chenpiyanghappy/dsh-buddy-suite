# DSH Buddy Suite

English | [中文](./README.md)

**One plugin that does both WorkBuddy jobs**: it brings WorkBuddy desktop app
models into DeepSeek Harness *and* runs the WorkBuddy CN daily check-in
automatically at DSH startup.

It is built on two same-lineage projects,
[dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect)
(model access) and
[dsh-buddy-checkin](https://github.com/corrinehu/dsh-buddy-checkin)
(daily check-in), and merges them into one bundle.

> **Status: 0.1.1, released.** See [KNOWN-ISSUES.md](./KNOWN-ISSUES.md) for
> what is verified, what is not, and remaining known issues. In
> short: the check-in and model halves both work on Windows against a real
> account; Linux, macOS, and the international app are untested.

## Why one bundle

Both plugins read the same thing: the sign-in the WorkBuddy desktop app keeps in
its shared `CodeBuddyExtension` directory. Since WorkBuddy 5.6 those credentials
are encrypted at rest, and the key has to be pulled from the app's own Electron
binary. Kept separate, that key-pulling, envelope-opening, and install-locating
logic exists twice, and the two copies can disagree about a WorkBuddy update.

In one bundle:

- **One credentials implementation**, so neither half can disagree about who is
  signed in or how the key is reached.
- **One dependency set**, instead of two plugins each pinning
  `@earendil-works/pi-ai`.
- **Either half can fail without the other**: a failed check-in never hides the
  model group, and a failed provider registration never takes the check-in
  panel with it.

## Features

### Model access

- **Works out of the box**: the WorkBuddy group appears in the model picker with
  no configuration.
- **Both regions side by side**: WorkBuddy (CN) and WorkBuddy AI
  (international) are separate groups with separate accounts and credits.
- **Image input**: most models accept pasted or dropped images.
- **Reasoning levels**: declared levels are listed; undeclared models can be
  probed by hand. A model whose effort parameter turns out not to be checked is
  reported as "not adjustable" and names the level it uses instead.
- **Credit badge**: the account's remaining credit sits beside the composer,
  with a ↻ to re-read.
- **Model visibility**: hidden models are remembered per signed-in account.

### Daily check-in

- **Signs in at startup** for every WorkBuddy CN account on the machine.
  Accounts already signed today — including ones signed in the app — are
  skipped, so restarts cost nothing.
- **Multi-account discovery** reads the app's shared auth directory, where each
  sign-in and account switch leaves a timestamped backup. Every CN account ever
  signed in on this machine is found, deduplicated by account.
- **Session header entry** shows the WorkBuddy mark, the account count, and a
  status dot. It stays hidden when the machine has no CN account.
- **Details panel** shows each account's outcome, credit granted, and latest
  balance; opening it re-reads every balance.
- **Retry failed accounts** re-requests exactly today's failures.

## Install

**Prerequisite**: the WorkBuddy desktop app is installed and signed in on this
machine. The plugin reuses that sign-in and starts no OAuth flow.

```sh
dsh plugin --profile web add dsh-buddy-suite
```

## Coexisting with dsh-workbuddy-connect

Both bundles register WorkBuddy models, so the two can be installed side by
side: every id this bundle registers is namespaced (`workbuddy-suite`,
`llm-workbuddy-suite`, …) so it cannot collide with the other plugin's.

Two consequences worth knowing:

- the model picker shows **two WorkBuddy groups**, one per plugin;
- the default-model setting that names `workbuddy/<model>` keeps pointing at
  the other plugin, which is what makes coexistence safe.

If you only want the check-in, install this bundle and remove the other one.

## Verify

```sh
# Diagnostics: credential path, on-disk format, whether the decryptor is locatable
dsh plugin --profile web exec dsh-buddy-suite doctor

# Check-in outcome (this command also runs one check-in)
dsh plugin --profile web exec dsh-buddy-suite checkin

# Sign-in state and remaining credit
dsh plugin --profile web exec dsh-buddy-suite status
```

All three accept `--json`.

## Known limitations

See [KNOWN-ISSUES.md](./KNOWN-ISSUES.md) for the full list, including:

- **The check-in is CN-only**: an international token gets a 401 from the CN
  check-in endpoint.
- **No check-in on days DSH is not opened**: there is no timer and no cron. The
  upstream only signs the current day, so a missed day cannot be recovered.
- **Restricted environments cannot run the check-in**: it needs to spawn
  subprocesses (`reg.exe`, and the app's Electron to obtain the key), which a
  sandboxed environment denies with `EPERM`. This is an environment limit, not a
  code defect.
- **Linux and macOS are untested**, and so is the international app.

## Development

```sh
pnpm install
pnpm run check           # typecheck + test + build + verify
pnpm run check:offline   # same, but runs tests without spawning workers
```

| Path | Responsibility |
|---|---|
| `src/index.ts` | Plugin entry: assembles both providers and the check-in routes |
| `src/checkin.ts` | Check-in logic: discovery, claiming, balances, state |
| `src/checkin-routes.ts` | The check-in half's same-origin HTTP routes |
| `src/desktop-credential-protection.ts` | Envelope decryption and Electron location |
| `src/auth.ts`, `upstream.ts`, `adapter.ts`, … | Model provider half |
| `src/client/` | Browser half: settings cards, reasoning control, check-in panel |

## Acknowledgements

- [corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect) (MIT)
- [corrinehu/dsh-buddy-checkin](https://github.com/corrinehu/dsh-buddy-checkin) (MIT)
- [Sliverkiss/workbuddy2api](https://github.com/Sliverkiss/workbuddy2api) (MIT)

## Disclaimer

For personal study and research only. Use it with your own WorkBuddy account on
your own machine, and comply with WorkBuddy's terms of service. Not affiliated
with Tencent, WorkBuddy, or DeepSeek.

## License

MIT

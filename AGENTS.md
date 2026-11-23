# AGENTS.md

Rules for anyone (human or AI agent) changing, tagging or releasing this repository.

NVM Manager is an Orca plugin (`rekanara.nvm-manager`) that runs nvm from Orca's right
sidebar. It is a **community plugin**: it lives in this repository and is listed in the Orca
plugin directory by its version tags. It is not added to `stablyai/orca-plugins`; that
repository only accepts plugins Stably maintains.

## Layout

| Path | What it is |
| --- | --- |
| `orca-plugin.json` | Manifest. The **only** place the version number lives. |
| `worker/main.mjs` | Trusted worker: sources `nvm.sh` with one fixed bash script and passes fixed `nvm` arguments as positional parameters. |
| `panel/index.html` | Sidebar panel (plain HTML/JS, no build step). |

No build step and no dependencies. Keep it that way unless there is a real need.

## Develop

```sh
orca plugin validate .               # must print no errors and no warnings
orca plugin dev load .               # rerun with the --approve <fingerprint> it prints
orca plugin dev request . nvm.status
orca plugin logs local.nvm-manager
```

## Rules that must not break

- **No shell, no command lines from the panel.** The panel sends an action name plus a version.
  The worker allows only the actions in `ACTIONS`, checks the version against `VERSION_RE` (`vX.Y.Z`), and
  runs `bash -c <fixed script> nvm ...args` with `spawn`. Never build a command string from panel input.
- **Only change local workspaces.** Workspaces on SSH or paired hosts are shown but never changed.
- **No tracking, analytics or network calls** of our own. Only `nvm` talks to the network.
- **No minified or obfuscated code** (this is required by the Orca listing policy).
- **Keep access small.** Adding a capability, panel, command or a higher `execution` makes every
  existing user approve the update again. Do it only when it is needed, and say so in the
  release notes.
- **`engines.orca` must cover every host method we call.** `orca plugin validate` warns when it
  doesn't. Either raise `engines.orca` or guard the call with `orca.host.has('<method>')`.

## Branches and commits

- `main` is always releasable. Work on a branch (`fix/…`, `feat/…`, `chore/…`) and merge it into `main`.
- Use Conventional Commits: `fix(panel): …`, `feat(worker): …`, `chore(release): v1.2.0`.
- Agents: commit only when asked. **Never push, tag or publish a release unless the user
  explicitly asks for it.**

## Versioning

Use SemVer (`MAJOR.MINOR.PATCH`) in `orca-plugin.json`. Tags are `vX.Y.Z` and always equal the
manifest version.

| Change | Bump |
| --- | --- |
| Bug fix or text change, no new access | PATCH |
| New feature, new setting, or raising `engines.orca` | MINOR |
| New capability, panel or command, a higher `execution`, or removing or renaming a setting or request | MAJOR (MINOR while below 1.0.0) |

Released versions never change:

- Never move, delete or re-push a tag that has been pushed.
- Never reuse a version number. If a release is broken, ship the next PATCH.
- Orca installs the newest `vX.Y.Z` tag and pins the exact commit. A tag that points somewhere
  else breaks every install pinned to it.

## Release checklist

Run from a clean `main` that is up to date with `origin/main`.

1. **Check:** `orca plugin validate .` prints no errors **and no warnings**. Load the plugin
   with `orca plugin dev load .` and try Pin, Install, Uninstall and Default on a real Node.js project.
2. **Bump:** set `version` in `orca-plugin.json` to the new version, then commit it on its own:
   ```sh
   git commit -am "chore(release): vX.Y.Z"
   ```
3. **Confirm the tag matches the manifest:**
   ```sh
   V=$(node -p "require('./orca-plugin.json').version")
   orca plugin release-entry .        # check version, minimumOrca and capabilities are as expected
   ```
4. **Tag that commit with an annotated tag and push it:**
   ```sh
   git tag -a "v$V" -m "v$V"
   git push origin main "v$V"
   ```
5. **Write the GitHub release notes:** list what changed for users, and call out any new access
   or a raised `engines.orca`.
   ```sh
   gh release create "v$V" --title "v$V" --notes-file notes.md
   ```
6. **Check the listing:** https://orca.dev/plugins/rekanara/nvm-orca-plugin. Then run
   `orca plugin install rekanara/nvm-orca-plugin@v$V` on a clean Orca and confirm it installs.

## First release only

- The repository must be public, and owned by `rekanara`. The owner becomes the publisher, and
  the plugin id becomes `rekanara.nvm-manager`. Don't add a `publisher` field to the manifest.
- Add the topic once: `gh repo edit rekanara/nvm-orca-plugin --add-topic orca-plugin`.
- Keep `LICENSE` in the repository, matching `"license"` in the manifest (MIT).
- Don't use Node.js logos, or anything else that suggests the OpenJS Foundation or the nvm authors made
  or endorse this plugin.

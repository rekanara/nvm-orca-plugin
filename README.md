# NVM Manager for Orca

Control [nvm](https://github.com/nvm-sh/nvm) (Node Version Manager) from Orca's right sidebar.

- Shows the Node.js version pinned by the focused workspace (`.nvmrc`), what it resolves to, the default version and your nvm version.
- Lists installed versions: **Pin** (writes `.nvmrc`), **Default** (`nvm alias default`), **Uninstall** (`nvm uninstall`).
- Lists Node.js releases, newest patch of each major line (LTS or all): **Install** (`nvm install`) or **Pin** directly.
- Streams nvm's output into the panel and shows a desktop notification when a job ends.

Pinning only writes `.nvmrc`; nvm can't change the Node.js of a terminal that is already open.
Run `nvm use` there (or use nvm's shell auto-switch).

## Requirements

- Orca 1.4.247 or later
- nvm (nvm-sh) on macOS or Linux, in `$NVM_DIR`, `~/.nvm` or Homebrew. nvm-windows is not supported.

## Develop

```sh
orca plugin validate .
orca plugin dev load .          # rerun with the --approve <fingerprint> it prints
orca plugin dev request . nvm.status
orca plugin logs local.nvm-manager
```

Or in Orca: Settings → Plugins → Development folders… → add this folder.

If Orca can't find nvm, set **NVM directory** in the plugin's settings.

## Access

Runs as a trusted worker: it starts `bash`, sources `nvm.sh` and runs `nvm` with your user account.
The panel can only ask for four actions (pin, install, uninstall, default) with a checked `vX.Y.Z`
version; it never sends a command line. Workspaces on SSH or paired hosts are shown but not changed.

## License

MIT

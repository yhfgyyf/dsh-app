# Ubuntu amd64

DSH Desktop 0.1.50 includes DSH 0.2.2-rc.1, Node.js 24.15.0 and Python 3.12.14. Build and verify this package on Ubuntu amd64; the Kylin LoongArch installer is separate.

Install or upgrade with `sudo apt install ./DSH-Desktop-0.1.50-Ubuntu-amd64.deb`, then launch DSH Desktop from the application menu or run `dsh-desktop` in the graphical desktop session. Existing user configuration and conversations are preserved. The desktop installer does not change the global `dsh` CLI.

Desktop preferences and its plugin profile are under `~/.config/DSH Desktop/`; shared DSH configuration and sessions are under `~/.dsh/`. Back these up before an upgrade. Installed profiles retain their existing plugins; the installer does not preinstall P2P, Side Chat, Univer or Whale. `local-plugins/package.json` is an anonymous manifest containing only `{"private":true}`.

Browser Use requires a supported local Chromium browser and its Playwright extension, or an explicitly configured CDP connection. Native Computer Use is unavailable in the Ubuntu runtime. Notification banners require the desktop notification service and its permission; launcher badge presentation depends on desktop support.

`sudo apt remove dsh-desktop` removes the application while retaining user data. To roll back, reinstall a verified previous DEB and restore the matching configuration/session backup if required.

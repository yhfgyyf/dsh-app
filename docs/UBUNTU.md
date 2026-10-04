# Ubuntu desktop package

The amd64 `.deb` targets Ubuntu 22.04 and Ubuntu 24.04 LTS. It contains Electron 44.4.5, Node.js 24.15.0, Python 3.12.14 and the same pinned Office/PDF libraries as the macOS and Windows builds. It does not use a system Node.js or Python installation.

Install from the directory containing the package:

```sh
sudo apt install ./DSH-Desktop-0.1.34-Ubuntu-amd64.deb
dsh-desktop
```

Run the application as your regular desktop user. The package installs under `/opt/dsh-desktop`, adds a menu entry, and configures the bundled Chromium sandbox helper as `root:root` with mode `4755`. The launcher keeps Chromium sandboxing enabled. Do not add `--no-sandbox` or disable the system's user namespace restrictions.

Chat, tools, files, Browser Use and phone pairing use the shared desktop implementation. Native Computer Use is unavailable on Linux because the pinned Cua driver supports macOS and Windows. Application updates on Linux use a new `.deb` installed with `apt`; the macOS/Windows automatic installer is disabled. API configuration and actual phone/network access must be provided by the user.

Desktop 0.1.34 can retrieve a private relay's root CA using a `dshca1_...` registration code from its administrator. It checks the CA fingerprint before transmitting the one-time code, then retains normal TLS chain, expiry and IP/hostname checks. The verified CA is stored with that relay's encrypted DSH credentials and is reused for HTTPS and WSS after restart. No system CA installation or sudo is needed for registration. See [registration instructions](REMOTE-ACCESS.md#私有-ca-自动配置desktop-0134-起). LAN pairing, changing networks, phone unbinding and reconnecting preserve relay registration; only the explicit unregister action removes it.

Build on Ubuntu 22.04 amd64 with the pinned Node.js version:

```sh
npm ci
npm run setup:runtime
npm run package:linux
```

`runtime/python-lock.json` pins the Linux interpreter and wheels by official download URL, byte length and SHA-256. Runtime preparation performs Office/PDF round trips before and after relocation; packaging checks the runtime again after extracting the `.deb`.

Ubuntu 24.04 restricts unprivileged user namespaces by default. Verification must include an actual 24.04 kernel; a 24.04 container on a 22.04 host alone does not cover this behavior. See [Ubuntu's release notes](https://discourse.ubuntu.com/t/ubuntu-24-04-lts-noble-numbat-release-notes/39890) and [Electron's sandbox documentation](https://www.electronjs.org/docs/latest/tutorial/sandbox).

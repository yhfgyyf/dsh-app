# Security

See [docs/SECURITY.md](docs/SECURITY.md) for the full trust model — read it before exposing a
harness to your network.

## Reporting a vulnerability

Two private channels, either is fine — please do not open a public issue:

- **[Report a vulnerability](https://github.com/sorsama/deepseek-harness-mobile/security/advisories/new)**
  on the Security tab, which keeps the report and the discussion private on GitHub.
- Email **sor@zyphite.com**.

Useful things to include: what an attacker can do, the steps to reproduce it, the app version and
the harness version, and how the app was connected (LAN, `adb reverse`, or same device).

## Already known, and not a vulnerability in this app

The DeepSeek Harness has **no authentication**. Its only gate is a `Host`-header trust fence, and
when it binds `0.0.0.0` it trusts its own LAN IP literals — so any device on that network can drive
the agent, including running commands on the host computer. This is a documented property of the
harness, described in [docs/SECURITY.md](docs/SECURITY.md), which is why LAN mode requires a
deliberate patch and why the app warns whenever it connects to a non-loopback host.

Reports of that behaviour on its own are not needed. Ways to bypass the trust fence, or anything
this app does beyond what that model already permits, very much are.

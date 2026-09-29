# DSH Remote fork

Base: sorsama/deepseek-harness-mobile v0.12.1, commit 07471cc89a3c78889528df54811764486a7f4c6e (MIT; see LICENSE).

`CentralCipher.kt` ports the sealed-tunnel-v1 cryptography in april-jk/dsh-mobile-plugin v0.1.9, commit 489a1a2c0f12246e478a93eb25683f87c1f33832. Copyright (c) 2026 dsh-mobile contributors. The full MIT license is retained in `CENTRAL-CRYPTO-LICENSE`.

Central relay integration is specific to the DSH Desktop fork. Package ID and update defaults are separated from the upstream application. Existing direct/LAN relay behavior is retained.

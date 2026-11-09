# RC.1 plugin acceptance inputs

Side 0.1.8 and P2P 0.3.4 are the exact standalone archives delivered with Desktop 0.1.50. `inputs.json` pins their size and SHA-256. The Side harness is copied from its reviewed source commit `8783974`; its native test loads the extracted delivered package.

Univer 0.3.5-universal.3 is reconstructed from the previously published universal.2 archive using the repository's hash-checked builder. Every payload file is checked against the Mac delivery's reviewed provenance before Windows installation and real tool tests. This avoids adding the 49 MB input archive to Git.

All profiles, sessions, relay identities and model fixtures are disposable. No online model or user credentials are used. The existing Desktop installer remains unchanged.

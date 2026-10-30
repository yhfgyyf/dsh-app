package com.labteto.dshmobile.core

/** Core module placeholder for the baseline build; wire protocol code lands here. */
object DshCore {
    /**
     * The harness release this client's DTOs and call shapes were ported from and verified
     * against.
     *
     * Display-only, and it has no version to compare itself against: 0.1.2 removed
     * `host.describe`, so the harness does not tell a client what it is. Where a shape used to
     * differ between releases this client read the difference off the wire rather than off a
     * version string, and there is no version-shaped branch in the client at all — see
     * `docs/COMPATIBILITY.md`.
     *
     * 0.1.3 moved the baseline for the second time in a row that the older wire cannot follow:
     * session format v2 replaced per-token durable events with one settlement per model attempt,
     * so a client that does not opt into the live assistant stream never sees a reply being
     * written.
     *
     * 0.1.7 is the third: session format v4 flattened the `tool/result` message, and several
     * endpoints this client read moved onto projections or streams. The client still reads the
     * 0.1.6 shapes wherever it can tell them apart on the wire.
     *
     * 0.2.0 moved the baseline without changing anything this client sends or reads. Hosts on
     * 0.1.7-rc.x and 0.1.6 still work as they did with client 0.12.0.
     */
    const val PROTOCOL_BASELINE = "0.2.0-rc.1"
    const val PROTOCOL_COMMIT = "4878cdabd87d4041bdaff61d04c966883b9fd07a"
}

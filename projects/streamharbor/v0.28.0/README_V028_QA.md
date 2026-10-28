# StreamHarbor v0.28 QA and design notes

**Status: CANDIDATE / NO_GO.**

This version wires observed session attribution into the existing save -> OPFS stage -> export.offer -> background journal -> downloads progress chain. It deliberately does not claim durable whole-session coverage after a host crash, successful media decode, or a lifetime saved-file count.

The host starts with null attribution and sets an independent cryptographically random 32-hex key only for newly started or resumed host control epochs. Old OPFS orphan recovery is not assigned to any new session. Each entry snapshots its key when save() starts; retry and delayed completion do not change it. The export journal persists the key atomically with its part record. The sessionStatus(key) method projects only retained matching export records via the v0.27 reducer. It never returns the key, URLs, part names or byte payloads.

The 512-entry bounded journal may evict verified records, so sessions are not complete histories. The reducer's 'verified' only confirms browser-download filesize equality, not decoding or playable A/V. A new identity on crash recovery is a **new observed attribution epoch**, not the original recording identity. This intentionally leaves a gap until durable session provenance is designed and approved.

Real Chrome/Firefox/Floorp installs and actual live stream/long-run/crash/AV sync acceptance remain outstanding.

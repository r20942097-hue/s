# StreamHarbor / RPLAY v0.24 QA

Status: **CANDIDATE / NO_GO**. Scope: popup truthfulness & response timing, not recorder engine.

Recording state and export journal are read separately. The journal summarizes all saved exports, not the currently active recording. The timestamp called `capturedAt` represents the conservative start of the status request, not a host-attested exact capture. `ledgerCapturedAt` is a separate completion time and null on failure. Times are display aids, not guarantees of A/V integrity. The camera/audio timeline and full-stream delivery are not validated by these tests.

Unverified: actual Firefox/Chrome/Floorp install, real live stream, long-duration and crash recovery, A/V synchronization, OS file-system and quota conditions. Source/derived build immutability is checked by scripts/validate.py.
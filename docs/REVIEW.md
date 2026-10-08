# Release review: 0.1.1

Review date: 2026-10-09. Tests used an isolated PostgreSQL 18 database and simulated providers.

| Finding | Second confirmation | Resolution |
| --- | --- | --- |
| Cancelled and interrupted jobs retained encrypted content. | Regressions reproduced retained content; independent review compared all terminal paths. | Clear content for registration expiry, access changes and interrupted sends; repair old terminal rows at startup. |
| Integrity verdict matching accepted a string containing the expected verdict. | Offline reproduction with `NOT_MEETS_DEVICE_INTEGRITY`; independent regression run. | Require an array before matching the verdict. |
| Encrypted identifiers accepted coerced arrays and malformed UUID shapes. | Original validator accepted synthetic invalid inputs; regression rejected them after the fix. | Require strings and the documented UUID shape. |
| Integrity verification fetched OAuth tokens for every request. | Mocked call counts and independent tests covered concurrency, expiry, rotation, refresh failure and late responses. | Cache one credential with an expiry margin and shared refresh. |
| Public status decrypted credentials and scanned historical statistics. | Query review and a regression that prohibits decryption. | Read application and channel readiness directly: seven queries reduced to three. |
| Probe history queries lacked a time-only index. | Two independent `EXPLAIN ANALYZE` runs on 720,000 synthetic rows. | Add a timestamp index; warm query time fell from about 4.8 ms to 3.1 ms, buffer hits from 4078 to 232 in this fixture. |
| Release tag validation ran after publishing images. | Dependency review and mismatched-tag evaluation. | Validate before build; PR image checks have read-only permissions. |

Checks: 95 tests passed, none skipped; JavaScript and shell syntax checks passed; Actionlint passed; npm audit reported no known dependency vulnerabilities; Gitleaks found no secrets in Git history or publishable source. Local `.env` remains ignored and excluded from packages. Docker data directories use mode 0700; secret files use 0600.

CodeQL findings received a separate review. Route enumeration and fixed channel links were hardened and tested with hostile hashes. Three file-creation warnings were independently reproduced with existing and dangling symlinks: exclusive `wx` creation rejected every replacement without modifying targets. The file-to-HTTP warning refers only to a temporary test monitor token sent to a fixed loopback fixture. These warnings did not establish a remotely exploitable vulnerability.

Revocation between credential checks and task admission was independently tested and is already protected by transaction locks and registration revalidation.

These checks do not validate real devices, vendor accounts, cloud backup permissions, or production throughput. Historical backup snapshots follow their retention policy; clearing live rows does not rewrite old backups.

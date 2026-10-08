# Changelog

## 0.1.2 — 2026-10-09

- Move backend code and schema to `src/`, console files and assets to `public/`, and CLI tools to `scripts/`.
- Consolidate detailed guides under `docs/` and update links and commands.
- Preserve root `.env` and `data/`, existing Docker volumes, `npm start`, `install.sh`, and public HTTP URLs.

## 0.1.1 — 2026-10-09

- Prepare the standalone gateway for public distribution under MIT.
- Replace deployment-specific notes with concise English setup, protocol, operations, contribution, and security documentation.
- Correct documented notification support, application quota overrides, application integrity checks, and webhook alerts.
- Clear notification content on cancellation and interrupted delivery; remove content retained by earlier terminal jobs.
- Require correctly typed integrity verdicts and encrypted notification identifiers.
- Cache Google OAuth tokens safely and reduce public status queries from seven to three without decrypting vendor credentials.
- Index probe timestamps for history queries and retention.
- Test, scan, and package source archives and amd64/arm64 images through GitHub Actions with pinned actions, SBOM, and provenance.
- Harden console routes, set the Docker data directory to mode 0700, and provide public Docker installation archives with checksums.

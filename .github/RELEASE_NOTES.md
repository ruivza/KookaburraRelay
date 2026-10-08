Directory layout maintenance release.

- Organize backend code in `src/`, console files in `public/`, CLI tools in `scripts/`, and detailed guides in `docs/`.
- Preserve root `.env` and `data/`, Docker volumes, `npm start`, `install.sh`, and public HTTP URLs.
- Update Docker packaging, test imports, documentation links, and CLI commands for the new paths.

Images: `ghcr.io/ruivza/kookaburrarelay:0.1.2` and `ghcr.io/ruivza/kookaburrarelay-backup:0.1.2`.

Download both Docker archives for your platform, verify `SHA256SUMS`, and import with `docker load -i <archive>`. See [installation](https://github.com/ruivza/KookaburraRelay#readme) and [operations](https://github.com/ruivza/KookaburraRelay/blob/main/docs/OPERATIONS.md).

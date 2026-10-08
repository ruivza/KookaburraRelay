MIT-licensed open-source release with security fixes and performance improvements.

- Clear notification content when registrations expire, access is revoked, or interrupted deliveries become unknown.
- Validate integrity responses strictly and reuse Google OAuth tokens with bounded expiry.
- Optimize probe history queries and add regression coverage.
- Publish amd64/arm64 gateway and backup images with SBOM and build provenance.

Images: `ghcr.io/ruivza/kookaburrarelay:0.1.1` and `ghcr.io/ruivza/kookaburrarelay-backup:0.1.1`.

Download the gateway and backup Docker archives for your platform and import them with `docker load -i <archive>`. These release assets are publicly downloadable even when GHCR package visibility is private. Verify all downloads against `SHA256SUMS`.

See README for installation and SECURITY.md for deployment requirements. Vendor acceptance does not guarantee device delivery; real-device and cloud backup validation require operator credentials.

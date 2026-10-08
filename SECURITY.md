# Security policy

## Reporting

Use this repository's GitHub **Security → Report a vulnerability** when private vulnerability reporting is enabled. If it is unavailable, open an issue requesting a private reporting channel without including exploit details or credentials. Do not place sensitive reports in public issues or pull requests.

Include the affected revision, deployment assumptions, impact, and a minimal reproduction using synthetic data. Remove tokens, private keys, database URLs, device identifiers, and notification content. No response-time guarantee is currently defined.

## Supported scope

Security fixes target the current default branch and its latest release. Older versions are not maintained separately. A source review or passing test suite is not a certification of a deployment.

## Operational boundaries

- Terminate public traffic at HTTPS and restrict administrator access. The console and business APIs share one port.
- Enable admin two-factor authentication. Protect session storage and use a trusted browser.
- Store the database and matching `master.key` together in protected backups. Local backup archives also contain secrets; remote archives use the configured `age` public key.
- Grant vendor and object-storage credentials only the permissions required by the deployment.
- Configure only verified reverse-proxy addresses. Forwarded headers are ignored by default.
- App Attest, Play Integrity, and server approval are disabled by default. Enable them when compatible integrations have been verified.
- Provider acceptance is not device delivery. An `unknown` result may already have reached the provider and is not automatically replayed.

See [operations](docs/OPERATIONS.md) and [access policies](docs/ACCESS_SECURITY.md) for configuration and recovery details.

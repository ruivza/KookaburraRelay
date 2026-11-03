Performance, structure and protocol release; includes the unreleased 0.2.0 changes. Read the [changelog](https://github.com/ruivza/KookaburraRelay/blob/main/CHANGELOG.md) before upgrading from 0.1.2.

- Add push protocol 2 (`"protocol":2`, `relay` payload names). Protocol 1 remains the default for this release only and will be removed in the next one.
- New installations no longer create the `perch-mail` application; existing installations keep it.
- Rename metrics to `relay_gateway_*`; the `perch_gateway_*` names are still served, deprecated, for this release only.
- Send throughput roughly doubled and database round trips per send fell from 39 to 8, through in-memory rate limits, cached configuration, row locks and numbered migrations.
- The gateway and backup worker connect as a non-superuser database role on new installations.
- Fix slow request bodies holding shared handler slots, tighten the console's security headers, and type-check the sources in CI.

Images: `ghcr.io/ruivza/kookaburrarelay:0.3.0` and `ghcr.io/ruivza/kookaburrarelay-backup:0.3.0`.

Download both Docker archives for your platform, verify `SHA256SUMS`, and import with `docker load -i <archive>`. See [installation](https://github.com/ruivza/KookaburraRelay#readme) and [operations](https://github.com/ruivza/KookaburraRelay/blob/main/docs/OPERATIONS.md).

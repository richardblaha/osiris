# Security Policy

## Supported versions

Osiris IDE is pre-1.0. Only the latest tagged release and `main` receive
security fixes.

| Version           | Supported |
| ----------------- | --------- |
| `main`            | ✅        |
| latest `v0.x` tag | ✅        |
| older tags        | ❌        |

## Reporting a vulnerability

**Do not open a public issue for security problems.**

Use GitHub's [private vulnerability reporting](https://github.com/osiris-ide/osiris/security/advisories/new)
or email **security@osiris-ide.org** (PGP key in `SECURITY.asc` at the repo root
of a signed release).

Please include:

- Affected component (`osiris-ai`, `apps/osiris-desktop`, the branding overlay, …)
- Version / commit
- Reproduction steps and impact
- Any suggested remediation

## What to expect

- Acknowledgement within **3 business days**.
- An initial assessment and severity rating within **10 business days**.
- Coordinated disclosure: we agree a release date with you, credit you in the
  advisory (unless you prefer anonymity), and publish a GitHub Security Advisory
  with a CVE where applicable.

## Scope notes

- Osiris fetches upstream **VSCodium / Code - OSS** at build time. Vulnerabilities
  in unmodified upstream code should be reported to the respective upstream
  project; we will pick up their fixes on the next pinned-tag bump.
- The `osiris-ai` extension can spawn **MCP servers** and call external model
  providers based on user configuration. Report issues in Osiris's handling of
  that configuration (command injection, credential leakage, SSRF) here; issues
  in third-party MCP servers go to their maintainers.

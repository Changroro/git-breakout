# Security Policy

## Supported version

Security fixes target the current `main` branch. Older commits and self-hosted deployments are not maintained as separate supported releases.

## Reporting a vulnerability

Please do not open a public issue for an unpatched vulnerability.

Use GitHub private vulnerability reporting when it is enabled for this repository. If that option is unavailable, email `chbae624@gmail.com` with:

- the affected component and commit;
- reproduction steps or a minimal proof of concept;
- the expected impact;
- any suggested mitigation.

Do not include real credentials or private user data. Acknowledgement is normally sent within seven days, but this personal project does not provide a guaranteed response or remediation SLA.

## Deployment responsibility

Production operations are not distributed in this repository. Rotate exposed secrets immediately and keep `.env`, tunnel credentials, database volumes, backups, caches, and logs outside version control.

# Security policy

## Supported versions

| Version | Supported          |
| ------- | ------------------ |
| 1.x.x   | :white_check_mark: |
| < 1.0   | :x:                |

Only the latest minor release on the `1.x` line receives security fixes. Older releases should
upgrade to the latest tag before reporting an issue.

This is testnet, pre-production software. The smart contracts have not yet been audited. Treat
anything on-chain as experimental until a release notes otherwise.

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Report privately through GitHub: go to the repository's **Security** tab → **Report a
vulnerability** (this opens a private advisory). If you can't use that, email the security
contact below.

Include what you can:

- Affected component (route, middleware, contract, etc.)
- Steps to reproduce
- Impact / what an attacker could achieve
- Any suggested remediation

We aim to acknowledge within **3 business days**.

## Security update process

1. **Triage** — the report is reproduced and assigned a severity (critical / high / medium / low)
   within 3 business days of acknowledgment.
2. **Fix** — a patch is developed on a private branch (or private security advisory fork for
   GitHub-reported issues) so the vulnerability isn't disclosed before a fix ships.
3. **Release** — the fix is released as a patch version following [semver](https://semver.org/).
   Critical/high severity issues are released as soon as the fix is verified; medium/low severity
   issues are bundled into the next scheduled release.
4. **Disclosure** — a GitHub security advisory is published once the fix is released, crediting
   the reporter (unless they request otherwise) and summarizing impact and remediation.
5. **Coordination** — for issues affecting deployed instances, we coordinate timing of public
   disclosure with the reporter to allow operators a reasonable window to upgrade.

## Security contacts

- Primary: **daveproxy80@gmail.com**
- Preferred: GitHub private vulnerability reporting (Security tab → Report a vulnerability)

## Audit history

| Date       | Scope                  | Auditor | Report |
| ---------- | ----------------------- | ------- | ------ |
| _Pending_  | Smart contracts (Soroban) | —       | —      |

No formal third-party audit has been completed yet. This table will be updated as audits are
scheduled and completed. Until an audit is recorded here, treat on-chain components as
unaudited and experimental.

# Security and disclosure

Do not commit private Tdarr state, raw media-derived rows, logs, databases, or API tokens. The `.gitignore` is intentionally aggressive, but it is not a substitute for review.

Before publishing, opening a PR, or cutting a release, run:

```bash
python3 tools/audit-for-secrets.py .
```

Also consider external scanners such as `gitleaks` or `trufflehog` if available.

## Reporting a problem

If you find a secret, credential, or private media-derived artifact in this repository, rotate/revoke the secret first if applicable, then open a private security report or contact the maintainer directly. Do not paste live secrets into public issues.

For a repeatable pre-release process, see [docs/release-checklist.md](docs/release-checklist.md).

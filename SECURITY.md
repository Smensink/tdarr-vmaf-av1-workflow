# Security and disclosure

Do not commit private Tdarr state, raw media-derived rows, logs, databases, or API tokens. The `.gitignore` is intentionally aggressive, but it is not a substitute for review.

Before publishing or opening a PR, run:

```bash
python3 tools/audit-for-secrets.py .
```

Also consider external scanners such as `gitleaks` or `trufflehog` if available.

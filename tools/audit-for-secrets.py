#!/usr/bin/env python3
"""Lightweight privacy/secret audit for this repository."""
from __future__ import annotations
import argparse, re, sys
from pathlib import Path

TEXT_EXT = {
    '.js', '.json', '.md', '.yml', '.yaml', '.sh', '.py', '.txt',
    '.env', '.example', '.gitignore', ''
}
SKIP_DIRS = {
    '.git', 'node_modules', 'cache', 'logs', 'server', 'backups',
    'upgrade-backups', 'build-workspace', 'custom-ffmpeg', 'custom-cuda',
    '.venv', '.pytest_cache', '__pycache__',
}
PRIVATE_ARTIFACT_NAMES = {
    # Exported sklearn category vocabularies contain private titles, release
    # groups, providers, and other row-derived training values.
    'size_failure_shadow_hgb.json',
}
PATTERNS = [
    ('windows-user-path', re.compile(r'C:[\\/]Users[\\/][^\\/\s]+', re.I)),
    ('msys-user-path', re.compile(r'/c/Users/[^/\s]+', re.I)),
    ('explicit-seb', re.compile(r'\bseb(?:astian|_m)?\b', re.I)),
    ('windows-media-drive', re.compile(r'\b[D-Z]:[\\/](?:TV|Movies|Media|Downloads)\b', re.I)),
    (
        'personal-media-mount',
        re.compile(r'/media/(?:TV|Movies)(?:_[A-Za-z0-9]+)?(?:/|\\b)', re.I),
    ),
    (
        'credential-string-literal',
        re.compile(
            r'(?i)(?:api[_-]?key|token|password|secret)\s*[:=]\s*'
            r'["\'][A-Za-z0-9_\-]{16,}["\']'
        ),
    ),
    (
        'credential-env-literal',
        re.compile(
            r'(?i)^\s*[A-Z0-9_]*(?:API_KEY|TOKEN|PASSWORD|SECRET)\s*=\s*'
            r'[A-Za-z0-9_\-]{16,}\s*$'
        ),
    ),
    ('private-ip-hardcoded', re.compile(r'\b(?:10|172\.(?:1[6-9]|2\d|3[0-1])|192\.168)\.\d{1,3}\.\d{1,3}\b')),
]
ALLOW_SNIPPETS = [
    'Optional Plex token', 'Plex Token', 'TMDB API Key', 'TVDB API Key',
    'api tokens', 'API tokens', 'token for authenticated',
    "('msys-user-path', re.compile", # this audit tool's own pattern definition
    "('explicit-seb', re.compile", # this audit tool's own pattern definition
]

def should_skip(path: Path, root: Path):
    try:
        relative = path.relative_to(root)
    except ValueError:
        return True
    if any(part in SKIP_DIRS for part in relative.parts):
        return True
    return len(relative.parts) >= 2 and relative.parts[:2] == ('data', 'private')

def is_probably_text(path: Path):
    return path.suffix in TEXT_EXT or path.name in {'Dockerfile','.gitignore','LICENSE'}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('root', type=Path, nargs='?', default=Path('.'))
    args = ap.parse_args()
    root = args.root.resolve()
    findings = []
    for p in root.rglob('*'):
        if p.is_dir() or should_skip(p, root) or not is_probably_text(p):
            continue
        if p.name in PRIVATE_ARTIFACT_NAMES:
            findings.append((
                'private-trained-model',
                p.relative_to(root),
                1,
                'row-derived categorical model must remain outside Git',
            ))
            continue
        try:
            text = p.read_text(encoding='utf-8', errors='replace')
        except Exception:
            continue
        for i, line in enumerate(text.splitlines(), 1):
            if any(s in line for s in ALLOW_SNIPPETS):
                continue
            for name, rx in PATTERNS:
                if rx.search(line):
                    findings.append((name, p.relative_to(root), i, line[:220]))
    if findings:
        print('PRIVACY/SECRET AUDIT FINDINGS:')
        for name, path, line_no, line in findings[:200]:
            print(f'{name}: {path}:{line_no}: {line}')
        if len(findings) > 200:
            print(f'... {len(findings)-200} more findings')
        return 1
    print('privacy/secret audit passed')
    return 0

if __name__ == '__main__':
    raise SystemExit(main())

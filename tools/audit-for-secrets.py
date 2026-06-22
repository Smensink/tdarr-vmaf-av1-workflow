#!/usr/bin/env python3
"""Lightweight privacy/secret audit for this repository."""
from __future__ import annotations
import argparse, re, sys
from pathlib import Path

TEXT_EXT = {'.js','.json','.md','.yml','.yaml','.sh','.py','.txt','.env','.example','.gitignore','.Dockerfile',''}
SKIP_DIRS = {'.git','node_modules','cache','logs','server','backups','upgrade-backups','build-workspace','custom-ffmpeg','custom-cuda','data/private'}
PATTERNS = [
    ('windows-user-path', re.compile(r'C:[\\/]Users[\\/][^\\/\s]+', re.I)),
    ('msys-user-path', re.compile(r'/c/Users/[^/\s]+', re.I)),
    ('explicit-seb', re.compile(r'\bseb(?:astian|_m)?\b', re.I)),
    ('windows-media-drive', re.compile(r'\b[D-Z]:[\\/](?:TV|Movies|Media|Downloads)\b', re.I)),
    ('raw-media-extension', re.compile(r'\b[^\n]{0,80}\.(?:mkv|mp4|avi|mov)\b', re.I)),
    ('api-key-assignment', re.compile(r'(?i)(api[_-]?key|token|password|secret)\s*[:=]\s*["\']?[A-Za-z0-9_\-]{16,}')),
    ('private-ip-hardcoded', re.compile(r'\b(?:10|172\.(?:1[6-9]|2\d|3[0-1])|192\.168)\.\d{1,3}\.\d{1,3}\b')),
]
ALLOW_SNIPPETS = [
    'Optional Plex token', 'Plex Token', 'TMDB API Key', 'TVDB API Key',
    'api tokens', 'API tokens', 'token for authenticated',
    'http://192.168.1.100:32400', # example tooltip, not a real endpoint
    "path.extname(holdout.path || '') || '.mkv'", # generic extension fallback, not a real media title
    "('msys-user-path', re.compile", # this audit tool's own pattern definition
    "('explicit-seb', re.compile", # this audit tool's own pattern definition
    "input.mkv", # FileFlows comparison doc: example ab-av1 command
    "input_file.mkv", # FileFlows comparison doc: example ab-av1 command
]

def should_skip(path: Path):
    parts = set(path.parts)
    return bool(parts & SKIP_DIRS)

def is_probably_text(path: Path):
    return path.suffix in TEXT_EXT or path.name in {'Dockerfile','.gitignore','LICENSE'}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('root', type=Path, nargs='?', default=Path('.'))
    args = ap.parse_args()
    root = args.root.resolve()
    findings = []
    for p in root.rglob('*'):
        if p.is_dir() or should_skip(p) or not is_probably_text(p):
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

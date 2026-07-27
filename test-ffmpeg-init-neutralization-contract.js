'use strict';

const assert = require('assert');
const fs = require('fs');

const scriptPath = 'custom-cont-init.d/99-replace-ffmpeg.sh';
const source = fs.readFileSync(scriptPath, 'utf8');
const composeSource = fs.readFileSync('docker-compose.example.yml', 'utf8');
const vendorOverridePath = 'container-overrides/03-setup-ffmpeg';
const vendorOverride = fs.readFileSync(vendorOverridePath, 'utf8');

assert.ok(
  composeSource.includes(
    './container-overrides/03-setup-ffmpeg:/etc/cont-init.d/03-setup-ffmpeg:ro',
  ),
  'Compose must mask the vendor FFmpeg hook before concurrent init runners start',
);
assert.ok(
  vendorOverride.includes('disabled by 99-replace-ffmpeg.sh (custom FFmpeg build)'),
  'vendor FFmpeg bind override lacks the neutralization marker',
);
assert.match(vendorOverride, /\nexit 0\s*$/,
  'vendor FFmpeg bind override must be an inert successful hook');

const recoveryMatch = source.match(
  /^VENDOR_FFMPEG_RECOVERY_DIR="([^"]+)"$/m,
);
assert.ok(recoveryMatch, 'FFmpeg init hook lacks a dedicated recovery directory');
assert.ok(
  !recoveryMatch[1].startsWith('/etc/cont-init.d'),
  'vendor FFmpeg recovery copies must be outside the executable init directory',
);

assert.ok(
  source.includes('for legacy_backup in "${VENDOR_FFMPEG_INIT}.orig-bak-"*; do'),
  'FFmpeg init hook does not handle pre-existing executable .orig-bak-* files',
);
assert.ok(
  source.includes('preserve_vendor_recovery_copy "$legacy_backup" "$backup_name"'),
  'legacy vendor backup is not preserved outside the init directory',
);
assert.ok(
  source.includes('rm -f "$legacy_backup"'),
  'legacy executable vendor backup is not removed after preservation',
);
assert.ok(
  source.includes('install_inert_vendor_stub "$legacy_backup"'),
  'legacy vendor backup lacks an inert fallback when relocation fails',
);
assert.ok(
  !source.includes('"${VENDOR_FFMPEG_INIT}.orig-bak-20260721"'),
  'FFmpeg init hook still creates an executable recovery copy beside the vendor hook',
);

const secureCall = source.indexOf('\nif ! secure_vendor_ffmpeg_init; then');
const customBinaryGate = source.indexOf('\nif [ ! -x "$CUSTOM_FFMPEG" ]; then');
assert.ok(secureCall >= 0, 'FFmpeg init hook does not invoke vendor-init hardening');
assert.ok(customBinaryGate >= 0, 'FFmpeg init hook lacks the custom binary validation gate');
assert.ok(
  secureCall < customBinaryGate,
  'vendor-init hardening must run before any custom binary validation can exit',
);

assert.match(
  source,
  /install_inert_vendor_stub "\$VENDOR_FFMPEG_INIT" \|\| return 1/,
  'active vendor FFmpeg init script is not replaced with the inert stub',
);
assert.match(
  source,
  /executable vendor FFmpeg backup remains active/,
  'FFmpeg init hook lacks a fail-closed postcondition for legacy backups',
);

console.log('PASS vendor FFmpeg init neutralization contract');

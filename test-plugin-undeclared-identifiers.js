'use strict';

/**
 * Regression guard for the "bare read of an args.variables.* name" bug class.
 *
 * This class has reached production twice and failed real jobs closed:
 *   2026-07-25  ReferenceError: expectedReferenceContract is not defined
 *   2026-07-26  ReferenceError: vmafCpuV1ProductionActive is not defined
 *                 (calculateVMAF/1.0.0/index.js:2476, in the end-of-run summary
 *                  log; killed every job that reached the summary)
 *
 * Both had the same shape: a value is published as `args.variables.NAME = local`
 * and later read back as a bare `NAME` identifier that was never declared in the
 * module. Syntax checks (`node --check`) cannot catch it because it is a runtime
 * ReferenceError on a path that only executes near the end of a real job.
 *
 * The check is deliberately narrow so it stays false-positive free without a
 * parser: it only considers identifiers that this same file publishes onto
 * `args.variables`, and only flags them when they are additionally never
 * declared anywhere in the file.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const PLUGIN_ROOT = path.join(__dirname, 'custom-cont-init.d', 'vmaf-plugin-patches');

/** Remove comments and string/template literals so their text is not scanned. */
function stripNonCode(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let state = 'code';
  let quote = '';
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (state === 'code') {
      if (c === '/' && next === '*') { state = 'block'; out += '  '; i += 2; continue; }
      if (c === '/' && next === '/') { state = 'line'; out += '  '; i += 2; continue; }
      if (c === '"' || c === "'" || c === '`') { state = 'string'; quote = c; out += '"'; i += 1; continue; }
      out += c; i += 1; continue;
    }
    if (state === 'block') {
      if (c === '*' && next === '/') { state = 'code'; out += '  '; i += 2; continue; }
      out += (c === '\n' ? '\n' : ' '); i += 1; continue;
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += '\n'; i += 1; continue; }
      out += ' '; i += 1; continue;
    }
    // string
    if (c === '\\') { out += '  '; i += 2; continue; }
    if (c === quote) { state = 'code'; out += '"'; i += 1; continue; }
    out += (c === '\n' ? '\n' : ' '); i += 1; continue;
  }
  return out;
}

/** Every identifier bound anywhere in the file (function-scoped analysis is enough here). */
function declaredNames(code) {
  const declared = new Set();
  let m;

  // var/let/const declarator lists: `var a = 1, b, c = {}`
  const declListRe = /\b(?:var|let|const)\s+([^;\n]*)/g;
  while ((m = declListRe.exec(code))) {
    let depth = 0;
    let current = '';
    const parts = [];
    for (const ch of m[1]) {
      if ('([{'.includes(ch)) depth += 1;
      else if (')]}'.includes(ch)) depth -= 1;
      if (ch === ',' && depth <= 0) { parts.push(current); current = ''; continue; }
      current += ch;
    }
    parts.push(current);
    for (const part of parts) {
      const head = part.split('=')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(head)) declared.add(head);
      // destructuring heads: { a, b: c } / [a, b]
      const inner = head.match(/[A-Za-z_$][\w$]*/g) || [];
      if (/^[[{]/.test(head)) inner.forEach((x) => declared.add(x));
    }
  }

  // function declarations / expressions and their parameter lists
  const fnRe = /\bfunction\s*([A-Za-z_$][\w$]*)?\s*\(([^)]*)\)/g;
  while ((m = fnRe.exec(code))) {
    if (m[1]) declared.add(m[1]);
    (m[2].match(/[A-Za-z_$][\w$]*/g) || []).forEach((x) => declared.add(x));
  }

  // arrow parameter lists
  const arrowParenRe = /\(([^()]*)\)\s*=>/g;
  while ((m = arrowParenRe.exec(code))) {
    (m[1].match(/[A-Za-z_$][\w$]*/g) || []).forEach((x) => declared.add(x));
  }
  const arrowBareRe = /(^|[^.\w$])([A-Za-z_$][\w$]*)\s*=>/g;
  while ((m = arrowBareRe.exec(code))) declared.add(m[2]);

  // catch (err)
  const catchRe = /\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g;
  while ((m = catchRe.exec(code))) declared.add(m[1]);

  // class declarations
  const classRe = /\bclass\s+([A-Za-z_$][\w$]*)/g;
  while ((m = classRe.exec(code))) declared.add(m[1]);

  return declared;
}

/** Names this file publishes onto args.variables. */
function publishedVariableNames(code) {
  const names = new Set();
  const re = /\bargs\s*\.\s*variables\s*\.\s*([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = re.exec(code))) names.add(m[1]);
  return names;
}

/**
 * Is this occurrence an object-literal property key (`{ isHDR: ... }`) rather
 * than a value read? A key is followed by `:` and preceded by `{`, `,`, `(` or
 * nothing. The middle operand of a ternary is also followed by `:` but is
 * preceded by `?`, so it is not excluded here.
 */
function isPropertyKey(line, matchEnd, before) {
  if (!/^\s*:/.test(line.slice(matchEnd))) return false;
  return before === '' || '{,(;'.includes(before);
}

function bareReadLines(code, name) {
  const lines = code.split('\n');
  const hits = [];
  const re = new RegExp('(^|[^.\\w$])' + name + '(?![\\w$])', 'g');
  lines.forEach((line, idx) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(line))) {
      const matchEnd = m.index + m[0].length;
      const beforeText = line.slice(0, m.index + m[1].length).trimEnd();
      const before = beforeText.slice(-1);
      if (isPropertyKey(line, matchEnd, before)) continue;
      hits.push(idx + 1);
      break;
    }
  });
  return hits;
}

function collectPluginFiles(root) {
  const found = [];
  if (!fs.existsSync(root)) return found;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === '_lib') continue;
    const indexPath = path.join(root, entry.name, '1.0.0', 'index.js');
    if (fs.existsSync(indexPath)) found.push(indexPath);
  }
  return found;
}

const pluginFiles = collectPluginFiles(PLUGIN_ROOT);
assert.ok(pluginFiles.length > 0, 'expected to find plugin index.js files under ' + PLUGIN_ROOT);

const violations = [];
for (const file of pluginFiles) {
  const raw = fs.readFileSync(file, 'utf8');
  const code = stripNonCode(raw);
  const declared = declaredNames(code);
  const published = publishedVariableNames(code);

  for (const name of published) {
    if (declared.has(name)) continue;
    // Strip the `args.variables.NAME` occurrences themselves, then look for a
    // remaining bare use of the identifier.
    const withoutQualified = code.replace(
      new RegExp('\\bargs\\s*\\.\\s*variables\\s*\\.\\s*' + name + '(?![\\w$])', 'g'),
      ' '.repeat(8),
    );
    const hits = bareReadLines(withoutQualified, name);
    if (hits.length > 0) {
      violations.push(
        path.relative(__dirname, file) + ': bare `' + name + '` at line(s) ' +
        hits.join(', ') + ' is published as args.variables.' + name +
        ' but never declared locally (ReferenceError at runtime)',
      );
    }
  }
}

if (violations.length > 0) {
  console.error('Undeclared args.variables reads detected:');
  violations.forEach((v) => console.error('  - ' + v));
}
assert.deepStrictEqual(violations, [],
  'plugin index.js files must not read args.variables.* names as bare identifiers');

// Guard the guard: the detector must actually fire on the real 2026-07-26 shape.
const fixture = [
  'var plugin = async function (args) {',
  '  var cpuV1ProductionEnabled = resolve(args);',
  '  args.variables.vmafCpuV1ProductionActive = cpuV1ProductionEnabled;',
  "  args.jobLog('mode: ' + (vmafCpuV1ProductionActive ? 'production' : 'qualification'));",
  '};',
].join('\n');
const fixtureCode = stripNonCode(fixture);
const fixtureDeclared = declaredNames(fixtureCode);
assert.ok(!fixtureDeclared.has('vmafCpuV1ProductionActive'),
  'fixture identifier must be undeclared for the guard to be meaningful');
const fixtureStripped = fixtureCode.replace(
  /\bargs\s*\.\s*variables\s*\.\s*vmafCpuV1ProductionActive(?![\w$])/g, '        ');
assert.ok(bareReadLines(fixtureStripped, 'vmafCpuV1ProductionActive').length === 1,
  'detector must flag the historical vmafCpuV1ProductionActive regression');

// And must not fire when the same value is read through args.variables.
const okFixture = [
  'var plugin = async function (args) {',
  '  var enabled = resolve(args);',
  '  args.variables.vmafCpuV1ProductionActive = enabled;',
  "  args.jobLog('mode: ' + (args.variables.vmafCpuV1ProductionActive ? 'a' : 'b'));",
  '};',
].join('\n');
const okCode = stripNonCode(okFixture).replace(
  /\bargs\s*\.\s*variables\s*\.\s*vmafCpuV1ProductionActive(?![\w$])/g, '        ');
assert.strictEqual(bareReadLines(okCode, 'vmafCpuV1ProductionActive').length, 0,
  'detector must not flag qualified args.variables reads');

console.log('PASS plugin index.js files have no bare args.variables.* reads (' +
  pluginFiles.length + ' plugin(s) scanned)');

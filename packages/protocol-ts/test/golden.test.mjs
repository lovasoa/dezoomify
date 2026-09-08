import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const generated = readFileSync(join(root, 'src/generated.ts'), 'utf8');

test('generated marker and version agree', () => {
  assert.match(generated, /DO NOT EDIT/);
  assert.match(generated, /PROTOCOL_VERSION = "2\.0"/);
});

test('single limit/grid/capability generation is pinned', () => {
  assert.match(generated, /MAX_BROWSER_AREA = 268435456/);
  assert.match(generated, /PROXY_MAX_BYTES = 2097152/);
  assert.match(generated, /METADATA_WINDOW_MS = 1500/);
  const gridIds = [...generated.matchAll(/\{\s*id:\s*"([^"]+)",\s*displayName:\s*"([^"]+)",\s*powerUser:\s*(true|false)\s*\}/g)];
  assert.equal(gridIds.length, 19);
  const ids = gridIds.map((m) => m[1]);
  assert.deepEqual(ids, [
    'custom',
    'google_arts_and_culture',
    'zoomify',
    'gigapan',
    'iiif',
    'deepzoom',
    'generic',
    'krpano',
    'iipimage',
    'xlimage',
    'topviewer',
    'fsi',
    'lizardtech',
    'vls',
    'hungaricana',
    'wmts',
    'arcgis',
    'pnav',
    'bulk_text',
  ]);
  const byId = Object.fromEntries(gridIds.map((m) => [m[1], { displayName: m[2], powerUser: m[3] === 'true' }]));
  assert.equal(byId.custom.powerUser, true);
  assert.equal(byId.bulk_text.powerUser, true);
  assert.equal(byId.zoomify.powerUser, false);
  assert.equal(byId.custom.displayName, 'Custom tiles');
  assert.equal(byId.bulk_text.displayName, 'Bulk text');
});

test('transport labels stay single-sourced with browser-runtime transport-labels.ts', () => {
  const labels = readFileSync(join(root, '..', 'browser-runtime', 'src', 'transport-labels.ts'), 'utf8');
  const direct = labels.match(/DIRECT_TRANSPORT_LABEL\s*=\s*"([^"]+)"/)?.[1];
  const proxy = labels.match(/PROXY_TRANSPORT_LABEL\s*=\s*"([^"]+)"/)?.[1];
  assert.equal(direct, 'Direct from your browser');
  assert.equal(proxy, 'Metadata proxy');
  assert.ok(generated.includes(`DIRECT_TRANSPORT_LABEL = "${direct}"`));
  assert.ok(generated.includes(`PROXY_TRANSPORT_LABEL = "${proxy}"`));
});

test('format grid mirrors registry.rs BUILTINS snapshot', () => {
  const registry = readFileSync(join(root, '..', '..', 'crates', 'dezoomify-core', 'src', 'core', 'registry.rs'), 'utf8');
  for (const id of ['custom', 'google_arts_and_culture', 'zoomify', 'bulk_text']) {
    assert.ok(registry.includes(id), `registry lacks ${id}`);
  }
  assert.ok(registry.includes('"Custom tiles"'));
  assert.ok(registry.includes('"Bulk text"'));
});

test('golden vectors decode with protocol 2.0', () => {
  const dir = join(root, '..', '..', 'testdata', 'scenarios', 'protocol-v2');
  const ids = readdirSync(dir).sort();
  assert.deepEqual(ids, ['error-terminal', 'handshake-ok']);
  for (const id of ids) {
    const raw = readFileSync(join(dir, id, 'expected', 'canonical.json'), 'utf8');
    assert.ok(raw.endsWith('\n'), `${id} lacks trailing LF`);
    const value = JSON.parse(raw);
    assert.equal(value.protocol, '2.0', `${id} version`);
    assert.ok(typeof value.kind === 'string', `${id} kind`);
    assertVectorSemantics(id, value);
  }
});

// Mirrors Rust crates/dezoomify-protocol/tests/golden.rs assert_vector_semantics:
// canonical round-tripping alone would accept a drifted vector, so pin what
// each vector means (start/fetch.failed + terminal kinds).
function assertVectorSemantics(id, value) {
  if (id === 'handshake-ok') {
    assert.equal(value.kind, 'command', `${id} kind`);
    assert.equal(value.type, 'start', `${id} type`);
    assert.equal(value.input_url, 'https://example.com/item/1', `${id} input_url`);
  } else if (id === 'error-terminal') {
    assert.equal(value.kind, 'event', `${id} kind`);
    assert.equal(value.type, 'failed', `${id} type`);
    assert.equal(value.error?.code, 'fetch.failed', `${id} error code`);
    assert.ok(
      ['completed', 'partial-completed', 'failed', 'cancelled'].includes(value.type),
      `${id} must be a terminal kind`,
    );
  } else {
    assert.fail(`unexpected vector ${id}`);
  }
}

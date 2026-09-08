import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const generated = readFileSync(join(root, 'src/generated.ts'), 'utf8');
const fingerprints = JSON.parse(readFileSync(join(root, 'fingerprints.json'), 'utf8'));

test('generated marker and fingerprint agree', () => {
  assert.match(generated, /DO NOT EDIT/);
  assert.match(generated, new RegExp(fingerprints.dto));
  assert.match(generated, /PROTOCOL_VERSION = "1\.0"/);
  assert.match(generated, new RegExp(fingerprints.limits));
  assert.match(generated, /LIMITS_FINGERPRINT = "[0-9a-f]{16}"/);
});

test('single limit/grid/capability generation is pinned', () => {
  assert.match(generated, /MAX_BROWSER_AREA = 268435456/);
  assert.match(generated, /NATIVE_MAX_BYTES = 8589934592/);
  assert.match(generated, /PROXY_MAX_BYTES = 2097152/);
  assert.match(generated, /METADATA_WINDOW_MS = 1500/);
  assert.equal(fingerprints.protocol, '1.0');
  assert.match(fingerprints.limits, /^[0-9a-f]{16}$/);
  assert.ok(generated.includes(`LIMITS_FINGERPRINT = "${fingerprints.limits}"`));
  const gridIds = [...generated.matchAll(/\{\s*id:\s*"([^"]+)",\s*displayName:\s*"([^"]+)",\s*powerUser:\s*(true|false)\s*\}/g)];
  assert.equal(gridIds.length, 18);
  const ids = gridIds.map((m) => m[1]);
  assert.deepEqual(ids, [
    'custom',
    'google_arts_and_culture',
    'zoomify',
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

test('golden vectors decode with protocol 1.0', () => {
  const dir = join(root, '..', '..', 'testdata', 'scenarios', 'protocol-v1');
  const ids = readdirSync(dir).sort();
  assert.deepEqual(ids, ['error-terminal', 'handoff-ok', 'handshake-ok']);
  for (const id of ids) {
    const raw = readFileSync(join(dir, id, 'expected', 'canonical.json'), 'utf8');
    assert.ok(raw.endsWith('\n'), `${id} lacks trailing LF`);
    const value = JSON.parse(raw);
    assert.equal(value.protocol, '1.0', `${id} version`);
    assert.ok(typeof value.kind === 'string', `${id} kind`);
    assertVectorSemantics(id, value);
  }
});

// Mirrors Rust crates/dezoomify-protocol/tests/golden.rs assert_vector_semantics:
// canonical round-tripping alone would accept a drifted vector, so pin what
// each vector means (job/hand/fetch.failed + terminal kinds).
function assertVectorSemantics(id, value) {
  if (id === 'handshake-ok') {
    assert.equal(value.kind, 'command', `${id} kind`);
    assert.equal(value.type, 'start', `${id} type`);
    assert.equal(value.job, 'job:golden-1', `${id} job`);
    assert.equal(value.input_url, 'https://example.com/item/1', `${id} input_url`);
  } else if (id === 'handoff-ok') {
    assert.equal(value.kind, 'handoff', `${id} kind`);
    assert.equal(value.id, 'hand:golden-1', `${id} id`);
    assert.equal(value.source_url, 'https://example.com/item/1', `${id} source_url`);
    assert.equal(value.provenance_label, 'web', `${id} provenance_label`);
    assert.deepEqual(value.required_capabilities, ['direct'], `${id} capabilities`);
  } else if (id === 'error-terminal') {
    assert.equal(value.kind, 'event', `${id} kind`);
    assert.equal(value.type, 'failed', `${id} type`);
    assert.equal(value.job, 'job:golden-1', `${id} job`);
    assert.equal(value.error?.code, 'fetch.failed', `${id} error code`);
    assert.ok(
      ['completed', 'partial-completed', 'failed', 'cancelled'].includes(value.type),
      `${id} must be a terminal kind`,
    );
  } else {
    assert.fail(`unexpected vector ${id}`);
  }
}

test('schemas are draft-07 objects', () => {
  for (const name of ['schema/protocol-v1.schema.json', 'schema/capabilities-v1.schema.json']) {
    const schema = JSON.parse(readFileSync(join(root, name), 'utf8'));
    assert.equal(schema.type, 'object');
  }
});

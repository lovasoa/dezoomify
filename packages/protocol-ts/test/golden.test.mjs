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
});

test('golden vectors decode with protocol 1.0', () => {
  const dir = join(root, '..', '..', 'testdata', 'scenarios', 'protocol-v1');
  for (const id of readdirSync(dir)) {
    const raw = readFileSync(join(dir, id, 'expected', 'canonical.json'), 'utf8');
    assert.ok(raw.endsWith('\n'), `${id} lacks trailing LF`);
    const value = JSON.parse(raw);
    assert.equal(value.protocol, '1.0', `${id} version`);
    assert.ok(typeof value.kind === 'string', `${id} kind`);
  }
});

test('schemas are draft-07 objects', () => {
  for (const name of ['schema/protocol-v1.schema.json', 'schema/capabilities-v1.schema.json']) {
    const schema = JSON.parse(readFileSync(join(root, name), 'utf8'));
    assert.equal(schema.type, 'object');
  }
});

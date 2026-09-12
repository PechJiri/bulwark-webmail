import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { URL } from 'node:url';

const production = fs.readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
const integration = fs.readFileSync(new URL('../integration/webmail.Dockerfile', import.meta.url), 'utf8');
const expected =
  'node:24.21.0-alpine@sha256:be80f76cf40ec8e42b9bec49f60a55e0660f30af58d3e5a25530785b30ea67e2';

test('production and integration builds use the reviewed immutable Node base', () => {
  const productionBases = [...production.matchAll(/^FROM (\S+)/gm)].map((match) => match[1]);
  const integrationBases = [...integration.matchAll(/^FROM (\S+)/gm)].map((match) => match[1]);

  assert.deepEqual(productionBases, [expected, expected]);
  assert.deepEqual(integrationBases, [expected]);
});

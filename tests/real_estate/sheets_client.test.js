import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createSheetsClient, resolveSheetsKeyPath } from '../../src/real_estate/sheets_client.js';
import { _clearTokenCacheForTests } from '../../src/lib/google_auth.js';

test('resolveSheetsKeyPath: RE_SHEETS_KEY_JSON 값을 그대로 사용, 없으면 null', () => {
  assert.equal(resolveSheetsKeyPath({ RE_SHEETS_KEY_JSON: '/a' }), '/a');
  assert.equal(resolveSheetsKeyPath({}), null);
});

async function makeKeyFile() {
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 're-sheets-'));
  const keyPath = path.join(dir, 'sa.json');
  await fs.writeFile(keyPath, JSON.stringify({
    client_email: 'test-sa@example.iam.gserviceaccount.com',
    private_key: privateKey,
    token_uri: 'https://oauth2.googleapis.com/token',
  }));
  return keyPath;
}

test('createSheetsClient: 키 경로 없으면 명확한 에러', () => {
  const saved = process.env.RE_SHEETS_KEY_JSON;
  delete process.env.RE_SHEETS_KEY_JSON;
  try {
    assert.throws(() => createSheetsClient({}), /RE_SHEETS_KEY_JSON/);
  } finally {
    if (saved) process.env.RE_SHEETS_KEY_JSON = saved;
  }
});

test('batchGet/batchUpdate: OAuth 교환 + REST 호출 (전체 offline mock)', async () => {
  _clearTokenCacheForTests();
  const keyPath = await makeKeyFile();
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('oauth2.googleapis.com')) {
      // JWT assertion 이 scope=spreadsheets 로 서명됐는지 확인
      const params = new URLSearchParams(init.body);
      const claim = JSON.parse(Buffer.from(params.get('assertion').split('.')[1], 'base64url').toString());
      assert.ok(claim.scope.includes('auth/spreadsheets'));
      return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'tok-1', expires_in: 3600 }) };
    }
    if (String(url).includes('values:batchGet')) {
      assert.equal(init.headers.authorization, 'Bearer tok-1');
      return { ok: true, status: 200, text: async () => JSON.stringify({ valueRanges: [{ range: 'x', values: [['a']] }] }) };
    }
    if (String(url).includes('values:batchUpdate')) {
      const body = JSON.parse(init.body);
      assert.equal(body.valueInputOption, 'USER_ENTERED');
      assert.equal(body.data.length, 1);
      return { ok: true, status: 200, text: async () => JSON.stringify({ totalUpdatedCells: 2 }) };
    }
    throw new Error(`unexpected url: ${url}`);
  };

  const client = createSheetsClient({ keyJsonPath: keyPath, fetchImpl, logger: { log() {} } });
  const ranges = await client.batchGet('sheet-1', ["'가양동'!A1:W400"]);
  assert.equal(ranges.length, 1);
  assert.ok(calls.some((c) => decodeURIComponent(c.url.replaceAll('+', ' ')).includes("'가양동'!A1:W400")));

  const res = await client.batchUpdate('sheet-1', [{ range: "'가양동'!I5:J5", values: [[48000, '3']] }]);
  assert.equal(res.totalUpdatedCells, 2);
});

test('batchUpdate: 빈 data 는 API 호출 없이 0 반환', async () => {
  const keyPath = await makeKeyFile();
  const client = createSheetsClient({
    keyJsonPath: keyPath,
    fetchImpl: async () => { throw new Error('호출되면 안 됨'); },
    logger: { log() {} },
  });
  const res = await client.batchUpdate('sheet-1', []);
  assert.equal(res.totalUpdatedCells, 0);
});

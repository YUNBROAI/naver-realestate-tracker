import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  resolveConfig,
  computePriceStats,
  isAnomalous,
  buildUpdateEntries,
  runPriceUpdate,
} from '../../src/real_estate/price_updater.js';

const art = (over = {}) => ({
  articleNo: '1', name: 'x', tradeType: 'A1', priceManwon: 50000,
  floor: '5', supplyArea: 75, confirmedDate: '26.07.01', ...over,
});

// ─── dry-run 3중 폴백 ────────────────────────────────────────────────────────
test('resolveConfig: 디폴트 dry-run (RE_DRY_RUN 미설정)', () => {
  const cfg = resolveConfig({ env: { RE_SHEETS_KEY_JSON: '/tmp/key.json' }, argv: [] });
  assert.equal(cfg.dryRun, true);
  assert.ok(cfg.dryRunReasons.includes('RE_DRY_RUN!=0'));
});

test('resolveConfig: RE_DRY_RUN=0 + 키 존재 → 실쓰기', () => {
  const cfg = resolveConfig({ env: { RE_DRY_RUN: '0', RE_SHEETS_KEY_JSON: '/tmp/key.json' }, argv: [] });
  assert.equal(cfg.dryRun, false);
});

test('resolveConfig: RE_DRY_RUN=0 이어도 --dry 또는 키 누락이면 dry-run (OR)', () => {
  assert.equal(resolveConfig({ env: { RE_DRY_RUN: '0', RE_SHEETS_KEY_JSON: '/k' }, argv: ['--dry'] }).dryRun, true);
  assert.equal(resolveConfig({ env: { RE_DRY_RUN: '0' }, argv: [] }).dryRun, true);
});

test('resolveConfig: --dong 은 단일 시트, RE_TARGET_SHEETS 오버라이드', () => {
  assert.deepEqual(resolveConfig({ env: {}, argv: ['--dong', '가양동'] }).targetSheets, ['가양동']);
  assert.deepEqual(resolveConfig({ env: { RE_TARGET_SHEETS: '가양동, 마곡동' }, argv: [] }).targetSheets, ['가양동', '마곡동']);
  assert.equal(resolveConfig({ env: {}, argv: [] }).targetSheets.length, 8);
});

// ─── 가격 계산 ───────────────────────────────────────────────────────────────
test('computePriceStats: 평형 필터 후 매매 min / 전세 max', () => {
  const articles = [
    art({ articleNo: '1', priceManwon: 52000 }),
    art({ articleNo: '2', priceManwon: 48000, floor: '3' }),
    art({ articleNo: '3', priceManwon: 40000, supplyArea: 106 }), // 평형 밖
    art({ articleNo: '4', tradeType: 'B1', priceManwon: 38000 }),
    art({ articleNo: '5', tradeType: 'B1', priceManwon: 42000, floor: '10' }),
  ];
  const s = computePriceStats(articles, { areaMin: 72, areaMax: 78 });
  assert.equal(s.saleMin.priceManwon, 48000);
  assert.equal(s.saleMin.floor, '3');
  assert.equal(s.jeonseMax.priceManwon, 42000);
  assert.equal(s.jeonseMax.floor, '10');
  assert.equal(s.saleCount, 2);
  assert.equal(s.jeonseCount, 2);
});

test('computePriceStats: 동률이면 확인일자 최신 우선', () => {
  const s = computePriceStats([
    art({ articleNo: '1', priceManwon: 48000, confirmedDate: '26.07.01' }),
    art({ articleNo: '2', priceManwon: 48000, confirmedDate: '26.07.15' }),
  ], { areaMin: 72, areaMax: 78 });
  assert.equal(s.saleMin.articleNo, '2');
});

test('computePriceStats: 매물 없으면 null', () => {
  const s = computePriceStats([], { areaMin: 72, areaMax: 78 });
  assert.equal(s.saleMin, null);
  assert.equal(s.jeonseMax, null);
});

test('isAnomalous: ±30% 초과만 true, 기존값 없으면 false', () => {
  assert.equal(isAnomalous(50000, 66000), true);
  assert.equal(isAnomalous(50000, 60000), false);
  assert.equal(isAnomalous(null, 60000), false);
  assert.equal(isAnomalous(50000, null), false);
});

// ─── 업데이트 항목 ───────────────────────────────────────────────────────────
const COLS = { salePrice: 8, saleFloor: 9, jeonsePrice: 10, jeonseFloor: 11 };

test('buildUpdateEntries: 매매/전세 각각 2셀 range', () => {
  const target = { sheetName: '가양동', rowIndex: 5 };
  const entries = buildUpdateEntries(target, COLS, {
    saleMin: { priceManwon: 48000, floor: '3' },
    jeonseMax: { priceManwon: 42000, floor: '10' },
  });
  assert.deepEqual(entries, [
    { range: "'가양동'!I5:J5", values: [[48000, '3']] },
    { range: "'가양동'!K5:L5", values: [[42000, '10']] },
  ]);
});

test('buildUpdateEntries: 매물 없는 쪽은 기존 셀 유지 (항목 없음)', () => {
  const entries = buildUpdateEntries({ sheetName: '가양동', rowIndex: 5 }, COLS, {
    saleMin: null,
    jeonseMax: { priceManwon: 42000, floor: null },
  });
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].values, [[42000, '']]);
});

// ─── 통합 (mock sheets + mock fetch) ────────────────────────────────────────
function sheetRows() {
  return [
    ['단지명', '입주 연도', '총세 대수', '공급 (m2)', '공급 면적', '전용 (m2)', '전용 면적', '세대',
      '매매 최저가', '층', '전세 최고가', '층', '매전갭', '전세 가율', '매매 평단', '전세 평단',
      '방', '욕 실', '구 조', 'Type', '비고', '링크'],
    ['한보구암마을', '', '', '74.8', '', '', '', '',
      '45000', '12', '38000', '3', '', '', '', '', '', '', '', '', '',
      'https://new.land.naver.com/complexes/1309?h=72&i=78'],
  ];
}

test('runPriceUpdate: dry-run 통합 — 쓰기 없이 스냅샷 생성', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 're-test-'));
  const prevCwd = process.cwd();
  process.chdir(tmp);
  t.after(() => process.chdir(prevCwd));

  const batchUpdates = [];
  const sheetsClient = {
    async batchGet() { return [{ values: sheetRows() }]; },
    async batchUpdate(id, data) { batchUpdates.push(data); return { totalUpdatedCells: 4 }; },
  };
  const fetchArticlesImpl = async ({ tradeType }) => (tradeType === 'A1'
    ? [art({ articleNo: 's1', priceManwon: 43000, floor: '7' })]
    : [art({ articleNo: 'j1', tradeType: 'B1', priceManwon: 39000, floor: '2' })]);

  const logs = { info() {}, ok() {}, warn() {}, error() {} };
  const summary = await runPriceUpdate({
    env: { RE_SHEET_ID: 'sheet-1', RE_REQUEST_DELAY_MS: '0' },
    argv: ['--dong', '가양동'],
    sheetsClient,
    fetchArticlesImpl,
    logger: logs,
  });

  assert.equal(summary.dryRun, true);
  assert.equal(summary.targets, 1);
  assert.equal(summary.ok, 1);
  assert.equal(batchUpdates.length, 0); // dry-run — 쓰기 호출 없음

  const snap = JSON.parse(await fs.readFile(summary.snapshotPath, 'utf8'));
  assert.equal(snap.entries.length, 1);
  assert.equal(snap.entries[0].sale.price, 43000);
  assert.equal(snap.entries[0].jeonse.price, 39000);
  assert.equal(snap.entries[0].prev.salePrice, 45000);
});

test('runPriceUpdate: 실쓰기 모드 — I/J/K/L range 만 batchUpdate', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 're-test-'));
  const prevCwd = process.cwd();
  process.chdir(tmp);
  t.after(() => process.chdir(prevCwd));

  const batchUpdates = [];
  const sheetsClient = {
    async batchGet() { return [{ values: sheetRows() }]; },
    async batchUpdate(id, data) { batchUpdates.push(...data); return { totalUpdatedCells: 4 }; },
  };
  const fetchArticlesImpl = async ({ tradeType }) => (tradeType === 'A1'
    ? [art({ articleNo: 's1', priceManwon: 43000, floor: '7' })]
    : [art({ articleNo: 'j1', tradeType: 'B1', priceManwon: 39000, floor: '2' })]);

  const summary = await runPriceUpdate({
    env: { RE_SHEET_ID: 'sheet-1', RE_DRY_RUN: '0', RE_SHEETS_KEY_JSON: '/k', RE_REQUEST_DELAY_MS: '0' },
    argv: ['--dong', '가양동'],
    sheetsClient,
    fetchArticlesImpl,
    logger: { info() {}, ok() {}, warn() {}, error() {} },
  });

  assert.equal(summary.dryRun, false);
  assert.equal(summary.updatedCells, 4);
  assert.deepEqual(batchUpdates.map((u) => u.range), ["'가양동'!I2:J2", "'가양동'!K2:L2"]);
});

test('runPriceUpdate: 단지 조회 실패 시 해당 행 failed, 시트 미손상', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 're-test-'));
  const prevCwd = process.cwd();
  process.chdir(tmp);
  t.after(() => process.chdir(prevCwd));

  const sheetsClient = {
    async batchGet() { return [{ values: sheetRows() }]; },
    async batchUpdate() { throw new Error('호출되면 안 됨'); },
  };
  const summary = await runPriceUpdate({
    env: { RE_SHEET_ID: 'sheet-1', RE_DRY_RUN: '0', RE_SHEETS_KEY_JSON: '/k', RE_REQUEST_DELAY_MS: '0' },
    argv: ['--dong', '가양동'],
    sheetsClient,
    fetchArticlesImpl: async () => { throw new Error('blocked'); },
    logger: { info() {}, ok() {}, warn() {}, error() {} },
  });
  assert.equal(summary.failed, 1);
  assert.equal(summary.ok, 0);
  assert.equal(summary.updatedCells, 0);
});

test('runPriceUpdate: 연속 실패 임계(차단 의심) 도달해도 스냅샷 저장 + 정상 종료', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 're-guard-'));
  const prevCwd = process.cwd();
  process.chdir(tmp);
  t.after(() => process.chdir(prevCwd));

  // 서로 다른 단지 6개 → 전부 실패 → 5번째에서 failure guard 발동
  const rows = [
    ['단지명', '공급 (m2)', '', '', '', '', '', '', '매매 최저가', '층', '전세 최고가', '층',
      '', '', '', '', '', '', '', '', '', '링크'],
    ...[1, 2, 3, 4, 5, 6].map((n) => [
      `단지${n}`, '74.8', '', '', '', '', '', '', '', '', '', '',
      '', '', '', '', '', '', '', '', '', `https://new.land.naver.com/complexes/${n}?h=72&i=78`,
    ]),
  ];
  const sheetsClient = {
    async batchGet() { return [{ values: rows }]; },
    async batchUpdate() { throw new Error('호출되면 안 됨'); },
  };
  const summary = await runPriceUpdate({
    env: { RE_SHEET_ID: 's', RE_REQUEST_DELAY_MS: '0' },
    argv: ['--dong', '가양동'],
    sheetsClient,
    fetchArticlesImpl: async () => { throw new Error('blocked'); },
    logger: { info() {}, ok() {}, warn() {}, error() {} },
  });
  assert.equal(summary.failed, 6);
  assert.equal(summary.ok, 0);
  const snap = JSON.parse(await fs.readFile(summary.snapshotPath, 'utf8'));
  assert.equal(snap.entries.length, 6);
  assert.ok(snap.entries.every((e) => e.status === 'failed'));
});

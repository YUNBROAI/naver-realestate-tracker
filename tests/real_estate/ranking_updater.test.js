import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseSalePriceCell,
  extractDongEntries,
  buildRankingRows,
  RANKING_HEADERS,
  updateRankingTab,
} from '../../src/real_estate/ranking_updater.js';

// ─── 셀 파서 ─────────────────────────────────────────────────────────────────
test('parseSalePriceCell: 숫자/문자/콤마/빈값', () => {
  assert.equal(parseSalePriceCell(95000), 95000);
  assert.equal(parseSalePriceCell('95,000'), 95000);
  assert.equal(parseSalePriceCell(' 95000 '), 95000);
  assert.equal(parseSalePriceCell(''), null);
  assert.equal(parseSalePriceCell(null), null);
  assert.equal(parseSalePriceCell(0), null); // 0 = 매물 없음
  assert.equal(parseSalePriceCell('가격문의'), null);
});

// ─── extractDongEntries — 실제 시트 헤더 구조 ────────────────────────────────
function buildRealisticRows() {
  // R1~R2 는 서브타이틀/날짜 (헤더 아님), R3 헤더, R4 동 이름 서브헤더, R5 이후 데이터.
  return [
    ['서울시 송파구'],
    ['2026년 7월 20일'],
    ['단지명','입주\n연도','총세\n대수','공급\n(m2)','공급\n면적','전용\n(m2)','전용\n면적','세대',
     '매매\n최저가','층','전세\n최고가','층','매전갭','전세\n가율','매매\n평단','전세\n평단',
     '방','욕\n실','구\n조','매/전/월\nType','비고','링크'],
    ['가락동'], // 동 이름 서브헤더 (링크 없음, 매매가 없음 → 스킵)
    [], // 빈 행
    ['래미안파크팰리스',"'07.11",'919','86.4','26','60.0','18','194',
     95000,16,'(95,000)',null,'@0','@3,654',null,null,'3','2','계','86','',
     'https://new.land.naver.com/complexes/22809?h=83&i=89'],
    ['가락쌍용스윗닷홈3차',"'01.05",'554','83.0','25','64.9','20','120',
     45000,'저','23,000','저','22,000','51%','@1,800','@920','3','2','계','86','',
     'https://new.land.naver.com/complexes/12948?h=80&i=86'],
    ['빈매물단지',"'02.10",'100','60','18','50','15','100',
     null,null,null,null,null,null,null,null,'2','1','계','86','','https://new.land.naver.com/complexes/99999'],
  ];
}

test('extractDongEntries: 매매가 있는 행만 추출, A~T 20 컬럼 payload', () => {
  const entries = extractDongEntries('가락동', buildRealisticRows());
  assert.equal(entries.length, 2); // 매매가 없는 서브헤더/빈행/빈매물단지 제외
  const first = entries[0];
  assert.equal(first.sheetName, '가락동');
  assert.equal(first.salePrice, 95000);
  assert.equal(first.payload.length, 20);
  assert.equal(first.payload[0], '래미안파크팰리스');
  assert.equal(first.payload[8], 95000); // I 컬럼
  assert.equal(first.payload[9], 16);    // J 컬럼 (매매층)
});

test('extractDongEntries: 헤더 없는 시트는 빈 배열', () => {
  assert.deepEqual(extractDongEntries('가락동', []), []);
  assert.deepEqual(extractDongEntries('가락동', [['title'], ['nothing']]), []);
});

// ─── buildRankingRows — 정렬 + 순위 + 헤더 ───────────────────────────────────
test('buildRankingRows: 매매가 내림차순 + 순위 번호 + 헤더 행', () => {
  const entriesByDong = [
    { sheetName: '가락동', entries: [
      { salePrice: 45000, payload: ['가락쌍용', ...Array(19).fill('')] },
      { salePrice: 95000, payload: ['래미안파크팰리스', ...Array(19).fill('')] },
    ]},
    { sheetName: '잠실동', entries: [
      { salePrice: 200000, payload: ['잠실주공', ...Array(19).fill('')] },
    ]},
  ];
  const rows = buildRankingRows(entriesByDong);
  assert.deepEqual(rows[0], RANKING_HEADERS.slice()); // 헤더 행
  assert.equal(rows.length, 4); // 헤더 + 3
  assert.equal(rows[1][0], 1); // 순위 1
  assert.equal(rows[1][1], '잠실동');
  assert.equal(rows[1][2], '잠실주공');
  assert.equal(rows[2][2], '래미안파크팰리스');
  assert.equal(rows[3][2], '가락쌍용');
});

test('buildRankingRows: 동률 시 전세최고가 내림차순 tie-break', () => {
  const mk = (name, sale, jeonse) => ({
    salePrice: sale,
    payload: [name, '','','','','','','',sale,'',jeonse, ...Array(9).fill('')],
  });
  const entriesByDong = [
    { sheetName: '가락동', entries: [
      mk('A', 100000, 50000),
      mk('B', 100000, 60000), // 동률이지만 전세 더 높음
    ]},
  ];
  const rows = buildRankingRows(entriesByDong);
  assert.equal(rows[1][2], 'B'); // 전세 높은 게 먼저
  assert.equal(rows[2][2], 'A');
});

// ─── updateRankingTab — 오케스트레이션 (mock client) ─────────────────────────
function makeMockClient({ existingTabs = [], batchGetResult } = {}) {
  const calls = [];
  return {
    calls,
    async batchGet(id, ranges) {
      calls.push({ op: 'batchGet', id, ranges });
      return batchGetResult ?? ranges.map(() => ({ values: [] }));
    },
    async getSpreadsheetMeta(id, fields) {
      calls.push({ op: 'meta', id, fields });
      return { sheets: existingTabs.map((t) => ({ properties: { title: t, sheetId: t.length } })) };
    },
    async addSheetTab(id, title) {
      calls.push({ op: 'addSheet', id, title });
      return { sheetId: 999, title };
    },
    async clearValues(id, range) {
      calls.push({ op: 'clear', id, range });
    },
    async updateValues(id, range, values) {
      calls.push({ op: 'update', id, range, values });
      return { updatedCells: values.length * (values[0]?.length ?? 0) };
    },
    async batchUpdateSpreadsheet(id, requests) {
      calls.push({ op: 'format', id, requestCount: requests.length });
      return { replies: [] };
    },
  };
}

test('updateRankingTab: 순위 탭 없으면 addSheet 호출', async () => {
  const rows = buildRealisticRows();
  const client = makeMockClient({
    existingTabs: ['가락동', '잠실동'], // '순위' 없음
    batchGetResult: [{ values: rows }, { values: rows }],
  });
  const res = await updateRankingTab({
    client, sheetId: 'SID',
    dongTabs: ['가락동', '잠실동'],
    logger: { info: () => {}, ok: () => {}, warn: () => {}, error: () => {} },
  });
  const ops = client.calls.map((c) => c.op);
  assert.deepEqual(ops, ['batchGet', 'meta', 'addSheet', 'clear', 'update', 'format']);
  assert.equal(res.rows, 4); // 각 동에서 2건씩 (bulding 2 dongs * 2 entries)
  assert.equal(res.skipped, false);
  const formatCall = client.calls.find((c) => c.op === 'format');
  assert.ok(formatCall.requestCount >= 5, '서식 요청 5건 이상 (freeze/header/height/numbers/autoresize)');
});

test('updateRankingTab: 순위 탭 이미 있으면 addSheet 스킵', async () => {
  const rows = buildRealisticRows();
  const client = makeMockClient({
    existingTabs: ['가락동', '순위'],
    batchGetResult: [{ values: rows }],
  });
  await updateRankingTab({
    client, sheetId: 'SID', dongTabs: ['가락동'],
    logger: { info: () => {}, ok: () => {}, warn: () => {}, error: () => {} },
  });
  const ops = client.calls.map((c) => c.op);
  assert.deepEqual(ops, ['batchGet', 'meta', 'clear', 'update', 'format']);
});

test('updateRankingTab: 매물 0건이면 skipped=true', async () => {
  const client = makeMockClient({
    existingTabs: ['가락동'],
    batchGetResult: [{ values: [] }],
  });
  const res = await updateRankingTab({
    client, sheetId: 'SID', dongTabs: ['가락동'],
    logger: { info: () => {}, ok: () => {}, warn: () => {}, error: () => {} },
  });
  assert.equal(res.skipped, true);
  assert.equal(res.rows, 0);
});

test('updateRankingTab: dryRun 시 addSheet/clear/update 호출 없음', async () => {
  const rows = buildRealisticRows();
  const client = makeMockClient({
    existingTabs: ['가락동'],
    batchGetResult: [{ values: rows }],
  });
  const res = await updateRankingTab({
    client, sheetId: 'SID', dongTabs: ['가락동'], dryRun: true,
    logger: { info: () => {}, ok: () => {}, warn: () => {}, error: () => {} },
  });
  const ops = client.calls.map((c) => c.op);
  assert.deepEqual(ops, ['batchGet']); // meta 조회도 안 함
  assert.equal(res.dryRun, true);
  assert.equal(res.rows, 2);
});

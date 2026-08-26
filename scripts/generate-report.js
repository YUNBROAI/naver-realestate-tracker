#!/usr/bin/env node
// 부동산 시세 자동화 — '순위' 탭 → React 임장보고서(App.jsx) 생성 CLI
// 사용: RE_SHEET_ID=<id> npm run realestate:report -- --out <경로>
//       npm run realestate:report -- --sheet-id <id> --tab 순위 --title "경기도 의왕시" --out <경로>
// 시세 갱신은 하지 않는다 — 이미 채워진 '순위' 탭을 읽어 대시보드만 새로 만든다.
// 최신 시세를 원하면 먼저 `npm run realestate:update` 로 순위 탭부터 갱신할 것.

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { createSheetsClient } from '../src/real_estate/sheets_client.js';
import { buildApartments, assignDongColors, renderAppJsx } from '../src/real_estate/report_generator.js';

function getArg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
}

async function main() {
  const argv = process.argv.slice(2);
  const sheetId = getArg(argv, '--sheet-id') ?? process.env.RE_SHEET_ID;
  const tabName = getArg(argv, '--tab') ?? '순위';
  const outArg = getArg(argv, '--out');

  if (!sheetId) {
    console.error('[report] ✖ --sheet-id (또는 RE_SHEET_ID) 필수');
    process.exit(1);
  }

  const client = createSheetsClient();

  // 제목 기본값: 스프레드시트 자체의 제목(보통 "경기도 의왕시" 처럼 지역명으로 되어 있음).
  const meta = await client.getSpreadsheetMeta(sheetId, 'properties(title),sheets.properties(title)');
  const title = getArg(argv, '--title') ?? meta.properties?.title ?? '부동산 리서치';

  const [valueRange] = await client.batchGet(sheetId, [`'${tabName.replaceAll("'", "''")}'!A1:V5000`]);
  const rows = valueRange?.values ?? [];
  if (rows.length === 0) {
    console.error(`[report] ✖ '${tabName}' 탭에서 값을 읽지 못했습니다 (탭 이름/권한 확인)`);
    process.exit(1);
  }

  const apartments = buildApartments(rows);
  if (apartments.length === 0) {
    console.error(`[report] ✖ '${tabName}' 탭에 매매최저가가 있는 행이 없습니다`);
    process.exit(1);
  }

  const dongColors = assignDongColors(apartments);
  const subtitleDongs = Object.keys(dongColors);
  const jsx = renderAppJsx({ apartments, title, subtitleDongs, dongColors });

  const outPath = path.resolve(outArg ?? `outputs/real_estate/reports/${sheetId}.App.jsx`);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, jsx, 'utf8');

  const withGap = apartments.filter((a) => a.gap !== null);
  console.log('[report] ═══ 요약 ═══');
  console.log(JSON.stringify({
    sheetId,
    tabName,
    title,
    dongs: subtitleDongs,
    count: apartments.length,
    withGap: withGap.length,
    minGap: withGap.length ? Math.min(...withGap.map((a) => a.gap)) : null,
    outPath,
  }, null, 2));
}

main().catch((err) => {
  console.error(`[report] ✖ ${err.message}`);
  process.exit(1);
});

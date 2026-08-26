#!/usr/bin/env node
// 부동산 시세 자동화 — 순위 탭 갱신 CLI (독립 실행)
// 사용: npm run realestate:ranking -- --sheet-id ... --dongs "가락동,잠실동"
//       npm run realestate:ranking:dry -- --sheet-id ... --dongs "..."
// 시세 재조회 없이 시트 현재 값만 재정렬 → '순위' 탭 갱신 (수 초 소요).
// price_updater 는 실쓰기 성공 후 자동으로 순위를 갱신하므로 이 CLI 는 별도 재정렬용.

import process from 'node:process';

import { createSheetsClient } from '../src/real_estate/sheets_client.js';
import { updateRankingTab } from '../src/real_estate/ranking_updater.js';
import { createLogger } from '../src/lib/logger.js';

function getArg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
}

async function main() {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const sheetId = getArg(argv, '--sheet-id') ?? process.env.RE_SHEET_ID;
  const dongsArg = getArg(argv, '--dongs');
  const tabName = getArg(argv, '--tab') ?? '순위';
  const dryRun = flags.has('--dry') || process.env.RE_DRY_RUN === '1';

  if (!sheetId) {
    console.error('[ranking] ✖ --sheet-id (또는 RE_SHEET_ID) 필수');
    process.exit(1);
  }

  const logger = createLogger({
    logPath: 'outputs/real_estate/run.log.jsonl',
    stagePrefix: 'realestate',
  });
  const client = createSheetsClient({ logger });

  // 동 탭 목록: --dongs 명시 or 시트 메타에서 이름 끝에 '동' 붙은 탭 자동 감지.
  let dongTabs;
  if (dongsArg) {
    dongTabs = dongsArg.split(',').map((s) => s.trim()).filter(Boolean);
  } else {
    const meta = await client.getSpreadsheetMeta(sheetId, 'sheets.properties(title)');
    dongTabs = (meta.sheets ?? [])
      .map((s) => s.properties?.title)
      .filter((t) => t && t.endsWith('동') && t !== tabName);
    logger.info('ranking', `동 탭 자동 감지: ${dongTabs.join(', ')}`);
  }

  if (dongTabs.length === 0) {
    console.error('[ranking] ✖ 대상 동 탭이 없습니다');
    process.exit(1);
  }

  const res = await updateRankingTab({
    client, sheetId, dongTabs, tabName, dryRun, logger,
  });
  console.log('[ranking] ═══ 요약 ═══');
  console.log(JSON.stringify(res, null, 2));
}

main().catch((err) => {
  console.error(`[ranking] ✖ ${err.message}`);
  process.exit(1);
});

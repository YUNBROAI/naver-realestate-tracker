#!/usr/bin/env node
// 부동산 시세 자동화 — 시트 가격 갱신 CLI
// 사용: npm run realestate:update            (RE_DRY_RUN=0 이어야 실쓰기)
//       npm run realestate:update:dry
//       npm run realestate:update -- --dong 가양동
//       npm run realestate:update -- --complex 103293 --dry

import process from 'node:process';
import { runPriceUpdate } from '../src/real_estate/price_updater.js';

try {
  const summary = await runPriceUpdate({ argv: process.argv.slice(2) });
  console.log('[realestate:update] ═══ 요약 ═══');
  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.failed > 0 && summary.ok === 0 ? 1 : 0);
} catch (err) {
  console.error(`[realestate:update] ✖ ${err.message}`);
  process.exit(1);
}

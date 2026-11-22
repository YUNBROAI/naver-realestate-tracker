// 부동산 시세 자동화 — 가격 갱신 오케스트레이터
// 흐름: Sheets batchGet → row_parser 타깃 추출 → 단지별 매물 조회(캐시 공유) →
//        평형 필터 매매 min / 전세 max 계산 → I/J/K/L 4컬럼만 batchUpdate →
//        스냅샷 JSON + run.log.jsonl + (선택) Slack 요약.
// dry-run 3중 폴백 (OR): RE_DRY_RUN=1(디폴트) ∨ --dry ∨ SA 키 누락. 기존 YT/네이버 패턴.

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import {
  TRADE_TYPE,
  fetchComplexArticlesAuto,
  createRateLimiter,
  createFailureGuard,
} from './naver_land_client.js';
import { extractTargets, columnLetter } from './row_parser.js';
import { createSheetsClient, resolveSheetsKeyPath } from './sheets_client.js';
import { updateRankingTab } from './ranking_updater.js';
import { createLogger } from '../lib/logger.js';

const DEFAULT_SHEETS = ['가양동', '공항동', '내발산동', '등촌동', '마곡동', '방화동', '염창동', '화곡동'];
const READ_RANGE = 'A1:AW500'; // 헤더 탐지를 위해 넉넉히. 우측 요약 블록 포함.
const ANOMALY_RATIO = 0.3; // 직전 값 대비 ±30% 변동 시 ⚠ 플래그
const OUTPUT_DIR = 'outputs/real_estate';

export function resolveConfig({ env = process.env, argv = [] } = {}) {
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const getArg = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
  };
  const keyPath = resolveSheetsKeyPath(env);
  const dryRun =
    env.RE_DRY_RUN !== '0' || // 안전 디폴트: 명시적으로 0 이어야 실쓰기
    flags.has('--dry') ||
    !keyPath;
  const dongArg = getArg('--dong');
  return {
    sheetId: getArg('--sheet-id') ?? env.RE_SHEET_ID ?? null,
    targetSheets: dongArg
      ? [dongArg]
      : (env.RE_TARGET_SHEETS?.split(',').map((s) => s.trim()).filter(Boolean) ?? DEFAULT_SHEETS),
    // --dong / RE_TARGET_SHEETS 로 사용자가 직접 지정했는지 여부.
    // false 면 runPriceUpdate 가 시트를 스캔해 '동'으로 끝나는 탭을 자동 감지 시도.
    targetSheetsExplicit: Boolean(dongArg || env.RE_TARGET_SHEETS),
    complexFilter: getArg('--complex'),
    dryRun,
    dryRunReasons: [
      ...(env.RE_DRY_RUN !== '0' ? ['RE_DRY_RUN!=0'] : []),
      ...(flags.has('--dry') ? ['--dry'] : []),
      ...(!keyPath ? ['SA키 누락'] : []),
    ],
    keyPath,
    onlyMissing: flags.has('--only-missing') || flags.has('--new-only') || env.RE_ONLY_MISSING === '1',
    // 순위 탭 자동 갱신 여부. 실쓰기 성공 후 --complex 단일 갱신처럼 부분 실행일 때는 스킵.
    skipRanking: flags.has('--skip-ranking') || env.RE_SKIP_RANKING === '1' || !!getArg('--complex'),
  };
}

// 평형 필터 후 매매 min / 전세 max. 동률이면 확인일자 최신 매물 채택.
export function computePriceStats(articles, { areaMin, areaMax } = {}) {
  const inRange = articles.filter((a) => {
    if (a.priceManwon == null) return false;
    if (areaMin != null && (a.supplyArea == null || a.supplyArea < areaMin)) return false;
    if (areaMax != null && (a.supplyArea == null || a.supplyArea > areaMax)) return false;
    return true;
  });
  const sales = inRange.filter((a) => a.tradeType === TRADE_TYPE.SALE);
  const jeonses = inRange.filter((a) => a.tradeType === TRADE_TYPE.JEONSE);
  const pickBest = (list, better) => list.reduce((best, a) => {
    if (!best) return a;
    if (better(a, best)) return a;
    if (a.priceManwon === best.priceManwon &&
        String(a.confirmedDate) > String(best.confirmedDate)) return a;
    return best;
  }, null);
  return {
    saleMin: pickBest(sales, (a, b) => a.priceManwon < b.priceManwon),
    jeonseMax: pickBest(jeonses, (a, b) => a.priceManwon > b.priceManwon),
    saleCount: sales.length,
    jeonseCount: jeonses.length,
  };
}

export function isAnomalous(prev, next, ratio = ANOMALY_RATIO) {
  if (prev == null || next == null || prev <= 0) return false;
  return Math.abs(next - prev) / prev > ratio;
}

// 타깃 1건 → batchUpdate data 항목 2개 (매매 가격+층 / 전세 가격+층).
// 매물 없는 쪽은 기존 셀 유지(항목 생성 안 함).
export function buildUpdateEntries(target, columns, stats) {
  const entries = [];
  const row = target.rowIndex;
  if (stats.saleMin) {
    const colA = columnLetter(columns.salePrice);
    const colB = columnLetter(columns.saleFloor);
    entries.push({
      range: `'${target.sheetName}'!${colA}${row}:${colB}${row}`,
      values: [[stats.saleMin.priceManwon, stats.saleMin.floor ?? '']],
    });
  }
  if (stats.jeonseMax) {
    const colA = columnLetter(columns.jeonsePrice);
    const colB = columnLetter(columns.jeonseFloor);
    entries.push({
      range: `'${target.sheetName}'!${colA}${row}:${colB}${row}`,
      values: [[stats.jeonseMax.priceManwon, stats.jeonseMax.floor ?? '']],
    });
  }
  return entries;
}

export async function runPriceUpdate({
  env = process.env,
  argv = [],
  fetchImpl = fetch,
  sheetsClient,
  fetchArticlesImpl = fetchComplexArticlesAuto,
  logger = createLogger({ logPath: `${OUTPUT_DIR}/run.log.jsonl`, stagePrefix: 'realestate' }),
  now = new Date(),
} = {}) {
  const cfg = resolveConfig({ env, argv });
  if (!cfg.sheetId) {
    throw new Error('RE_SHEET_ID 환경변수 (또는 --sheet-id) 가 필요합니다.');
  }

  const client = sheetsClient ?? createSheetsClient({ fetchImpl, logger });

  // 0) RE_TARGET_SHEETS / --dong 미지정 시: 시트를 스캔해 '동'으로 끝나는 탭을 자동 감지.
  // 새 지역 시트를 물릴 때마다 탭 목록을 손으로 나열하지 않아도 되게 하기 위함.
  // 실패(권한/네트워크) 하거나 매칭 0건이면 DEFAULT_SHEETS(강서구)로 조용히 폴백.
  let targetSheets = cfg.targetSheets;
  if (!cfg.targetSheetsExplicit) {
    try {
      const meta = await client.getSpreadsheetMeta(cfg.sheetId, 'sheets.properties(title)');
      const autoDetected = (meta.sheets ?? [])
        .map((s) => s.properties?.title)
        .filter((t) => typeof t === 'string' && t.endsWith('동'));
      if (autoDetected.length > 0) {
        targetSheets = autoDetected;
        logger.info('update', `RE_TARGET_SHEETS 미지정 — '동'으로 끝나는 탭 ${autoDetected.length}개 자동 감지: ${autoDetected.join(', ')}`);
      }
    } catch (err) {
      logger.warn('update', `탭 자동 감지 실패, 기본값 사용: ${err.message}`);
    }
  }

  logger.info('update', `시작 — 시트 ${targetSheets.length}개, dryRun=${cfg.dryRun}` +
    (cfg.dryRun ? ` (${cfg.dryRunReasons.join(' ∨ ')})` : ''));

  // 1) 읽기
  const ranges = targetSheets.map((s) => `'${s}'!${READ_RANGE}`);
  const valueRanges = await client.batchGet(cfg.sheetId, ranges);

  // 2) 타깃 추출
  const perSheet = [];
  let totalTargets = 0;
  for (let i = 0; i < targetSheets.length; i += 1) {
    const sheetName = targetSheets[i];
    const rows = valueRanges[i]?.values ?? [];
    try {
      const { columns, targets } = extractTargets(sheetName, rows);
      let filtered = cfg.complexFilter
        ? targets.filter((t) => t.complexNo === String(cfg.complexFilter))
        : targets;
      if (cfg.onlyMissing) {
        filtered = filtered.filter((t) => t.current.salePrice == null);
      }
      perSheet.push({ sheetName, columns, targets: filtered });
      totalTargets += filtered.length;
      logger.ok('parse', `${sheetName}: 타깃 ${filtered.length}행` + (cfg.onlyMissing ? ` (신규/미입력만)` : ''));
    } catch (err) {
      logger.error('parse', `${sheetName}: ${err.message}`);
      perSheet.push({ sheetName, columns: null, targets: [], parseError: err.message });
    }
  }
  logger.info('update', `총 타깃 ${totalTargets}행`);

  // 3) 단지별 매물 조회 (같은 단지의 여러 평형 행은 1회 조회 공유)
  const rateLimiter = createRateLimiter({
    delayMs: Number(env.RE_REQUEST_DELAY_MS ?? 2000),
  });
  const guard = createFailureGuard();
  // naver_land_client 는 console 시그니처(warn(msg))를 기대 — JSONL 로거(stage,msg)와 어댑팅.
  const clientLogger = {
    warn: (msg) => logger.warn('naver', String(msg)),
    log: () => {},
    error: (msg) => logger.error('naver', String(msg)),
  };
  const complexCache = new Map(); // complexNo → { sale: [], jeonse: [] } | { error }
  const complexNos = [...new Set(perSheet.flatMap((s) => s.targets.map((t) => t.complexNo)))];
  logger.info('fetch', `단지 ${complexNos.length}개 조회 (매매+전세 각 1회)`);

  try {
    for (const complexNo of complexNos) {
      try {
        const sale = await fetchArticlesImpl({
          complexNo, tradeType: TRADE_TYPE.SALE, rateLimiter, fetchImpl, logger: clientLogger,
        });
        const jeonse = await fetchArticlesImpl({
          complexNo, tradeType: TRADE_TYPE.JEONSE, rateLimiter, fetchImpl, logger: clientLogger,
        });
        complexCache.set(complexNo, { sale, jeonse });
        guard.ok();
        logger.ok('fetch', `단지 ${complexNo}: 매매 ${sale.length}건 / 전세 ${jeonse.length}건`);
      } catch (err) {
        complexCache.set(complexNo, { error: err.message });
        logger.warn('fetch', `단지 ${complexNo} 실패: ${err.message}`);
        guard.fail(); // 연속 실패 임계 도달 시 throw → 아래 catch 가 잔여 조회만 중단
      }
    }
  } catch (err) {
    // 차단 의심 전체 중단 — 이미 조회된 단지는 살리고 잔여는 failed 처리 (부분 결과 보존).
    logger.error('fetch', `조회 중단: ${err.message}`);
  }

  // 4) 계산 + 업데이트 항목 구성
  const updates = [];
  const snapshot = [];
  const anomalies = [];
  let okCount = 0;
  let noArticleCount = 0;
  let failedCount = 0;

  for (const { sheetName, columns, targets } of perSheet) {
    for (const t of targets) {
      const cached = complexCache.get(t.complexNo);
      if (!cached || cached.error) {
        failedCount += 1;
        snapshot.push({ ...snapshotBase(t), status: 'failed', reason: cached?.error ?? 'not_fetched' });
        continue;
      }
      const stats = computePriceStats(
        [...cached.sale, ...cached.jeonse],
        { areaMin: t.areaMin, areaMax: t.areaMax },
      );
      const entry = {
        ...snapshotBase(t),
        status: stats.saleMin || stats.jeonseMax ? 'ok' : 'no_article',
        sale: stats.saleMin
          ? { price: stats.saleMin.priceManwon, floor: stats.saleMin.floor, articleNo: stats.saleMin.articleNo }
          : null,
        jeonse: stats.jeonseMax
          ? { price: stats.jeonseMax.priceManwon, floor: stats.jeonseMax.floor, articleNo: stats.jeonseMax.articleNo }
          : null,
        saleCount: stats.saleCount,
        jeonseCount: stats.jeonseCount,
      };
      snapshot.push(entry);
      if (entry.status === 'no_article') {
        noArticleCount += 1;
        continue;
      }
      okCount += 1;
      if (isAnomalous(t.current.salePrice, stats.saleMin?.priceManwon) ||
          isAnomalous(t.current.jeonsePrice, stats.jeonseMax?.priceManwon)) {
        anomalies.push(entry);
        logger.warn('compute',
          `⚠ 급변동 ${sheetName} ${t.complexName}(${t.areaMin}~${t.areaMax}㎡): ` +
          `매매 ${t.current.salePrice}→${stats.saleMin?.priceManwon ?? '-'} / ` +
          `전세 ${t.current.jeonsePrice}→${stats.jeonseMax?.priceManwon ?? '-'}`);
      }
      updates.push(...buildUpdateEntries(t, columns, stats));
    }
  }

  // 5) 쓰기 (또는 dry-run)
  let updatedCells = 0;
  if (cfg.dryRun) {
    logger.info('write', `dry-run — ${updates.length}개 range 쓰기 생략`);
  } else if (updates.length > 0) {
    const res = await client.batchUpdate(cfg.sheetId, updates);
    updatedCells = res.totalUpdatedCells;
    logger.ok('write', `${updatedCells}셀 갱신 (${updates.length} ranges)`);
  }

  // 6) 스냅샷 저장
  const dateKey = now.toISOString().slice(0, 10);
  const snapshotPath = path.resolve(OUTPUT_DIR, 'snapshots', `${dateKey}.json`);
  await fs.mkdir(path.dirname(snapshotPath), { recursive: true });
  await fs.writeFile(snapshotPath, JSON.stringify({
    schemaVersion: '1.0.0',
    ranAt: now.toISOString(),
    sheetId: cfg.sheetId,
    dryRun: cfg.dryRun,
    summary: { targets: totalTargets, ok: okCount, noArticle: noArticleCount, failed: failedCount, anomalies: anomalies.length, updatedCells },
    entries: snapshot,
  }, null, 2), 'utf8');
  logger.ok('snapshot', `저장 → ${snapshotPath}`);

  // 7) 순위 탭 자동 갱신 (실쓰기 성공 + 전체 실행 시). 실패해도 파이프라인은 성공 유지.
  let ranking = null;
  if (!cfg.dryRun && !cfg.skipRanking && (updatedCells > 0 || (cfg.onlyMissing && totalTargets > 0))) {
    try {
      ranking = await updateRankingTab({
        client, sheetId: cfg.sheetId, dongTabs: targetSheets, logger,
      });
    } catch (err) {
      logger.warn('ranking', `순위 탭 갱신 실패: ${err.message}`);
      ranking = { error: err.message };
    }
  } else if (cfg.dryRun) {
    logger.info('ranking', 'dry-run — 순위 탭 갱신 스킵');
  } else if (cfg.skipRanking) {
    logger.info('ranking', 'skip 플래그 활성 — 순위 탭 갱신 스킵');
  }

  const summary = {
    targets: totalTargets,
    ok: okCount,
    noArticle: noArticleCount,
    failed: failedCount,
    anomalies: anomalies.length,
    updatedCells,
    dryRun: cfg.dryRun,
    snapshotPath,
    ranking,
  };
  logger.ok('update',
    `완료 — ok ${okCount} / 매물없음 ${noArticleCount} / 실패 ${failedCount}` +
    ` / 급변동 ${anomalies.length} / ${cfg.dryRun ? 'dry-run' : `${updatedCells}셀 갱신`}`);
  return summary;
}

function snapshotBase(t) {
  return {
    sheet: t.sheetName,
    row: t.rowIndex,
    complexNo: t.complexNo,
    complexName: t.complexName,
    areaMin: t.areaMin,
    areaMax: t.areaMax,
    prev: t.current,
  };
}

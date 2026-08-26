// 부동산 시세 자동화 — 순위 탭 갱신기
// 책임: 시트의 모든 동별 탭에서 A:T 20 컬럼 스캔 → 매매 최저가 기준 내림차순 정렬 →
//        '순위' 탭 upsert (없으면 addSheet, 있으면 clear+rewrite).
// 출력 스키마: 순위 | 동 | 단지명 | 입주연도 | 총세대수 | 공급(m2) | 공급면적 |
//              전용(m2) | 전용면적 | 세대 | 매매최저가 | 층 | 전세최고가 | 층 |
//              매전갭 | 전세가율 | 매매평단 | 전세평단 | 방 | 욕실 | 구조 | 매/전/월Type
// 비-목표: 서식(굵게/색상). 값 갱신만. 서식은 시트에서 수동 설정 후 clearValues 로 보존.

import { findHeaderColumns, RowParseError } from './row_parser.js';

export const RANKING_TAB_NAME = '순위';

// 순위 탭 헤더 (22 컬럼). 원본 시트와 동일하게 다중행 헤더에 개행 사용.
export const RANKING_HEADERS = Object.freeze([
  '순위', '동',
  '단지명', '입주\n연도', '총세\n대수',
  '공급\n(m2)', '공급\n면적', '전용\n(m2)', '전용\n면적', '세대',
  '매매\n최저가', '층', '전세\n최고가', '층',
  '매전갭', '전세\n가율', '매매\n평단', '전세\n평단',
  '방', '욕\n실', '구\n조', '매/전/월\nType',
]);

// 숫자 포맷(#,##0) 적용할 컬럼 인덱스 (0-based). 원본 텍스트값(입주연도 등)은 제외.
const NUMBER_COLUMNS = Object.freeze([
  4,  // 총세대수
  9,  // 세대
  10, // 매매최저가
  12, // 전세최고가
  14, // 매전갭
  16, // 매매평단
  17, // 전세평단
]);

// 원본 시트에서 순위 탭으로 그대로 옮길 컬럼(20개). 인덱스는 findHeaderColumns 가 반환하는
// 매매/전세 컬럼을 기준으로 상대적으로 계산 (시트마다 열 위치가 다를 여지에 대비).
// 실제로는 A(단지명)=0 부터 T(매/전/월Type)=19 까지 연속 배치이지만,
// 헤더 매처가 지원하는 3개(단지명/매매최저가/전세최고가) 기준으로 앵커링한다.
const NUMERIC_CELL_KEYS = new Set([
  'salePrice', 'saleFloor', 'jeonsePrice', 'jeonseFloor',
  'gap', 'jeonseRate', 'salePerPyeong', 'jeonsePerPyeong',
]);

// 셀 값 정규화: 문자열은 trim, 숫자형 문자열은 Number, 빈 값은 ''.
// 층/방/구조 등 문자값이 숫자로 보여도 원본 형식(예: '저', '고', '3/2') 을 보존해야 하므로
// 열별 힌트 없이 blindly 변환하지 않는다. 원본이 이미 숫자면 그대로 통과.
function passthrough(v) {
  if (v == null) return '';
  if (typeof v === 'number') return v;
  const s = String(v).trim();
  return s;
}

// 매매최저가 셀에서 순위 정렬용 숫자 추출. USER_ENTERED 로 쓴 셀은 숫자 그대로 오지만
// 시트에서 텍스트로 입력된 경우(원본 시트 특성) 콤마 제거 후 숫자화. 실패 → null.
export function parseSalePriceCell(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null;
  const cleaned = String(v).replaceAll(',', '').replaceAll(/\s/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// 동 1개의 raw values(2D 배열) → 데이터 엔트리 배열.
// 헤더 R3 를 찾아 그 다음 행부터 스캔. 매매최저가가 유효한 숫자인 행만 채택.
export function extractDongEntries(sheetName, rows) {
  let cols;
  try {
    cols = findHeaderColumns(rows);
  } catch (err) {
    if (err instanceof RowParseError) return [];
    throw err;
  }
  // 원본 시트는 A~T 가 사용자 20 컬럼. 헤더 매처는 3개 앵커만 검증하므로
  // 매매 컬럼(cols.salePrice)이 I(=8) 인지 확인 후 A~T 를 그대로 읽는다.
  // 다른 위치면 정렬 컬럼 인덱스만 이용해서 값 추출 (안전 폴백).
  const isCanonical = cols.salePrice === 8 && cols.jeonsePrice === 10;
  const entries = [];
  for (let r = cols.headerRowIndex + 1; r < rows.length; r += 1) {
    const row = rows[r] ?? [];
    const salePrice = parseSalePriceCell(row[cols.salePrice]);
    if (salePrice == null) continue; // 매매가 없는 행은 제외 (사용자 결정 #2)
    // A~T 20 컬럼 추출 (canonical 시트 기준). 비-canonical 시트면 앵커 상대 배치는
    // 원본과 다를 수 있으니 최소 앵커 4개(단지명/매매가/매매층/전세가/전세층)만 사용.
    let payload;
    if (isCanonical) {
      payload = row.slice(0, 20).map((v) => passthrough(v));
      while (payload.length < 20) payload.push('');
      // 정렬 안정성을 위해 salePrice 는 확실히 숫자로.
      payload[cols.salePrice] = salePrice;
      const jeonsePrice = parseSalePriceCell(row[cols.jeonsePrice]);
      if (jeonsePrice != null) payload[cols.jeonsePrice] = jeonsePrice;
    } else {
      // 폴백: 매핑 가능한 4개만 채우고 나머지는 공란. 시트 스키마 변형 감지 시 로깅 필요.
      payload = new Array(20).fill('');
      payload[0] = passthrough(row[cols.complexName]);
      payload[cols.salePrice] = salePrice;
      payload[cols.saleFloor] = passthrough(row[cols.saleFloor]);
      const jeonsePrice = parseSalePriceCell(row[cols.jeonsePrice]);
      if (jeonsePrice != null) payload[cols.jeonsePrice] = jeonsePrice;
      payload[cols.jeonseFloor] = passthrough(row[cols.jeonseFloor]);
    }
    entries.push({ sheetName, salePrice, payload });
  }
  return entries;
}

// 여러 동의 엔트리를 통합 정렬 후 순위 부여 → 시트에 쓸 2D 배열.
// 정렬: 매매최저가 내림차순 (동률 시 전세최고가 내림차순 → 그 다음 단지명 사전순).
export function buildRankingRows(entriesByDong) {
  const all = [];
  for (const { sheetName, entries } of entriesByDong) {
    for (const e of entries) all.push({ ...e, sheetName });
  }
  all.sort((a, b) => {
    if (b.salePrice !== a.salePrice) return b.salePrice - a.salePrice;
    // tie-breaker 1: 전세최고가 내림차순 (payload[10])
    const jA = Number(a.payload[10]) || 0;
    const jB = Number(b.payload[10]) || 0;
    if (jB !== jA) return jB - jA;
    // tie-breaker 2: 단지명 사전순 (payload[0])
    return String(a.payload[0]).localeCompare(String(b.payload[0]), 'ko');
  });
  const rows = [RANKING_HEADERS.slice()];
  all.forEach((e, i) => {
    rows.push([i + 1, e.sheetName, ...e.payload]);
  });
  return rows;
}

// A1 range for the ranking tab (탭 이름 이스케이프).
function rankingRange(tabName, endColLetter = 'V', endRow = 2000) {
  const escaped = tabName.replaceAll("'", "''");
  return `'${escaped}'!A1:${endColLetter}${endRow}`;
}

// 순위 탭 서식 요청 배열 (spreadsheets:batchUpdate 용).
// 모두 idempotent — 여러 번 호출해도 안전. addBanding 은 재요청 시 400 이므로 제외.
export function buildRankingFormatRequests({ sheetId, colCount = RANKING_HEADERS.length, headerBackground } = {}) {
  const bg = headerBackground ?? { red: 0.85, green: 0.90, blue: 0.96 };
  const headerRange = { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: colCount };
  const numberFormatRequests = NUMBER_COLUMNS.map((colIdx) => ({
    repeatCell: {
      range: { sheetId, startRowIndex: 1, startColumnIndex: colIdx, endColumnIndex: colIdx + 1 },
      cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '#,##0' } } },
      fields: 'userEnteredFormat.numberFormat',
    },
  }));
  return [
    // 1) 첫 행 고정 + 첫 2 컬럼(순위/동) 고정.
    {
      updateSheetProperties: {
        properties: { sheetId, gridProperties: { frozenRowCount: 1, frozenColumnCount: 2 } },
        fields: 'gridProperties.frozenRowCount,gridProperties.frozenColumnCount',
      },
    },
    // 2) 헤더 행: 굵게 + 배경 + 중앙정렬 + 자동 개행.
    {
      repeatCell: {
        range: headerRange,
        cell: {
          userEnteredFormat: {
            backgroundColor: bg,
            horizontalAlignment: 'CENTER',
            verticalAlignment: 'MIDDLE',
            wrapStrategy: 'WRAP',
            textFormat: { bold: true, fontSize: 10 },
          },
        },
        fields: 'userEnteredFormat(backgroundColor,horizontalAlignment,verticalAlignment,wrapStrategy,textFormat)',
      },
    },
    // 3) 헤더 행 높이 확대 (개행 반영).
    {
      updateDimensionProperties: {
        range: { sheetId, dimension: 'ROWS', startIndex: 0, endIndex: 1 },
        properties: { pixelSize: 42 },
        fields: 'pixelSize',
      },
    },
    // 4) 숫자 컬럼 콤마 서식.
    ...numberFormatRequests,
    // 5) 전체 컬럼 자동 폭 조정 — 값이 채워진 뒤에 실행되므로 서식 요청 순서 마지막.
    {
      autoResizeDimensions: {
        dimensions: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: colCount },
      },
    },
  ];
}

// 오케스트레이션: 모든 동 탭 batchGet → 데이터 수집 → 정렬 → 순위 탭 upsert → 쓰기.
// dongTabs 는 실제 시트에 존재하는 동 탭 이름 배열 (호출자가 결정).
// logger 는 createLogger 인터페이스 (info/ok/warn/error).
export async function updateRankingTab({
  client, sheetId, dongTabs, tabName = RANKING_TAB_NAME, dryRun = false, logger = console,
} = {}) {
  if (!client) throw new Error('updateRankingTab: client 필수');
  if (!sheetId) throw new Error('updateRankingTab: sheetId 필수');
  if (!Array.isArray(dongTabs) || dongTabs.length === 0) {
    throw new Error('updateRankingTab: dongTabs 배열 필수');
  }

  const emit = normalizeLogger(logger);
  emit.info('ranking', `동 ${dongTabs.length}개 스캔 시작 → 탭 '${tabName}'`);

  // 1) 모든 동 탭을 한 번의 batchGet 으로 읽는다.
  // findHeaderColumns 는 '링크'(V 컬럼) 존재 여부로 헤더 행을 판정하므로 A:V 까지 요청.
  // payload 는 A:T 20 컬럼만 슬라이스해서 사용.
  const ranges = dongTabs.map((n) => `'${n.replaceAll("'", "''")}'!A1:V1000`);
  const valueRanges = await client.batchGet(sheetId, ranges);

  // 2) 동별 파싱.
  const entriesByDong = valueRanges.map((vr, idx) => {
    const dong = dongTabs[idx];
    const entries = extractDongEntries(dong, vr.values ?? []);
    return { sheetName: dong, entries };
  });
  const totalEntries = entriesByDong.reduce((n, x) => n + x.entries.length, 0);
  emit.info('ranking', `수집: ${entriesByDong.map((x) => `${x.sheetName}=${x.entries.length}`).join(', ')} (합계 ${totalEntries})`);

  if (totalEntries === 0) {
    emit.warn('ranking', '수집된 매물이 0건 — 순위 탭 갱신을 스킵합니다');
    return { rows: 0, dryRun, tabName, skipped: true };
  }

  // 3) 정렬 + 순위 부여.
  const rows = buildRankingRows(entriesByDong);
  emit.info('ranking', `순위표 ${rows.length - 1}행 준비 (헤더 제외)`);

  if (dryRun) {
    emit.info('ranking', `dry-run — 쓰기 스킵 (상위 3행: ${JSON.stringify(rows.slice(1, 4))})`);
    return { rows: rows.length - 1, dryRun, tabName, skipped: false };
  }

  // 4) 순위 탭 존재 확인 → 없으면 생성 + sheetId 획득.
  const meta = await client.getSpreadsheetMeta(sheetId, 'sheets.properties(title,sheetId)');
  let existing = (meta.sheets ?? []).find((s) => s.properties?.title === tabName);
  let rankingSheetId;
  if (!existing) {
    const added = await client.addSheetTab(sheetId, tabName, {
      rowCount: Math.max(rows.length + 10, 500),
      columnCount: RANKING_HEADERS.length + 2,
    });
    rankingSheetId = added.sheetId;
    emit.ok('ranking', `탭 '${tabName}' 신규 생성`);
  } else {
    rankingSheetId = existing.properties.sheetId;
  }

  // 5) 기존 값 초기화 (A1:V2000 넉넉히) → 새 값 쓰기.
  const range = rankingRange(tabName);
  await client.clearValues(sheetId, range);
  const res = await client.updateValues(sheetId, `'${tabName.replaceAll("'", "''")}'!A1`, rows);
  emit.ok('ranking', `순위 탭 '${tabName}' 값 갱신 (${res.updatedCells}셀)`);

  // 6) 서식 적용 (idempotent — 매번 호출 안전). autoResize 는 값 채워진 뒤에 실행돼야 함.
  try {
    const requests = buildRankingFormatRequests({ sheetId: rankingSheetId });
    await client.batchUpdateSpreadsheet(sheetId, requests);
    emit.ok('ranking', `서식 적용 완료 (${requests.length}개 요청)`);
  } catch (err) {
    emit.warn('ranking', `서식 적용 실패 (값은 정상 갱신됨): ${err.message}`);
  }

  return { rows: rows.length - 1, dryRun: false, tabName, updatedCells: res.updatedCells, skipped: false };
}

// createLogger(가양-스타일) 인터페이스와 그냥 console 둘 다 수용.
function normalizeLogger(logger) {
  const has = (name) => typeof logger?.[name] === 'function';
  if (has('info') && has('ok') && has('warn')) return logger;
  // console 폴백 — stage 를 접두어로.
  return {
    info: (stage, msg) => (logger?.log ?? console.log)(`[ranking:${stage}] ▶ ${msg}`),
    ok: (stage, msg) => (logger?.log ?? console.log)(`[ranking:${stage}] ✓ ${msg}`),
    warn: (stage, msg) => (logger?.warn ?? console.warn)(`[ranking:${stage}] ⚠ ${msg}`),
    error: (stage, msg) => (logger?.error ?? console.error)(`[ranking:${stage}] ✖ ${msg}`),
  };
}

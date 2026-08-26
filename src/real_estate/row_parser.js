// 부동산 시세 자동화 — 시트 행 파서
// 책임: 동 시트의 2차원 값 배열에서 헤더 컬럼 자동 탐지 → 링크 행을
//        {rowIndex, complexNo, areaMin, areaMax, 현재값} 타깃으로 변환.
// 비-목표: 시트 쓰기 (sheets_client 담당), 가격 계산 (price_updater 담당).

const LINK_RE = /new\.land\.naver\.com\/complexes\/(\d+)/;

// 헤더 텍스트 매칭 — Numbers 내보내기 특성상 공백/개행 변형이 있어 정규화 후 비교.
const norm = (s) => String(s ?? '').replaceAll(/\s+/g, '');

const HEADER_MATCHERS = Object.freeze({
  complexName: (h) => norm(h) === '단지명',
  supplyM2: (h) => /^공급\(?m2\)?$/i.test(norm(h)),
  salePrice: (h) => norm(h) === '매매최저가',
  jeonsePrice: (h) => norm(h) === '전세최고가',
  link: (h) => norm(h) === '네이버부동산링크' || norm(h) === '링크',
});

export class RowParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RowParseError';
  }
}

// 헤더 행을 찾아 컬럼 인덱스 맵 반환. 층 컬럼은 가격 컬럼 바로 다음 열 규약.
export function findHeaderColumns(rows) {
  for (let r = 0; r < rows.length; r += 1) {
    const row = rows[r] ?? [];
    const cols = {};
    for (let c = 0; c < row.length; c += 1) {
      for (const [key, match] of Object.entries(HEADER_MATCHERS)) {
        // 단지명/링크는 우측 요약 블록에도 중복 등장 — 첫 번째 것만 채택.
        if (cols[key] === undefined && match(row[c])) cols[key] = c;
      }
    }
    if (cols.salePrice !== undefined && cols.jeonsePrice !== undefined && cols.link !== undefined) {
      return {
        headerRowIndex: r,
        complexName: cols.complexName ?? 0,
        supplyM2: cols.supplyM2 ?? null,
        salePrice: cols.salePrice,
        saleFloor: cols.salePrice + 1,
        jeonsePrice: cols.jeonsePrice,
        jeonseFloor: cols.jeonsePrice + 1,
        link: cols.link,
      };
    }
  }
  throw new RowParseError(
    '헤더 행을 찾지 못했습니다 (매매 최저가/전세 최고가/링크 컬럼 필요). 시트 구조 변경 여부를 확인하세요.'
  );
}

// 링크 → { complexNo, areaMin, areaMax }. h/i 파라미터가 평형(공급㎡) 필터.
export function parseNaverLandLink(url) {
  const str = String(url ?? '');
  const m = str.match(LINK_RE);
  if (!m) return null;
  let areaMin = null;
  let areaMax = null;
  try {
    const u = new URL(str);
    const h = Number(u.searchParams.get('h'));
    const i = Number(u.searchParams.get('i'));
    if (Number.isFinite(h) && h > 0) areaMin = h;
    if (Number.isFinite(i) && i > 0) areaMax = i;
  } catch {
    // URL 파싱 실패 시 complexNo 만 사용.
  }
  return { complexNo: m[1], areaMin, areaMax };
}

const AREA_FALLBACK_MARGIN = 3; // h/i 없는 링크: 공급(m2) ± 3㎡

// 시트 1개의 rows → 타깃 배열. rowIndex 는 1-based (Sheets A1 표기 기준).
export function extractTargets(sheetName, rows) {
  const cols = findHeaderColumns(rows);
  const targets = [];
  for (let r = cols.headerRowIndex + 1; r < rows.length; r += 1) {
    const row = rows[r] ?? [];
    const parsed = parseNaverLandLink(row[cols.link]);
    if (!parsed) continue; // 링크 없는 행(동 이름/구분/빈 행) 스킵
    let { areaMin, areaMax } = parsed;
    if (areaMin == null || areaMax == null) {
      const supply = Number(String(row[cols.supplyM2] ?? '').replaceAll(',', ''));
      if (Number.isFinite(supply) && supply > 0) {
        areaMin = supply - AREA_FALLBACK_MARGIN;
        areaMax = supply + AREA_FALLBACK_MARGIN;
      }
    }
    targets.push({
      sheetName,
      rowIndex: r + 1,
      complexName: String(row[cols.complexName] ?? '').trim(),
      complexNo: parsed.complexNo,
      areaMin,
      areaMax,
      current: {
        salePrice: parseCellNumber(row[cols.salePrice]),
        saleFloor: String(row[cols.saleFloor] ?? '').trim() || null,
        jeonsePrice: parseCellNumber(row[cols.jeonsePrice]),
        jeonseFloor: String(row[cols.jeonseFloor] ?? '').trim() || null,
      },
    });
  }
  return { columns: cols, targets };
}

function parseCellNumber(v) {
  const n = Number(String(v ?? '').replaceAll(',', ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

// 0-based 컬럼 인덱스 → A1 표기 컬럼 문자 (0→A, 25→Z, 26→AA).
export function columnLetter(index) {
  let n = index;
  let out = '';
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

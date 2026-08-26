// 부동산 시세 자동화 — 네이버 부동산 클라이언트 (모바일 비공식 JSON API)
// 책임: 단지별 매물 리스트(getComplexArticleList) + 동 단위 클러스터 매물(articleList) 조회,
//        가격/층 문자열 파싱, rate-limit + 429/5xx 지수 백오프.
// 의존성: Node 24+ native fetch. npm 추가 없음 (코어 무의존성 원칙).
// 비-목표: 브라우저 매크로(Puppeteer/Playwright) 금지. PC API JWT 발급은 폴백 단계로 미구현.

import process from 'node:process';

const MOBILE_BASE = 'https://m.land.naver.com';
const COMPLEX_ARTICLE_PATH = '/complex/getComplexArticleList';
const CLUSTER_ARTICLE_PATH = '/cluster/ajax/articleList';

const DEFAULT_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const DEFAULT_DELAY_MS = 2000;
const DEFAULT_RETRY_ATTEMPTS = 3;
const DEFAULT_MAX_PAGES = 40; // 20건/page × 40 = 800건 상한 (동 단위 안전망)
const CONSECUTIVE_FAILURE_LIMIT = 5; // 연속 실패 시 전체 중단 (IP 보호)

export const TRADE_TYPE = Object.freeze({ SALE: 'A1', JEONSE: 'B1', WOLSE: 'B2' });

export class NaverLandError extends Error {
  constructor(message, { status, body, stage } = {}) {
    super(message);
    this.name = 'NaverLandError';
    this.status = status;
    this.body = body;
    this.stage = stage;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 파서 — 가격/층 문자열
// ─────────────────────────────────────────────────────────────────────────────

// "6억 5,000" → 65000, "6억" → 60000, "3억5,000" → 35000, "45,000" → 45000 (만원 정수).
// 숫자(만원) 그대로 오는 경우(클러스터 API prc 필드)는 그대로 통과. 파싱 불가 → null.
export function parsePriceToManwon(input) {
  if (input == null) return null;
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input <= 0) return null;
    // 원(₩) 단위 감지: 만원 단위로 10^7(=1,000억) 을 넘는 아파트 호가는 없음.
    // fin API 가 원 단위로 줄 경우(예: 13.5억 = 1,350,000,000) 만원으로 환산.
    return input >= 1e7 ? Math.round(input / 1e4) : Math.round(input);
  }
  const str = String(input).trim();
  if (!str || str === '-') return null;
  const eokMatch = str.match(/([\d,.]+)\s*억/);
  let total = 0;
  let rest = str;
  if (eokMatch) {
    const eok = Number(eokMatch[1].replaceAll(',', ''));
    if (!Number.isFinite(eok)) return null;
    total += Math.round(eok * 10000);
    rest = str.slice(str.indexOf(eokMatch[0]) + eokMatch[0].length);
  }
  const numMatch = rest.match(/([\d,]+)/);
  if (numMatch) {
    const n = Number(numMatch[1].replaceAll(',', ''));
    if (Number.isFinite(n)) total += n;
  }
  if (total <= 0) return null;
  return total;
}

// "저/15" → { floor: '저', totalFloor: 15 }, "3/15" → { floor: '3', totalFloor: 15 }.
// 층 미상("-") → { floor: null, totalFloor: null }.
export function parseFloorInfo(input) {
  if (input == null) return { floor: null, totalFloor: null };
  const str = String(input).trim();
  const m = str.match(/^([^/]+)\/(\d+)/);
  if (!m) return { floor: str || null, totalFloor: null };
  const floor = m[1].trim();
  return {
    floor: floor && floor !== '-' ? floor : null,
    totalFloor: Number(m[2]),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// rate limiter — 요청 간 지연 + ±50% jitter
// ─────────────────────────────────────────────────────────────────────────────
export function createRateLimiter({
  delayMs = Number(process.env.RE_REQUEST_DELAY_MS ?? DEFAULT_DELAY_MS),
  jitterRatio = 0.5,
  sleepImpl = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  let lastAt = 0;
  return async function wait() {
    const jitter = delayMs * jitterRatio * (Math.random() * 2 - 1);
    const target = Math.max(0, delayMs + jitter);
    const elapsed = Date.now() - lastAt;
    if (elapsed < target) await sleepImpl(target - elapsed);
    lastAt = Date.now();
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// fetch + 재시도 (429/5xx 지수 백오프, Retry-After 우선)
// ─────────────────────────────────────────────────────────────────────────────
async function fetchJsonWithRetry(url, {
  fetchImpl = fetch,
  retryAttempts = Number(process.env.RE_RETRY_ATTEMPTS ?? DEFAULT_RETRY_ATTEMPTS),
  retryBaseMs = 3000,
  sleepImpl = (ms) => new Promise((r) => setTimeout(r, ms)),
  logger = console,
  stage = 'fetch',
} = {}) {
  const headers = {
    'user-agent': DEFAULT_UA,
    'accept': 'application/json, text/javascript, */*; q=0.01',
    'referer': `${MOBILE_BASE}/`,
  };
  let lastErr;
  for (let attempt = 0; attempt <= retryAttempts; attempt += 1) {
    try {
      const res = await fetchImpl(url, { headers });
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers?.get?.('retry-after'));
        const backoff = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : retryBaseMs * 2 ** attempt;
        lastErr = new NaverLandError(`HTTP ${res.status}`, { status: res.status, stage });
        if (attempt < retryAttempts) {
          logger.warn?.(`[naver_land] ⚠ ${res.status} 응답 — ${backoff}ms 후 재시도 (${attempt + 1}/${retryAttempts})`);
          await sleepImpl(backoff);
          continue;
        }
        throw lastErr;
      }
      const text = await res.text();
      // 봇 차단 시 JSON 대신 HTML(캡차 페이지)이 오는 경우 감지.
      if (/^\s*</.test(text)) {
        throw new NaverLandError(
          `JSON 이 아닌 응답 (HTML/캡차 의심, status=${res.status})`,
          { status: res.status, body: text.slice(0, 200), stage },
        );
      }
      if (!res.ok) {
        throw new NaverLandError(`HTTP ${res.status}: ${text.slice(0, 200)}`, {
          status: res.status, body: text.slice(0, 500), stage,
        });
      }
      try {
        return JSON.parse(text);
      } catch {
        throw new NaverLandError(`JSON 파싱 실패: ${text.slice(0, 200)}`, { stage });
      }
    } catch (err) {
      lastErr = err;
      // 네트워크 오류(fetch reject)도 재시도 대상. 캡차/파싱 오류는 즉시 전파.
      const retriable = !(err instanceof NaverLandError) || err.status === 429 || (err.status ?? 0) >= 500;
      if (!retriable || attempt >= retryAttempts) throw err;
      const backoff = retryBaseMs * 2 ** attempt;
      logger.warn?.(`[naver_land] ⚠ ${err.message} — ${backoff}ms 후 재시도 (${attempt + 1}/${retryAttempts})`);
      await sleepImpl(backoff);
    }
  }
  throw lastErr;
}

// ─────────────────────────────────────────────────────────────────────────────
// 매물 정규화 — 단지 API(getComplexArticleList)와 클러스터 API(articleList)의
// 응답 필드가 다르므로 하나의 스키마로 흡수.
// ─────────────────────────────────────────────────────────────────────────────
// fin API 는 매매 응답에도 warrantyPrice=0, 전세 응답에도 dealPrice=0 을 함께 실어보낸다.
// `??` 체인은 0 을 non-null 로 보고 첫 번째 값을 채택 → parsePriceToManwon(0)=null 로 유실됨.
// 정규화 단계에서 "양수 후보만" 순서대로 선택하는 헬퍼가 필요.
function firstPositive(...values) {
  for (const v of values) {
    if (v == null) continue;
    if (typeof v === 'number') {
      if (Number.isFinite(v) && v > 0) return v;
    } else {
      const s = String(v).trim();
      if (s && s !== '-' && s !== '0') return v;
    }
  }
  return null;
}

export function normalizeArticle(raw) {
  if (!raw || typeof raw !== 'object') return null;
  // fin.land front-api 는 중첩 객체(priceInfo 등)에 값이 들어올 수 있어 후보를 넓게 흡수.
  const p = raw.priceInfo ?? raw.articleDetail?.priceInfo ??
    (typeof raw.price === 'object' ? raw.price : null) ?? {};
  const priceManwon = parsePriceToManwon(firstPositive(
    raw.prc, raw.prcInfo, raw.hanPrc, raw.dealOrWarrantPrc,
    p.dealPrice, p.warrantyPrice, p.warrantPrice, p.dealOrWarrantPrc, p.price,
    raw.dealPrice, raw.warrantyPrice, raw.warrantPrice,
    raw.articleDetail?.dealPrice, raw.articleDetail?.warrantyPrice,
    typeof raw.price === 'object' ? null : raw.price,
  ));
  let { floor, totalFloor } = parseFloorInfo(
    raw.flrInfo ?? raw.floorInfo ?? raw.articleDetail?.floorInfo,
  );
  if (floor == null && (raw.floor != null || raw.totalFloor != null)) {
    floor = raw.floor != null ? String(raw.floor) : null;
    totalFloor = Number(raw.totalFloor) || null;
  }
  const space = raw.spaceInfo ?? raw.space ?? {};
  const tradeRaw = raw.tradTpCd ?? raw.tradeTypeCode ??
    (typeof raw.tradeType === 'object' ? raw.tradeType?.code : raw.tradeType);
  const article = {
    articleNo: String(raw.atclNo ?? raw.articleNo ?? raw.articleNumber ?? ''),
    name: String(raw.atclNm ?? raw.articleName ?? raw.complexName ?? raw.name ?? ''),
    tradeType: String(tradeRaw ?? ''),
    tradeTypeName: String(raw.tradTpNm ?? raw.tradeTypeName ??
      (typeof raw.tradeType === 'object' ? raw.tradeType?.name ?? '' : '')),
    priceManwon,
    rentPriceManwon: parsePriceToManwon(firstPositive(raw.rentPrc, p.rentPrice, raw.rentPrice)),
    floor,
    totalFloor,
    supplyArea: toNumber(raw.spc1 ?? raw.area1 ?? raw.supplyArea ??
      space.supplySpace ?? space.supplyArea ?? raw.supplySpace),
    exclusiveArea: toNumber(raw.spc2 ?? raw.area2 ?? raw.exclusiveArea ??
      space.exclusiveSpace ?? space.exclusiveArea ?? raw.exclusiveSpace),
    confirmedDate: String(raw.cfmYmd ?? raw.atclCfmYmd ?? raw.articleConfirmYmd ??
      raw.confirmedYmd ?? raw.verificationInfo?.articleConfirmDate ??
      raw.verificationInfo?.exposureStartDate ?? raw.approvalYmd ?? ''),
    buildingName: String(raw.bildNm ?? raw.buildingName ?? raw.dongName ?? ''),
    description: String(raw.atclFetrDesc ?? raw.articleFeatureDesc ??
      raw.articleDetail?.articleFeatureDescription ?? raw.featureDescription ?? ''),
    realtorName: String(raw.rltrNm ?? raw.realtorName ??
      raw.brokerInfo?.brokerageName ?? raw.brokerageName ?? ''),
    direction: String(raw.direction ?? raw.articleDetail?.direction ?? ''),
  };
  if (!article.articleNo) return null;
  return article;
}

function toNumber(v) {
  const n = Number(String(v ?? '').replaceAll(',', ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

// 응답 shape 흡수: 단지 API 는 { result: { list, moreDataYn } },
// 클러스터 API 는 { code, body: [...], more } 계열. 둘 다 방어적으로 처리.
export function extractArticleList(payload) {
  if (!payload || typeof payload !== 'object') return { list: [], more: false };
  const list =
    (Array.isArray(payload.result?.list) && payload.result.list) ||
    (Array.isArray(payload.body) && payload.body) ||
    (Array.isArray(payload.list) && payload.list) ||
    (Array.isArray(payload.articleList) && payload.articleList) ||
    (Array.isArray(payload.contents) && payload.contents) ||
    (Array.isArray(payload.items) && payload.items) ||
    (Array.isArray(payload) && payload) ||
    [];
  const more =
    payload.result?.moreDataYn === 'Y' ||
    payload.more === true ||
    payload.moreDataYn === 'Y' ||
    payload.isMoreData === true || // PC API (new.land.naver.com/api)
    payload.hasNext === true || payload.result?.hasNext === true || // fin front-api
    payload.hasNextPage === true || payload.result?.hasNextPage === true ||
    // more 플래그가 아예 없는 응답 변형: 페이지가 꽉 찼으면 계속 시도.
    (payload.result?.moreDataYn === undefined && payload.more === undefined &&
     payload.isMoreData === undefined && payload.hasNext === undefined &&
     payload.result?.hasNext === undefined && payload.hasNextPage === undefined &&
     payload.result?.hasNextPage === undefined && list.length >= 20);
  return { list, more };
}

// 폐기된 엔드포인트는 HTTP 200 + body `null` 을 반환 (2026-07 구 모바일 API 확인).
// 이를 "매물 0건"으로 오인하지 않도록 명시적 에러로 승격.
function assertLivePayload(payload, stage) {
  if (payload === null) {
    throw new NaverLandError(
      '엔드포인트가 null 을 반환 — API 폐기/변경 의심. `npm run realestate:probe` 로 진단하세요.',
      { stage },
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 단지 단위 — 전 페이지 수집
// ─────────────────────────────────────────────────────────────────────────────
export async function fetchAllComplexArticles({
  complexNo,
  tradeType,
  baseUrl = MOBILE_BASE,
  maxPages = DEFAULT_MAX_PAGES,
  rateLimiter,
  fetchImpl = fetch,
  logger = console,
  retryAttempts,
  sleepImpl,
} = {}) {
  if (!complexNo) throw new NaverLandError('fetchAllComplexArticles: complexNo 필수');
  if (!tradeType) throw new NaverLandError('fetchAllComplexArticles: tradeType 필수 (A1/B1)');
  const wait = rateLimiter ?? createRateLimiter();
  const articles = [];
  for (let page = 1; page <= maxPages; page += 1) {
    await wait();
    const url = `${baseUrl}${COMPLEX_ARTICLE_PATH}?` + new URLSearchParams({
      hscpNo: String(complexNo),
      tradTpCd: tradeType,
      order: 'prc',
      showR0: 'N',
      page: String(page),
    });
    const payload = await fetchJsonWithRetry(url, {
      fetchImpl, logger, retryAttempts, sleepImpl, stage: 'complex_articles',
    });
    assertLivePayload(payload, 'complex_articles');
    const { list, more } = extractArticleList(payload);
    for (const raw of list) {
      const a = normalizeArticle(raw);
      if (a) articles.push(a);
    }
    if (!more || list.length === 0) break;
  }
  return dedupeByArticleNo(articles);
}

// ─────────────────────────────────────────────────────────────────────────────
// 동(클러스터) 단위 — 전 페이지 수집 (영상 방법론: articleList XHR 페이지네이션)
// ─────────────────────────────────────────────────────────────────────────────
export async function fetchAllClusterArticles({
  cortarNo,
  lat,
  lon,
  zoom = 14,
  tradeTypes = 'A1:B1',
  rletTpCd = 'APT:JGC:ABYG',
  baseUrl = MOBILE_BASE,
  maxPages = DEFAULT_MAX_PAGES,
  rateLimiter,
  fetchImpl = fetch,
  logger = console,
  retryAttempts,
  sleepImpl,
} = {}) {
  if (!cortarNo) throw new NaverLandError('fetchAllClusterArticles: cortarNo(법정동코드) 필수');
  const wait = rateLimiter ?? createRateLimiter();
  const articles = [];
  for (let page = 1; page <= maxPages; page += 1) {
    await wait();
    const params = new URLSearchParams({
      rletTpCd,
      tradTpCd: tradeTypes,
      cortarNo: String(cortarNo),
      z: String(zoom),
      page: String(page),
      showR0: '',
    });
    if (lat != null) params.set('lat', String(lat));
    if (lon != null) params.set('lon', String(lon));
    const url = `${baseUrl}${CLUSTER_ARTICLE_PATH}?${params}`;
    const payload = await fetchJsonWithRetry(url, {
      fetchImpl, logger, retryAttempts, sleepImpl, stage: 'cluster_articles',
    });
    assertLivePayload(payload, 'cluster_articles');
    const { list, more } = extractArticleList(payload);
    for (const raw of list) {
      const a = normalizeArticle(raw);
      if (a) articles.push(a);
    }
    if (!more || list.length === 0) break;
  }
  return dedupeByArticleNo(articles);
}

function dedupeByArticleNo(articles) {
  const seen = new Map();
  for (const a of articles) {
    // 동일 매물번호 중복(페이지 경계 재조회 등) 시 확인일자 최신 우선.
    const prev = seen.get(a.articleNo);
    if (!prev || String(a.confirmedDate) > String(prev.confirmedDate)) seen.set(a.articleNo, a);
  }
  return [...seen.values()];
}

// ─────────────────────────────────────────────────────────────────────────────
// PC API (new.land.naver.com/api) — 2026-07 구 모바일 API 폐기(null 응답) 이후 1차 경로.
// Bearer 토큰 필요: new.land.naver.com 접속 → DevTools Network → 아무 /api/ 요청의
// authorization 헤더 복사 → .env RE_NAVER_TOKEN. ("Bearer " 접두어 포함/미포함 모두 허용)
// ─────────────────────────────────────────────────────────────────────────────
const PC_BASE = 'https://new.land.naver.com';
const PC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export function resolveNaverToken(env = process.env) {
  const raw = String(env.RE_NAVER_TOKEN ?? '').trim();
  if (!raw) return null;
  return raw.replace(/^Bearer\s+/i, '');
}

export async function fetchAllComplexArticlesPC({
  complexNo,
  tradeType,
  token,
  baseUrl = PC_BASE,
  maxPages = DEFAULT_MAX_PAGES,
  rateLimiter,
  fetchImpl = fetch,
  logger = console,
  retryAttempts = Number(process.env.RE_RETRY_ATTEMPTS ?? DEFAULT_RETRY_ATTEMPTS),
  sleepImpl = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  if (!complexNo) throw new NaverLandError('fetchAllComplexArticlesPC: complexNo 필수');
  if (!token) throw new NaverLandError('fetchAllComplexArticlesPC: token(RE_NAVER_TOKEN) 필수');
  const wait = rateLimiter ?? createRateLimiter();
  const headers = {
    'user-agent': PC_UA,
    'accept': 'application/json',
    'authorization': `Bearer ${token}`,
    'referer': `${baseUrl}/complexes/${complexNo}`,
  };
  const articles = [];
  for (let page = 1; page <= maxPages; page += 1) {
    await wait();
    const url = `${baseUrl}/api/articles/complex/${complexNo}?` + new URLSearchParams({
      realEstateType: 'APT:ABYG:JGC',
      tradeType,
      complexNo: String(complexNo),
      type: 'list',
      order: 'prc',
      page: String(page),
      priceType: 'RETAIL',
    });
    let payload;
    for (let attempt = 0; ; attempt += 1) {
      const res = await fetchImpl(url, { headers });
      const text = await res.text();
      if (res.status === 401 || res.status === 403) {
        throw new NaverLandError(
          `PC API 인증 실패 ${res.status} — RE_NAVER_TOKEN 만료/오류. ` +
          'new.land.naver.com DevTools 에서 토큰을 다시 복사하세요.',
          { status: res.status, stage: 'pc_articles' },
        );
      }
      if (res.status === 429 || res.status >= 500) {
        if (attempt >= retryAttempts) {
          throw new NaverLandError(`PC API HTTP ${res.status}`, { status: res.status, stage: 'pc_articles' });
        }
        const backoff = 3000 * 2 ** attempt;
        logger.warn?.(`[naver_land] ⚠ PC API ${res.status} — ${backoff}ms 후 재시도`);
        await sleepImpl(backoff);
        continue;
      }
      if (/^\s*</.test(text)) {
        throw new NaverLandError('PC API 가 HTML 반환 (캡차/차단 의심)', { status: res.status, stage: 'pc_articles' });
      }
      try { payload = JSON.parse(text); } catch {
        throw new NaverLandError(`PC API JSON 파싱 실패: ${text.slice(0, 200)}`, { stage: 'pc_articles' });
      }
      break;
    }
    assertLivePayload(payload, 'pc_articles');
    const { list, more } = extractArticleList(payload);
    for (const raw of list) {
      const a = normalizeArticle(raw);
      if (a) articles.push(a);
    }
    if (!more || list.length === 0) break;
  }
  return dedupeByArticleNo(articles);
}

// ─────────────────────────────────────────────────────────────────────────────
// fin.land front-api (네이버페이 부동산) — 2026-07 기준 1차 경로. 토큰 불필요.
// 핵심: complexNumber 는 "숫자 문자열" (zod: /^\d{1,9}$/), size ≤ 30,
//        NNB 쿠키 필요 → 홈 1회 GET 으로 부트스트랩 (프로세스 내 공유).
// ─────────────────────────────────────────────────────────────────────────────
const FIN_BASE = 'https://fin.land.naver.com';
const FIN_LIST_PATH = '/front-api/v1/complex/article/list';
const finJar = new Map();

function absorbSetCookies(res, jar = finJar) {
  for (const c of res.headers?.getSetCookie?.() ?? []) {
    const [pair] = c.split(';');
    const eq = pair.indexOf('=');
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

export function _clearFinCookiesForTests() { finJar.clear(); }

async function ensureFinCookies({ baseUrl = FIN_BASE, fetchImpl = fetch } = {}) {
  if (finJar.size > 0) return;
  const res = await fetchImpl(`${baseUrl}/`, {
    headers: {
      'user-agent': PC_UA,
      accept: 'text/html,application/xhtml+xml',
      'accept-language': 'ko-KR,ko;q=0.9',
    },
    redirect: 'follow',
  });
  absorbSetCookies(res);
  await res.text?.().catch?.(() => {});
}

function finHeaders(complexNo) {
  return {
    'user-agent': PC_UA,
    accept: 'application/json',
    'content-type': 'application/json',
    'accept-language': 'ko-KR,ko;q=0.9',
    origin: FIN_BASE,
    referer: `${FIN_BASE}/complexes/${complexNo}`,
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    ...(finJar.size ? { cookie: [...finJar.entries()].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
  };
}

export async function fetchAllComplexArticlesFin({
  complexNo,
  tradeType,
  baseUrl = FIN_BASE,
  maxPages = DEFAULT_MAX_PAGES,
  pageSize = 30,
  rateLimiter,
  fetchImpl = fetch,
  logger = console,
  retryAttempts = Number(process.env.RE_RETRY_ATTEMPTS ?? DEFAULT_RETRY_ATTEMPTS),
  sleepImpl = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  if (!complexNo) throw new NaverLandError('fetchAllComplexArticlesFin: complexNo 필수');
  if (!tradeType) throw new NaverLandError('fetchAllComplexArticlesFin: tradeType 필수 (A1/B1)');
  await ensureFinCookies({ baseUrl, fetchImpl });
  const wait = rateLimiter ?? createRateLimiter();
  const articles = [];
  for (let page = 1; page <= maxPages; page += 1) {
    await wait();
    const body = JSON.stringify({
      complexNumber: String(complexNo), // 문자열 필수 (zod numeric string)
      tradeTypes: [tradeType],
      page,
      size: pageSize,
      userChannelType: 'PC',
    });
    let payload;
    for (let attempt = 0; ; attempt += 1) {
      const res = await fetchImpl(`${baseUrl}${FIN_LIST_PATH}`, {
        method: 'POST', headers: finHeaders(complexNo), body,
      });
      absorbSetCookies(res);
      const text = await res.text();
      const retriable = res.status === 429 || res.status >= 500 ||
        text.includes('TOO_MANY_REQUESTS');
      if (retriable) {
        if (attempt >= retryAttempts) {
          throw new NaverLandError(`fin API ${res.status}: ${text.slice(0, 120)}`, {
            status: res.status, stage: 'fin_articles',
          });
        }
        const backoff = 3000 * 2 ** attempt;
        logger.warn?.(`[naver_land] ⚠ fin API ${res.status} — ${backoff}ms 후 재시도`);
        await sleepImpl(backoff);
        continue;
      }
      if (/^\s*</.test(text)) {
        throw new NaverLandError('fin API 가 HTML 반환 (차단 의심)', { status: res.status, stage: 'fin_articles' });
      }
      try { payload = JSON.parse(text); } catch {
        throw new NaverLandError(`fin API JSON 파싱 실패: ${text.slice(0, 200)}`, { stage: 'fin_articles' });
      }
      // 성공 응답도 detailCode:"success" 를 포함 — 실패 판정은 isSuccess/비-success 코드만.
      const isFailure = !res.ok ||
        payload?.isSuccess === false ||
        (payload?.detailCode && payload.detailCode !== 'success');
      if (isFailure) {
        throw new NaverLandError(
          `fin API ${res.status} ${payload?.detailCode ?? ''}: ${text.slice(0, 200)}`,
          { status: res.status, stage: 'fin_articles' },
        );
      }
      break;
    }
    assertLivePayload(payload, 'fin_articles');
    const { list, more } = extractArticleList(payload.result ?? payload);
    let rawCount = 0;
    for (const item of list) {
      rawCount += 1;
      // fin API 는 매물 정보가 한 겹 안에 있음 (representativeArticleInfo).
      // 가격 등 일부 필드는 item 레벨의 형제 키일 수 있어 병합해서 정규화.
      const wrapped = item?.representativeArticleInfo ?? item?.articleInfo;
      const unwrapped = wrapped ? { ...item, ...wrapped } : item;
      const a = normalizeArticle(unwrapped);
      if (a) {
        if (!a.tradeType) a.tradeType = tradeType; // 요청 필터 기준 보정
        articles.push(a);
      }
    }
    // 스키마 불일치 자동 진단: 목록은 왔는데 정규화가 핵심 값을 놓치면 RAW 를 로그로 노출.
    if (page === 1 && list.length > 0) {
      const first = articles[0];
      const lossy = articles.length === 0 || first?.priceManwon == null || first?.supplyArea == null;
      if (lossy || process.env.RE_DEBUG_RAW === '1') {
        logger.warn?.(`[naver_land] RAW 샘플(정규화 점검용): ${JSON.stringify(list[0]).slice(0, 1600)}`);
      }
    }
    if (!more || rawCount === 0) break;
  }
  return dedupeByArticleNo(articles);
}

// 자동 선택 (2026-07 기준): fin front-api 가 1차. RE_NAVER_TOKEN 이 명시된 경우에만
// PC API 시도 (new.land 는 페이지 404 — API 도 폐기 가능성 높음). 구 모바일 API 는 폐기.
export async function fetchComplexArticlesAuto({ env = process.env, ...opts } = {}) {
  const token = resolveNaverToken(env);
  if (token) {
    try {
      return await fetchAllComplexArticlesPC({ ...opts, token });
    } catch (err) {
      opts.logger?.warn?.(`[naver_land] PC API 실패(${err.message}) — fin API 로 폴백`);
    }
  }
  return fetchAllComplexArticlesFin(opts);
}

// ─────────────────────────────────────────────────────────────────────────────
// 연속 실패 감시 — 차단 의심 시 전체 중단용 카운터
// ─────────────────────────────────────────────────────────────────────────────
export function createFailureGuard({ limit = CONSECUTIVE_FAILURE_LIMIT } = {}) {
  let consecutive = 0;
  return {
    ok() { consecutive = 0; },
    fail() {
      consecutive += 1;
      if (consecutive >= limit) {
        throw new NaverLandError(
          `연속 ${consecutive}회 실패 — 차단 의심으로 전체 중단 (부분 결과만 기록)`,
          { stage: 'failure_guard' },
        );
      }
    },
    get count() { return consecutive; },
  };
}

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parsePriceToManwon,
  parseFloorInfo,
  normalizeArticle,
  extractArticleList,
  fetchAllComplexArticles,
  fetchAllClusterArticles,
  createRateLimiter,
  createFailureGuard,
  TRADE_TYPE,
} from '../../src/real_estate/naver_land_client.js';

// ─── 가격 파서 ───────────────────────────────────────────────────────────────
test('parsePriceToManwon: 억+만 조합', () => {
  assert.equal(parsePriceToManwon('6억 5,000'), 65000);
  assert.equal(parsePriceToManwon('6억'), 60000);
  assert.equal(parsePriceToManwon('3억5,000'), 35000);
  assert.equal(parsePriceToManwon('1억 2,500'), 12500);
  assert.equal(parsePriceToManwon('45,000'), 45000);
  assert.equal(parsePriceToManwon('12억 500'), 120500);
});

test('parsePriceToManwon: 숫자(만원) 통과, 이상 입력 null', () => {
  assert.equal(parsePriceToManwon(45000), 45000);
  assert.equal(parsePriceToManwon(0), null);
  assert.equal(parsePriceToManwon(''), null);
  assert.equal(parsePriceToManwon('-'), null);
  assert.equal(parsePriceToManwon(null), null);
  assert.equal(parsePriceToManwon('가격문의'), null);
});

// ─── 층 파서 ────────────────────────────────────────────────────────────────
test('parseFloorInfo: 숫자층/문자층/미상', () => {
  assert.deepEqual(parseFloorInfo('3/15'), { floor: '3', totalFloor: 15 });
  assert.deepEqual(parseFloorInfo('저/15'), { floor: '저', totalFloor: 15 });
  assert.deepEqual(parseFloorInfo('-/15'), { floor: null, totalFloor: 15 });
  assert.deepEqual(parseFloorInfo(null), { floor: null, totalFloor: null });
  assert.deepEqual(parseFloorInfo('고층'), { floor: '고층', totalFloor: null });
});

// ─── 정규화 ─────────────────────────────────────────────────────────────────
test('normalizeArticle: 단지 API shape (prcInfo/flrInfo/spc1)', () => {
  const a = normalizeArticle({
    atclNo: '123', atclNm: '강서한강자이', tradTpCd: 'A1', prcInfo: '13억 5,000',
    flrInfo: '12/20', spc1: '87.3', spc2: '59.9', cfmYmd: '26.07.15', bildNm: '101동',
  });
  assert.equal(a.articleNo, '123');
  assert.equal(a.priceManwon, 135000);
  assert.equal(a.floor, '12');
  assert.equal(a.supplyArea, 87.3);
});

test('normalizeArticle: 클러스터 API shape (prc 숫자)', () => {
  const a = normalizeArticle({ atclNo: '9', atclNm: '우방', tradTpCd: 'B1', prc: 32000, spc1: 82.58, flrInfo: '저/15' });
  assert.equal(a.priceManwon, 32000);
  assert.equal(a.floor, '저');
});

test('normalizeArticle: atclNo 없으면 null', () => {
  assert.equal(normalizeArticle({ atclNm: 'x' }), null);
  assert.equal(normalizeArticle(null), null);
});

// ─── 응답 shape 흡수 ─────────────────────────────────────────────────────────
test('extractArticleList: result.list + moreDataYn', () => {
  const { list, more } = extractArticleList({ result: { list: [{ a: 1 }], moreDataYn: 'Y' } });
  assert.equal(list.length, 1);
  assert.equal(more, true);
  assert.equal(extractArticleList({ result: { list: [], moreDataYn: 'N' } }).more, false);
});

test('extractArticleList: body 배열 + more 플래그', () => {
  const { list, more } = extractArticleList({ code: 'success', body: [{ a: 1 }], more: false });
  assert.equal(list.length, 1);
  assert.equal(more, false);
});

// ─── 페이지네이션 (mock fetch) ───────────────────────────────────────────────
const noWait = async () => {};
const jsonRes = (obj) => ({
  ok: true, status: 200,
  headers: { get: () => null },
  text: async () => JSON.stringify(obj),
});

test('fetchAllComplexArticles: moreDataYn 따라 전 페이지 수집 + 중복 제거', async () => {
  const pages = [
    { result: { list: [{ atclNo: '1', prcInfo: '5억', tradTpCd: 'A1' }, { atclNo: '2', prcInfo: '6억', tradTpCd: 'A1' }], moreDataYn: 'Y' } },
    { result: { list: [{ atclNo: '2', prcInfo: '6억', tradTpCd: 'A1' }, { atclNo: '3', prcInfo: '7억', tradTpCd: 'A1' }], moreDataYn: 'N' } },
  ];
  const calls = [];
  const fetchImpl = async (url) => { calls.push(url); return jsonRes(pages[calls.length - 1]); };
  const out = await fetchAllComplexArticles({
    complexNo: '103293', tradeType: TRADE_TYPE.SALE, rateLimiter: noWait, fetchImpl, logger: { warn() {} },
  });
  assert.equal(calls.length, 2);
  assert.ok(calls[0].includes('hscpNo=103293'));
  assert.ok(calls[0].includes('tradTpCd=A1'));
  assert.equal(out.length, 3);
});

test('fetchAllClusterArticles: cortarNo 쿼리 + body 수집', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return jsonRes({ body: [{ atclNo: String(calls.length), prc: 50000, tradTpCd: 'A1' }], more: calls.length < 2 });
  };
  const out = await fetchAllClusterArticles({
    cortarNo: '1150010400', lat: 37.56, lon: 126.85, rateLimiter: noWait, fetchImpl, logger: { warn() {} },
  });
  assert.equal(calls.length, 2);
  assert.ok(calls[0].includes('cortarNo=1150010400'));
  assert.equal(out.length, 2);
});

test('fetchAllComplexArticles: 429 후 재시도 성공', async () => {
  let n = 0;
  const fetchImpl = async () => {
    n += 1;
    if (n === 1) return { ok: false, status: 429, headers: { get: () => '0' }, text: async () => '' };
    return jsonRes({ result: { list: [{ atclNo: '1', prcInfo: '5억', tradTpCd: 'A1' }], moreDataYn: 'N' } });
  };
  const out = await fetchAllComplexArticles({
    complexNo: '1', tradeType: 'A1', rateLimiter: noWait, fetchImpl,
    logger: { warn() {} }, sleepImpl: async () => {}, retryAttempts: 2,
  });
  assert.equal(out.length, 1);
  assert.equal(n, 2);
});

test('fetchAllComplexArticles: HTML(캡차) 응답 시 즉시 실패', async () => {
  const fetchImpl = async () => ({
    ok: true, status: 200, headers: { get: () => null }, text: async () => '<html>captcha</html>',
  });
  await assert.rejects(
    fetchAllComplexArticles({ complexNo: '1', tradeType: 'A1', rateLimiter: noWait, fetchImpl, logger: { warn() {} } }),
    /캡차/,
  );
});

// ─── rate limiter / failure guard ────────────────────────────────────────────
test('createRateLimiter: 첫 호출은 즉시, 연속 호출은 지연', async () => {
  const slept = [];
  const wait = createRateLimiter({ delayMs: 100, jitterRatio: 0, sleepImpl: async (ms) => slept.push(ms) });
  await wait(); // 첫 호출 — 지연 없음
  await wait(); // 직전 호출과의 간격 보정
  assert.equal(slept.length, 1);
  assert.ok(slept[0] > 0 && slept[0] <= 100);
});

test('createFailureGuard: 연속 실패 임계 도달 시 throw, ok 로 리셋', () => {
  const g = createFailureGuard({ limit: 3 });
  g.fail(); g.fail(); g.ok(); g.fail(); g.fail();
  assert.throws(() => g.fail(), /연속 3회 실패/);
});

// ─── 엔드포인트 폐기(null 응답) 감지 + PC API ────────────────────────────────
test('fetchAllComplexArticles: null 응답은 매물 0건이 아니라 에러', async () => {
  const fetchImpl = async () => jsonRes(null);
  await assert.rejects(
    fetchAllComplexArticles({ complexNo: '1', tradeType: 'A1', rateLimiter: noWait, fetchImpl, logger: { warn() {} } }),
    /null.*폐기/s,
  );
});

test('fetchAllComplexArticlesPC: authorization 헤더 + articleList/isMoreData 페이지네이션', async () => {
  const { fetchAllComplexArticlesPC } = await import('../../src/real_estate/naver_land_client.js');
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const page = calls.length;
    return jsonRes({
      articleList: [{ articleNo: `pc${page}`, articleName: '자이', tradeTypeCode: 'A1',
        dealOrWarrantPrc: '13억 5,000', floorInfo: '12/20', area1: 87.3, articleConfirmYmd: '26.07.15' }],
      isMoreData: page < 2,
    });
  };
  const out = await fetchAllComplexArticlesPC({
    complexNo: '103293', tradeType: 'A1', token: 'tok-x', rateLimiter: noWait, fetchImpl, logger: { warn() {} },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.headers.authorization, 'Bearer tok-x');
  assert.ok(calls[0].url.includes('/api/articles/complex/103293'));
  assert.equal(out.length, 2);
  assert.equal(out[0].priceManwon, 135000);
  assert.equal(out[0].floor, '12');
});

test('fetchAllComplexArticlesPC: 401 → 토큰 만료 안내 에러', async () => {
  const { fetchAllComplexArticlesPC } = await import('../../src/real_estate/naver_land_client.js');
  const fetchImpl = async () => ({ ok: false, status: 401, headers: { get: () => null }, text: async () => '{}' });
  await assert.rejects(
    fetchAllComplexArticlesPC({ complexNo: '1', tradeType: 'A1', token: 't', rateLimiter: noWait, fetchImpl, logger: { warn() {} } }),
    /RE_NAVER_TOKEN/,
  );
});

test('resolveNaverToken: Bearer 접두어 허용 + 미설정 시 null', async () => {
  const { resolveNaverToken } = await import('../../src/real_estate/naver_land_client.js');
  assert.equal(resolveNaverToken({ RE_NAVER_TOKEN: 'Bearer abc.def' }), 'abc.def');
  assert.equal(resolveNaverToken({ RE_NAVER_TOKEN: 'abc.def' }), 'abc.def');
  assert.equal(resolveNaverToken({}), null);
});

test('fetchComplexArticlesAuto: 토큰 있으면 PC API 경로 선택', async () => {
  const { fetchComplexArticlesAuto } = await import('../../src/real_estate/naver_land_client.js');
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(url);
    return jsonRes({ articleList: [], isMoreData: false });
  };
  await fetchComplexArticlesAuto({
    env: { RE_NAVER_TOKEN: 'tok' }, complexNo: '9', tradeType: 'A1', rateLimiter: noWait, fetchImpl, logger: { warn() {} },
  });
  assert.ok(calls[0].includes('new.land.naver.com/api/articles/complex/9'));
});

// ─── fin.land front-api ──────────────────────────────────────────────────────
test('fetchAllComplexArticlesFin: complexNumber 문자열 body + 쿠키 부트스트랩', async () => {
  const { fetchAllComplexArticlesFin, _clearFinCookiesForTests } = await import('../../src/real_estate/naver_land_client.js');
  _clearFinCookiesForTests();
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (!init.method) { // 홈 부트스트랩 GET
      return { ok: true, status: 200,
        headers: { getSetCookie: () => ['NNB=TESTCOOKIE; Path=/'], get: () => null },
        text: async () => '' };
    }
    return { ok: true, status: 200,
      headers: { getSetCookie: () => [], get: () => null },
      text: async () => JSON.stringify({ isSuccess: true, detailCode: 'success', result: {
        list: [{ articleNumber: '2412345678', complexName: '강서한강자이',
          tradeType: { code: 'A1', name: '매매' },
          priceInfo: { dealPrice: 135000 }, floor: 12, totalFloor: 20,
          spaceInfo: { supplySpace: 87.3, exclusiveSpace: 59.9 }, confirmedYmd: '2026-07-15' }],
        hasNextPage: false,
      } }) };
  };
  const out = await fetchAllComplexArticlesFin({
    complexNo: '103293', tradeType: 'A1', rateLimiter: async () => {}, fetchImpl, logger: { warn() {} },
  });
  // 첫 호출은 홈(GET), 둘째는 API(POST) — body 의 complexNumber 는 문자열
  assert.equal(calls.length, 2);
  const apiCall = calls[1];
  assert.ok(apiCall.url.includes('/front-api/v1/complex/article/list'));
  const body = JSON.parse(apiCall.init.body);
  assert.strictEqual(body.complexNumber, '103293');
  assert.deepEqual(body.tradeTypes, ['A1']);
  assert.ok(apiCall.init.headers.cookie.includes('NNB=TESTCOOKIE'));
  assert.equal(out.length, 1);
  assert.equal(out[0].priceManwon, 135000);
  assert.equal(out[0].floor, '12');
  assert.equal(out[0].supplyArea, 87.3);
  _clearFinCookiesForTests();
});

test('fetchAllComplexArticlesFin: TOO_MANY_REQUESTS → 백오프 재시도', async () => {
  const { fetchAllComplexArticlesFin, _clearFinCookiesForTests } = await import('../../src/real_estate/naver_land_client.js');
  _clearFinCookiesForTests();
  let apiCalls = 0;
  const fetchImpl = async (url, init = {}) => {
    if (!init.method) return { ok: true, status: 200, headers: { getSetCookie: () => ['NNB=x'], get: () => null }, text: async () => '' };
    apiCalls += 1;
    if (apiCalls === 1) {
      return { ok: false, status: 429, headers: { getSetCookie: () => [], get: () => null },
        text: async () => '{"detailCode":"TOO_MANY_REQUESTS","message":""}' };
    }
    return { ok: true, status: 200, headers: { getSetCookie: () => [], get: () => null },
      text: async () => JSON.stringify({ result: { list: [], hasNextPage: false } }) };
  };
  const out = await fetchAllComplexArticlesFin({
    complexNo: '1', tradeType: 'B1', rateLimiter: async () => {}, fetchImpl,
    logger: { warn() {} }, sleepImpl: async () => {}, retryAttempts: 2,
  });
  assert.equal(apiCalls, 2);
  assert.deepEqual(out, []);
  _clearFinCookiesForTests();
});

test('fetchComplexArticlesAuto: 토큰 없으면 fin API 경로', async () => {
  const { fetchComplexArticlesAuto, _clearFinCookiesForTests } = await import('../../src/real_estate/naver_land_client.js');
  _clearFinCookiesForTests();
  const urls = [];
  const fetchImpl = async (url, init = {}) => {
    urls.push(String(url));
    if (!init.method) return { ok: true, status: 200, headers: { getSetCookie: () => ['NNB=x'], get: () => null }, text: async () => '' };
    return { ok: true, status: 200, headers: { getSetCookie: () => [], get: () => null },
      text: async () => JSON.stringify({ result: { list: [], hasNextPage: false } }) };
  };
  await fetchComplexArticlesAuto({
    env: {}, complexNo: '9', tradeType: 'A1', rateLimiter: async () => {}, fetchImpl, logger: { warn() {} },
  });
  assert.ok(urls.some((u) => u.includes('fin.land.naver.com/front-api')));
  _clearFinCookiesForTests();
});

// ─── fin 실응답 스키마 (2026-07-20 RAW 샘플 기준) ────────────────────────────
test('normalizeArticle: fin representativeArticleInfo 실스키마', () => {
  const a = normalizeArticle({
    complexName: '강서한강자이', articleNumber: '2635088491', articleName: '강서한강자이',
    dongName: '104', tradeType: 'B1', realEstateType: 'A01',
    spaceInfo: { supplySpace: 156.89, contractSpace: 235.46, exclusiveSpace: 124.42 },
    verificationInfo: { exposureStartDate: '2026-06-30', articleConfirmDate: '2026-06-30' },
    brokerInfo: { brokerageName: '강서한강자이공인중개사사무소' },
    articleDetail: { direction: 'ES', articleFeatureDescription: '막힘없는 전망', floorInfo: '저/21' },
    priceInfo: { warrantyPrice: 90000 },
  });
  assert.equal(a.articleNo, '2635088491');
  assert.equal(a.tradeType, 'B1');
  assert.equal(a.priceManwon, 90000);
  assert.equal(a.floor, '저');
  assert.equal(a.totalFloor, 21);
  assert.equal(a.supplyArea, 156.89);
  assert.equal(a.exclusiveArea, 124.42);
  assert.equal(a.confirmedDate, '2026-06-30');
  assert.equal(a.buildingName, '104');
  assert.equal(a.realtorName, '강서한강자이공인중개사사무소');
});

test('parsePriceToManwon: 원(₩) 단위 자동 환산', () => {
  assert.equal(parsePriceToManwon(1350000000), 135000); // 13.5억 원 → 만원
  assert.equal(parsePriceToManwon(300000000), 30000);   // 3억 원
  assert.equal(parsePriceToManwon(135000), 135000);      // 이미 만원 단위면 그대로
});

// fin API 는 매매 응답에 warrantyPrice=0, 전세 응답에 dealPrice=0 을 함께 실어보낸다.
// 과거 ?? 체인은 0 을 유효 값으로 취급 → parsePriceToManwon(0)=null 로 전세 가격이 유실됐다.
test('normalizeArticle: fin 전세(B1) — dealPrice=0 + warrantyPrice 만 채워짐', () => {
  const a = normalizeArticle({
    articleNumber: '2638767019', articleName: '가양우성',
    tradeType: 'B1', spaceInfo: { supplySpace: 101.62, exclusiveSpace: 84.85 },
    priceInfo: { dealPrice: 0, warrantyPrice: 670000000, rentPrice: 0 },
    articleDetail: { floorInfo: '9/15' },
  });
  assert.equal(a.tradeType, 'B1');
  assert.equal(a.priceManwon, 67000); // 6.7억
  assert.equal(a.supplyArea, 101.62);
  assert.equal(a.floor, '9');
});

test('normalizeArticle: fin 매매(A1) — warrantyPrice=0 + dealPrice 만 채워짐', () => {
  const a = normalizeArticle({
    articleNumber: '2600000001', articleName: '가양우성',
    tradeType: 'A1', spaceInfo: { supplySpace: 84 },
    priceInfo: { dealPrice: 950000000, warrantyPrice: 0, rentPrice: 0 },
    articleDetail: { floorInfo: '3/15' },
  });
  assert.equal(a.tradeType, 'A1');
  assert.equal(a.priceManwon, 95000); // 9.5억
});

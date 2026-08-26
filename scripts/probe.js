#!/usr/bin/env node
// 부동산 시세 자동화 — 네이버 엔드포인트 자동 탐색 진단 v3
// 사용: npm run realestate:probe        (기본 단지 103293 = 강서한강자이)
// v2 결과: front-api 는 살아있으나(쿠키 후 400) 요청 형식 미상, 페이지는 map SPA.
// v3: map SPA 의 JS 번들을 내려받아 front-api 호출 코드를 grep → 정확한
//      요청 형식(경로/필드/enum)을 자동 추출 + 형식 후보 매트릭스 시도.

import process from 'node:process';

const argv = process.argv.slice(2);
const ci = argv.indexOf('--complex');
const complexNo = ci >= 0 && argv[ci + 1] ? argv[ci + 1] : '103293';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const jar = new Map();
function absorbCookies(res) {
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(';');
    const eq = pair.indexOf('=');
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}
const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
const baseHeaders = () => ({
  'user-agent': UA,
  'accept-language': 'ko-KR,ko;q=0.9',
  ...(jar.size ? { cookie: cookieHeader() } : {}),
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const squash = (s) => s.replaceAll(/\s+/g, ' ');

console.log(`[realestate:probe v3] 단지 ${complexNo}\n`);

// 1) 쿠키 부트스트랩 + 단지 페이지(→ map SPA) HTML
let html = '';
try {
  const home = await fetch('https://fin.land.naver.com/', {
    headers: { ...baseHeaders(), accept: 'text/html' }, redirect: 'follow',
  });
  absorbCookies(home);
  await home.text();
  await sleep(1200);
  const res = await fetch(`https://fin.land.naver.com/complexes/${complexNo}`, {
    headers: { ...baseHeaders(), accept: 'text/html', referer: 'https://fin.land.naver.com/' },
    redirect: 'follow',
  });
  absorbCookies(res);
  html = await res.text();
  console.log(`── 1. 페이지 로드: HTTP ${res.status} | ${html.length} bytes | 쿠키 ${jar.size}개`);
  console.log(`   최종 URL: ${res.url}\n`);
} catch (err) { console.log(`── 1. 페이지 로드 ✖ ${err.message}\n`); }

// 2) JS 번들 수집 → front-api 호출 코드 grep
const scriptUrls = [...new Set(
  [...html.matchAll(/<(?:script|link)[^>]+(?:src|href)="([^"]+\.js[^"]*)"/g)]
    .map((m) => m[1])
    .map((u) => (u.startsWith('http') ? u : `https://fin.land.naver.com${u.startsWith('/') ? '' : '/'}${u}`)),
)];
console.log(`── 2. JS 번들 ${scriptUrls.length}개 발견 — front-api 호출 코드 스캔`);
const KEYS = ['front-api', 'article/list', 'complexNumber', 'tradeTypes'];
let printed = 0;
for (const url of scriptUrls.slice(0, 30)) {
  if (printed >= 14) break;
  try {
    const res = await fetch(url, { headers: baseHeaders() });
    if (!res.ok) { console.log(`   (skip ${res.status}) ${url.slice(0, 100)}`); continue; }
    const js = await res.text();
    const hits = [];
    for (const key of KEYS) {
      let idx = -1;
      while ((idx = js.indexOf(key, idx + 1)) >= 0 && hits.length < 6) {
        hits.push(squash(js.slice(Math.max(0, idx - 120), idx + 260)));
      }
    }
    if (hits.length > 0) {
      console.log(`\n   ▼ ${url.slice(0, 110)}`);
      for (const h of [...new Set(hits)].slice(0, 6)) {
        if (printed >= 14) break;
        console.log(`     … ${h} …`);
        printed += 1;
      }
    }
  } catch (err) { console.log(`   (fetch 실패) ${url.slice(0, 80)}: ${err.message}`); }
  await sleep(400);
}
if (printed === 0) console.log('   ✗ 번들에서 front-api 관련 코드 미발견 (동적 로딩 chunk 일 수 있음)');
console.log('');

// 3) 요청 형식 후보 매트릭스
const apiHeaders = () => ({
  ...baseHeaders(),
  accept: 'application/json',
  'content-type': 'application/json',
  origin: 'https://fin.land.naver.com',
  referer: 'https://fin.land.naver.com/map',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
});
const LIST_URL = 'https://fin.land.naver.com/front-api/v1/complex/article/list';
// v3 번들 스캔 결과: complexNumber 는 "숫자 문자열"(zod /^\d{1,9}$/), tradeTypes 는 A1/B1, size ≤ 30.
const variants = [
  ['3a. 매매 (문자열 complexNumber)', { complexNumber: String(complexNo), tradeTypes: ['A1'], page: 1, size: 30, userChannelType: 'PC' }],
  ['3b. 전세', { complexNumber: String(complexNo), tradeTypes: ['B1'], page: 1, size: 30, userChannelType: 'PC' }],
  ['3c. userChannelType 없이', { complexNumber: String(complexNo), tradeTypes: ['A1'], page: 1, size: 30 }],
];
console.log('── 3. 요청 형식 (v3 스캔으로 확정된 스키마)');
for (const [label, body] of variants) {
  try {
    const res = await fetch(LIST_URL, {
      method: 'POST', headers: apiHeaders(), body: JSON.stringify(body),
    });
    absorbCookies(res);
    const text = await res.text();
    const ok = res.status === 200 && !text.includes('detailCode');
    // 성공 응답은 길게 출력 — 매물 필드명(가격/층/면적) 확정용.
    console.log(`   ${label}: HTTP ${res.status} | ${squash(text).slice(0, ok ? 2200 : 220)}`);
  } catch (err) { console.log(`   ${label}: ✖ ${err.message}`); }
  await sleep(2000);
}

console.log('\n[realestate:probe v3] 완료 — 위 출력 전체를 복사해서 공유해 주세요.');

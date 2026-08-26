import test from 'node:test';
import assert from 'node:assert/strict';

import {
  cleanRow,
  buildApartments,
  assignDongColors,
  renderAppJsx,
} from '../../src/real_estate/report_generator.js';

// 순위 탭 스키마(RANKING_HEADERS, 22컬럼): 순위,동,단지명,입주연도,총세대수,공급(m2),
// 공급면적,전용(m2),전용면적,세대,매매최저가,층,전세최고가,층,매전갭,전세가율,
// 매매평단,전세평단,방,욕실,구조,Type
function row({
  dong = '가양동', name = '테스트단지', sale = 50000, jeonse = '',
} = {}) {
  return [1, dong, name, '20.01', 500, 80, 24, 60, 18, 10,
    sale, '5', jeonse, jeonse ? '3' : '',
    '', '', 2000, jeonse ? 1500 : '', 3, 2, '계', '84A'];
}

test('cleanRow: 매매가 없으면 null (제외 대상)', () => {
  assert.equal(cleanRow(row({ sale: '' }), 1), null);
});

test('cleanRow: 전세 없으면 gap/rate null, sale 은 억 단위로 변환', () => {
  const a = cleanRow(row({ sale: 50000, jeonse: '' }), 1);
  assert.equal(a.sale, 5);
  assert.equal(a.jeonse, null);
  assert.equal(a.gap, null);
  assert.equal(a.rate, null);
});

test('cleanRow: 정상 매매+전세 → gap/rate 계산', () => {
  const a = cleanRow(row({ sale: 50000, jeonse: 30000 }), 1);
  assert.equal(a.sale, 5);
  assert.equal(a.jeonse, 3);
  assert.equal(a.gap, 2);
  assert.equal(a.rate, 60);
});

test('cleanRow: 전세가 매매가보다 높아 갭이 음수면 gap/rate 만 null, 가격은 유지', () => {
  const a = cleanRow(row({ sale: 35900, jeonse: 38000 }), 1);
  assert.equal(a.sale, 3.59);
  assert.equal(a.jeonse, 3.8);
  assert.equal(a.gap, null);
  assert.equal(a.rate, null);
});

test('buildApartments: 헤더 행 스킵 + 매매가 없는 행 제외 + 순차 id 부여', () => {
  const rows = [
    ['헤더', '동', '단지명'], // header row, ignored
    row({ dong: 'A동', name: '단지1', sale: 90000 }),
    row({ dong: 'A동', name: '단지2', sale: '' }), // no sale → excluded
    row({ dong: 'B동', name: '단지3', sale: 30000, jeonse: 20000 }),
  ];
  const apartments = buildApartments(rows);
  assert.equal(apartments.length, 2);
  assert.deepEqual(apartments.map((a) => a.id), [1, 2]);
  assert.deepEqual(apartments.map((a) => a.name), ['단지1', '단지3']);
});

test('assignDongColors: 첫 등장 순서대로 팔레트 색상 배정, 중복 동은 재사용', () => {
  const apartments = buildApartments([
    ['헤더'],
    row({ dong: 'A동', sale: 10000 }),
    row({ dong: 'B동', sale: 20000 }),
    row({ dong: 'A동', sale: 30000 }),
  ]);
  const colors = assignDongColors(apartments);
  assert.deepEqual(Object.keys(colors), ['A동', 'B동']);
  assert.notEqual(colors['A동'], colors['B동']);
});

test('renderAppJsx: 생성된 텍스트에서 데이터 배열을 다시 파싱하면 원본과 개수/값이 일치', () => {
  const apartments = buildApartments([
    ['헤더'],
    row({ dong: '가양동', name: '단지A', sale: 90000, jeonse: 60000 }),
    row({ dong: '공항동', name: '단지B', sale: 50000 }),
  ]);
  const dongColors = assignDongColors(apartments);
  const jsx = renderAppJsx({
    apartments, title: '테스트 지역', subtitleDongs: Object.keys(dongColors), dongColors,
  });

  assert.match(jsx, /const APARTMENTS = /);
  assert.match(jsx, /export default function App/);

  const start = jsx.indexOf('const APARTMENTS = ') + 'const APARTMENTS = '.length;
  const end = jsx.indexOf(';\n\nconst REPORT_TITLE');
  const parsed = JSON.parse(jsx.slice(start, end));
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].name, '단지A');
  assert.equal(parsed[0].gap, 3);
  assert.equal(parsed[1].gap, null);
});

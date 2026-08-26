import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  findHeaderColumns,
  parseNaverLandLink,
  extractTargets,
  columnLetter,
} from '../../src/real_estate/row_parser.js';

// 실제 동 시트 구조 축약본 (헤더 앞에 제목/빈 행, 우측 요약 블록에 단지명 중복)
const HEADER = [
  '단지명', '입주 연도', '총세 대수', '공급 (m2)', '공급 면적', '전용 (m2)', '전용 면적', '세대',
  '매매 최저가', '층', '전세 최고가', '층', '매전갭', '전세 가율', '매매 평단', '전세 평단',
  '방', '욕 실', '구 조', '매/전/월 Type', '비고', '링크', '', '공급 (m2)', '단지명',
];

function grid() {
  return [
    ['서울시 강서구'],
    [],
    HEADER,
    ['가양동'],
    ['한보구암마을', "'99.02", '359^', '74.8', '23', '59.2', '18', '36^',
      '45000', '12', '38000', '3', '', '', '', '', '3', '1', '계', '74A', '',
      'https://new.land.naver.com/complexes/1309?tab=detail&a=APT:JGC:ABYG&b=A1:B1&e=RETAIL&ad=true&h=72&i=78'],
    ['강서한강자이', "'13.09", '790^', '87.3', '26', '59.9', '18', '80^',
      '', '', '', '', '', '', '', '', '3', '2', '계', '87A-1', '',
      'https://new.land.naver.com/complexes/103293?tab=detail'],
    ['비고행 - 링크 없음'],
  ];
}

test('findHeaderColumns: 헤더 자동 탐지 + 층은 가격 다음 열', () => {
  const cols = findHeaderColumns(grid());
  assert.equal(cols.headerRowIndex, 2);
  assert.equal(cols.complexName, 0);
  assert.equal(cols.supplyM2, 3);
  assert.equal(cols.salePrice, 8);
  assert.equal(cols.saleFloor, 9);
  assert.equal(cols.jeonsePrice, 10);
  assert.equal(cols.jeonseFloor, 11);
  assert.equal(cols.link, 21);
});

test('findHeaderColumns: "네이버 부동산 링크" 표기도 매칭', () => {
  const rows = [['단지명', '매매 최저가', '층', '전세 최고가', '층', '네이버 부동산 링크']];
  const cols = findHeaderColumns(rows);
  assert.equal(cols.link, 5);
});

test('findHeaderColumns: 헤더 없으면 명확한 에러', () => {
  assert.throws(() => findHeaderColumns([['아무거나'], []]), /헤더 행을 찾지 못했습니다/);
});

test('parseNaverLandLink: h/i 파라미터 추출', () => {
  const p = parseNaverLandLink('https://new.land.naver.com/complexes/1309?tab=detail&h=72&i=78');
  assert.deepEqual(p, { complexNo: '1309', areaMin: 72, areaMax: 78 });
});

test('parseNaverLandLink: h/i 없으면 null 면적', () => {
  const p = parseNaverLandLink('https://new.land.naver.com/complexes/103293?tab=detail');
  assert.deepEqual(p, { complexNo: '103293', areaMin: null, areaMax: null });
});

test('parseNaverLandLink: 링크 아님 → null', () => {
  assert.equal(parseNaverLandLink('가양동'), null);
  assert.equal(parseNaverLandLink(''), null);
  assert.equal(parseNaverLandLink(undefined), null);
});

test('extractTargets: 링크 행만 타깃, rowIndex 는 1-based', () => {
  const { targets } = extractTargets('가양동', grid());
  assert.equal(targets.length, 2);

  const t1 = targets[0];
  assert.equal(t1.sheetName, '가양동');
  assert.equal(t1.rowIndex, 5); // grid 0-based 4행 → A1 표기 5행
  assert.equal(t1.complexNo, '1309');
  assert.equal(t1.areaMin, 72);
  assert.equal(t1.areaMax, 78);
  assert.equal(t1.current.salePrice, 45000);
  assert.equal(t1.current.saleFloor, '12');
  assert.equal(t1.current.jeonsePrice, 38000);

  // h/i 없는 링크 → 공급(m2) ±3 폴백
  const t2 = targets[1];
  assert.equal(t2.complexNo, '103293');
  assert.ok(Math.abs(t2.areaMin - 84.3) < 1e-9);
  assert.ok(Math.abs(t2.areaMax - 90.3) < 1e-9);
  assert.equal(t2.current.salePrice, null);
});

test('columnLetter: A1 표기 변환', () => {
  assert.equal(columnLetter(0), 'A');
  assert.equal(columnLetter(8), 'I');
  assert.equal(columnLetter(11), 'L');
  assert.equal(columnLetter(25), 'Z');
  assert.equal(columnLetter(26), 'AA');
  assert.equal(columnLetter(27), 'AB');
});

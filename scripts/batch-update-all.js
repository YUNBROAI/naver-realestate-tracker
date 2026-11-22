#!/usr/bin/env node
// 15개 지역 구글 시트 일괄 순차 갱신 스크립트
// /Volumes/T7/1. Naver Estate 의 시트 목록을 읽어 순차적으로 runPriceUpdate 실행.
// --resume 지원: 이미 SUCCESS 로 끝난 지역은 건너뛰고 남은 지역만 이어받아서 실행.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { runPriceUpdate } from '../src/real_estate/price_updater.js';

const T7_DIR = '/Volumes/T7/1. Naver Estate';
const PROGRESS_FILE = 'outputs/real_estate/batch_progress.json';

const FALLBACK_REGIONS = [
  { name: '경기도 과천시', docId: '1WC7xfSTEFPO04Vh-UFL8YFwPaCrq3hrG_tAT8_blPR4' },
  { name: '경기도 군포시', docId: '1o-eKw3kcvEPapSjedlVZbSqVnp3tyEJkZ_E6roF4W68' },
  { name: '경기도 안성시', docId: '14oPH8qWbhXXVv_wXnxPhoBUu6ykmY5B2VB_P4ia1iYk' },
  { name: '경기도 의왕시', docId: '1FesRxJTUUmBNT88TMzhExBiH4MoYibjVgde5Qnilzf0' },
  { name: '서울시 강남구', docId: '10krgm8uBcAkV8asnD6RvxsjldBf8tUlf9FoQ7vOv3Aw' },
  { name: '서울시 강동구', docId: '1B3ntQYvpUYnUo14eaixNl3SwaqzY5u532GkDUqMlWYY' },
  { name: '서울시 강북구', docId: '1ZU46X34RVcQAmd0Io7y7qvMMI8aQkhQ7crSVOvunziU' },
  { name: '서울시 강서구', docId: '1TzXGrEHxM6PKniHtzw_IYlWOPPMe6odWMjFvQ5avGyE' },
  { name: '서울시 관악구', docId: '1yxUTaSVqtySzU54hc234NUSt3YAW-T7Kd6lt35nhgXI' },
  { name: '서울시 광진구', docId: '17ID_pAPPJflj3C5NbXxLWzIJfbMAIvFMeaRHnsUK1xs' },
  { name: '서울시 구로구', docId: '18j81illd1ELZnp5lOaSZWt6Rceqj5vgCH2a_FbTcJgo' },
  { name: '서울시 금천구', docId: '1a5qpp33iCZ7FHcLTW55ncg918fGvrPm2TuBrFMqoFfY' },
  { name: '서울시 노원구', docId: '1VzlMGmI0m46hgq1EJVONwBINK5xMdP68qL3cjlxQ-kk' },
  { name: '서울시 도봉구', docId: '1uYA2ebx5QqZg1Fn1MoNfoULsWuPUQLMmdxW_hH03Hos' },
  { name: '서울시 동대문구', docId: '1WTvmKoaU0DRR2EDtYAPO-ec0Gp4j7ps_ChxVeTXuMho' },
  { name: '서울시 동작구', docId: '11nDrkRtnYhs04y_tWpfYP81mWGEi_PZDi6X1b9GURMo' },
  { name: '서울시 서초구', docId: '1Mr23aNITlnRieawkbHKgIp0Aby3rtn7CgHvoaFWRFok' },
  { name: '서울시 성동구', docId: '1gvqVBtslDMrzOmam1PDw8QruUI0nkWVm3pM2mX8athw' },
  { name: '서울시 성북구', docId: '1NT7-W9jgsDsu644O7ikDvi4Nr3hx8NWHOrr9D9kFlh8' },
  { name: '서울시 송파구', docId: '1BJmsGwODKUmwnp2EugMEO7gHGZOEpfzivB8m6zv2uSg' },
  { name: '서울시 양천구', docId: '1K65GtHuKGgb1r2_4wGDZR6aKp0EYm0LavVzLAjPBf88' },
  { name: '서울시 중랑구', docId: '1nMPvQh_TwzYz7EG6sez02tF10JiDtCIjSUEcfgP0dK4' },
  { name: '성남시 분당구', docId: '1EWh40_vqaa9owNtMu_dO5HwA_pktvmbO2QPPqwrRL6s' },
  { name: '성남시 수정구', docId: '1iQfulrS6uN5VcLXE3tC-BLFHeWik1snwyVSHfLOaxYM' },
  { name: '성남시 중원구', docId: '14PJ5H8c6DyOMvXOrn8BcKkkJxxHFAFbOYdzuzcWghIs' },
  { name: '수원시 권선구', docId: '1xRscoiHQIxOOeYMmJvrnYLTq2hRI1UjLLVsuSbt9G2U' },
  { name: '수원시 영통구', docId: '1GsI2_WhVuuxGO7NReW5T-J4afs6jA64xfX7dr12O3Fo' },
  { name: '수원시 장안구', docId: '1Q8Lk1uPxcZDyinA3GmHjhPj4UjOie9tjBJ9oICxa_zw' },
  { name: '수원시 팔달구', docId: '16_BcEgjFSXiPK9Pe63w6PA7cN-9_lAm80PZbwGcmqMM' },
  { name: '안양시 동안구', docId: '1a3sRrMDRn7H6sMTVDN98t9CvUhFknHfAxywPacN-1Oc' },
  { name: '안양시 만안구', docId: '1Ampc0zPwYysgSBvOPaTELCh1CKMAKkblTVTCSxpwIEc' },
  { name: '용인시 기흥구', docId: '1D6LUIGvvUA3LR3KsZEHWAq4pNFAUn_fGH3PBO-kLYo0' },
  { name: '용인시 수지구', docId: '1nK8fjYa2RXCFrmGbAxVUZDPRhAPVqUX_szYgU5FgyIk' },
  { name: '용인시 처인구', docId: '18bzzA9GXeScQepFF8BjTUaKtmMu_xbdLtGiTZy45MRU' },
];

function loadRegions() {
  if (fs.existsSync(T7_DIR)) {
    const files = fs.readdirSync(T7_DIR).filter(f => f.endsWith('.gsheet') && !f.startsWith('._'));
    const list = [];
    for (const f of files) {
      try {
        const c = JSON.parse(fs.readFileSync(path.join(T7_DIR, f), 'utf8'));
        if (c.doc_id) {
          list.push({ name: f.replace('.gsheet', '').normalize('NFC'), docId: c.doc_id });
        }
      } catch {}
    }
    if (list.length > 0) return list;
  }
  return FALLBACK_REGIONS;
}

function loadExistingProgress() {
  if (fs.existsSync(PROGRESS_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
    } catch {}
  }
  return null;
}

function saveProgress(data) {
  fs.mkdirSync(path.dirname(PROGRESS_FILE), { recursive: true });
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  const regions = loadRegions();
  const shouldResume = process.argv.includes('--resume') || !process.argv.includes('--fresh');
  const existing = shouldResume ? loadExistingProgress() : null;

  const successfulMap = new Map();
  if (existing?.results) {
    for (const r of existing.results) {
      if (r.status === 'SUCCESS' || r.status === 'SKIPPED_ALREADY_UPDATED') {
        successfulMap.set(r.name.normalize('NFC'), { ...r, name: r.name.normalize('NFC') });
      }
    }
  }

  console.log(`[batch] 총 ${regions.length}개 지역 일괄 갱신 시작 (기존 완료: ${successfulMap.size}개)`);

  const progress = {
    startedAt: existing?.startedAt || new Date().toISOString(),
    lastResumedAt: new Date().toISOString(),
    total: regions.length,
    completed: successfulMap.size,
    results: [...successfulMap.values()],
  };
  saveProgress(progress);

  for (let idx = 0; idx < regions.length; idx++) {
    const region = regions[idx];
    const num = idx + 1;

    // 이미 성공한 지역이면 스킵
    if (successfulMap.has(region.name)) {
      console.log(`[batch] (${num}/${regions.length}) [${region.name}] 이미 완료됨 — 스킵`);
      continue;
    }

    console.log(`\n======================================================`);
    console.log(`[batch] (${num}/${regions.length}) [${region.name}] 갱신 시작 (ID: ${region.docId})`);
    console.log(`======================================================`);

    let success = false;
    let attempts = 0;
    const argvToPass = ['--sheet-id', region.docId];
    if (process.argv.includes('--only-missing') || process.argv.includes('--new-only')) {
      argvToPass.push('--only-missing');
    }

    while (!success && attempts < 3) {
      attempts++;
      try {
        const summary = await runPriceUpdate({
          argv: argvToPass,
        });
        console.log(`[batch] ✓ [${region.name}] 완료 — ok: ${summary.ok}, failed: ${summary.failed}, 갱신셀: ${summary.updatedCells}`);
        
        // 기존 결과 배열에서 같은 이름 제거 후 추가
        progress.results = progress.results.filter(r => r.name !== region.name);
        progress.results.push({
          name: region.name,
          docId: region.docId,
          status: 'SUCCESS',
          summary,
        });
        successfulMap.set(region.name, true);
        success = true;
      } catch (err) {
        console.error(`[batch] ⚠ [${region.name}] 시도 ${attempts}/3 실패: ${err.message}`);
        if (attempts < 3) {
          console.log(`[batch] 15초 후 재시도합니다...`);
          await sleep(15000);
        } else {
          progress.results = progress.results.filter(r => r.name !== region.name);
          progress.results.push({
            name: region.name,
            docId: region.docId,
            status: 'ERROR',
            error: err.message,
          });
        }
      }
    }

    progress.completed = progress.results.filter(r => r.status === 'SUCCESS').length;
    saveProgress(progress);
  }

  console.log(`\n======================================================`);
  console.log(`[batch] 일괄 작업 완료! 총 ${regions.length}개 중 ${progress.completed}개 완료`);
  console.log(`======================================================`);
}

main().catch(err => {
  console.error('[batch] 치명적 오류:', err);
  process.exit(1);
});

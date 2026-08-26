// 부동산 시세 자동화 — Google Sheets REST v4 클라이언트
// 책임: 서비스 어카운트 JWT(RS256 자체 서명) → access_token →
//        values.batchGet / values.batchUpdate REST 호출.
// 의존성: Node 24+ native fetch. 구글 SDK 금지 (코어 무의존성 원칙).
// 비-목표: 시트 생성/서식/수식 조작. 값 읽기/쓰기만.

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { signGcpServiceAccountJWT, fetchAccessToken } from '../lib/google_auth.js';

const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

export class SheetsClientError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'SheetsClientError';
    this.status = status;
    this.body = body;
  }
}

// SA 키 경로 해석: .env 의 RE_SHEETS_KEY_JSON 값을 사용.
export function resolveSheetsKeyPath(env = process.env) {
  return env.RE_SHEETS_KEY_JSON ?? null;
}

async function loadKeyJson(keyPath) {
  const abs = path.resolve(String(keyPath));
  if (!fsSync.existsSync(abs)) {
    throw new SheetsClientError(
      `서비스 어카운트 JSON 파일이 없습니다: ${abs}. RE_SHEETS_KEY_JSON 경로를 확인하세요.`
    );
  }
  const raw = await fs.readFile(abs, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new SheetsClientError(`서비스 어카운트 JSON 파싱 실패 (${abs}): ${err.message}`);
  }
}

export function createSheetsClient({
  keyJsonPath,
  fetchImpl = fetch,
  logger = console,
  baseUrl = SHEETS_BASE,
} = {}) {
  const keyPath = keyJsonPath ?? resolveSheetsKeyPath();
  if (!keyPath) {
    throw new SheetsClientError(
      'RE_SHEETS_KEY_JSON 환경변수가 필요합니다. ' +
      'GCP SA 키 JSON 발급 후 대상 시트를 SA 이메일에 편집자 공유하세요.'
    );
  }

  let keyJsonCache = null;
  const getToken = async () => {
    keyJsonCache ??= await loadKeyJson(keyPath);
    // google_auth 의 토큰 캐시(이메일 단위)를 그대로 공유 — scope 는 spreadsheets 로 서명.
    return fetchAccessToken({
      keyJson: keyJsonCache,
      scopes: [SHEETS_SCOPE],
      fetchImpl,
      logger,
    });
  };

  const call = async (url, init = {}) => {
    const token = await getToken();
    const res = await fetchImpl(url, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json; charset=utf-8',
        ...(init.headers ?? {}),
      },
    });
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch {
      throw new SheetsClientError(
        `Sheets 응답이 JSON 이 아닙니다 (status=${res.status}): ${text.slice(0, 200)}`,
        { status: res.status, body: text },
      );
    }
    if (!res.ok) {
      throw new SheetsClientError(
        `Sheets API ${res.status}: ${parsed?.error?.message ?? text.slice(0, 200)}`,
        { status: res.status, body: parsed },
      );
    }
    return parsed;
  };

  return {
    // ranges: ["가양동!A1:W400", ...] → { valueRanges: [{ range, values }] }
    async batchGet(spreadsheetId, ranges) {
      const params = new URLSearchParams();
      for (const r of ranges) params.append('ranges', r);
      params.set('valueRenderOption', 'UNFORMATTED_VALUE');
      const url = `${baseUrl}/${spreadsheetId}/values:batchGet?${params}`;
      const out = await call(url);
      return out.valueRanges ?? [];
    },

    // data: [{ range: "가양동!I5:J5", values: [[45000, '12']] }, ...]
    async batchUpdate(spreadsheetId, data) {
      if (!Array.isArray(data) || data.length === 0) return { totalUpdatedCells: 0 };
      const url = `${baseUrl}/${spreadsheetId}/values:batchUpdate`;
      const out = await call(url, {
        method: 'POST',
        body: JSON.stringify({
          valueInputOption: 'USER_ENTERED',
          data,
        }),
      });
      return { totalUpdatedCells: out.totalUpdatedCells ?? 0, raw: out };
    },

    // 스프레드시트 메타(탭 목록/sheetId) — 순위 탭 존재 여부 확인용.
    // fields: 'sheets.properties(title,sheetId,index,gridProperties(rowCount,columnCount))'
    async getSpreadsheetMeta(spreadsheetId, fields) {
      const params = fields ? `?fields=${encodeURIComponent(fields)}` : '';
      return call(`${baseUrl}/${spreadsheetId}${params}`);
    },

    // 새 탭 생성 (spreadsheets:batchUpdate → addSheet). 기존 이름 충돌 시 API 가 400.
    // 반환: { sheetId, title } — 생성된 시트 프로퍼티.
    async addSheetTab(spreadsheetId, title, { rowCount = 1000, columnCount = 26, index } = {}) {
      const url = `${baseUrl}/${spreadsheetId}:batchUpdate`;
      const properties = { title, gridProperties: { rowCount, columnCount } };
      if (index !== undefined) properties.index = index;
      const out = await call(url, {
        method: 'POST',
        body: JSON.stringify({ requests: [{ addSheet: { properties } }] }),
      });
      const added = out.replies?.[0]?.addSheet?.properties;
      if (!added?.sheetId) {
        throw new SheetsClientError(`addSheet 응답에서 sheetId 누락: ${JSON.stringify(out)}`);
      }
      return { sheetId: added.sheetId, title: added.title };
    },

    // 범위 값 초기화 (values:clear). 서식은 유지.
    async clearValues(spreadsheetId, range) {
      const url = `${baseUrl}/${spreadsheetId}/values/${encodeURIComponent(range)}:clear`;
      return call(url, { method: 'POST', body: '{}' });
    },

    // 단일 범위 쓰기 (values.update). data 는 2차원 배열. 큰 범위에 안전.
    async updateValues(spreadsheetId, range, values, { valueInputOption = 'USER_ENTERED' } = {}) {
      const url = `${baseUrl}/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=${valueInputOption}`;
      const out = await call(url, {
        method: 'PUT',
        body: JSON.stringify({ range, values }),
      });
      return { updatedCells: out.updatedCells ?? 0, raw: out };
    },

    // 구조/서식 배치 업데이트 (spreadsheets:batchUpdate). requests 는 [{repeatCell:...}, {updateSheetProperties:...} ...]
    // 서식은 addSheet 결과와 달리 idempotent 한 요청만 넣을 것 (addBanding 등은 재요청 시 400).
    async batchUpdateSpreadsheet(spreadsheetId, requests) {
      if (!Array.isArray(requests) || requests.length === 0) return { replies: [] };
      const url = `${baseUrl}/${spreadsheetId}:batchUpdate`;
      return call(url, {
        method: 'POST',
        body: JSON.stringify({ requests }),
      });
    },

    _keyPath: keyPath,
  };
}

// JWT 서명 재노출 (테스트/디버깅 용) — 실제 서명 로직은 google_auth.js 단일 소스.
export { signGcpServiceAccountJWT };

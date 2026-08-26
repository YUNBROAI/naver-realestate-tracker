// Google Cloud 서비스 어카운트 JWT 자체 서명 → OAuth2 access token 교환.
// Node 22+ 내장 crypto/fetch 만 사용 (구글 SDK 의존성 없음).

import crypto from 'node:crypto';

export class GoogleAuthError extends Error {
  constructor(message, { status, body, stage } = {}) {
    super(message);
    this.name = 'GoogleAuthError';
    this.status = status;
    this.body = body;
    this.stage = stage;
  }
}

const DEFAULT_OAUTH_BASE = 'https://oauth2.googleapis.com/token';

function base64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

// GCP 서비스 어카운트 JSON (client_email + private_key + token_uri) → 서명된 JWT.
// 표준 RFC 7523 + Google OAuth2 자격증명 교환 패턴.
export function signGcpServiceAccountJWT({
  keyJson,
  scopes = ['https://www.googleapis.com/auth/cloud-platform'],
  audience,
  expiresInSec = 3600,
  nowSec,
} = {}) {
  if (!keyJson || typeof keyJson !== 'object') {
    throw new GoogleAuthError('signGcpServiceAccountJWT: keyJson(객체) 가 필요합니다.');
  }
  const { client_email: clientEmail, private_key: privateKey, token_uri: tokenUri } = keyJson;
  if (!clientEmail || !privateKey) {
    throw new GoogleAuthError(
      'GCP 서비스 어카운트 JSON 에 client_email/private_key 가 없습니다. ' +
      'IAM > Service Accounts > Keys > Add Key (JSON) 로 다시 발급하세요.'
    );
  }
  const iat = Number.isFinite(nowSec) ? nowSec : Math.floor(Date.now() / 1000);
  const exp = iat + Math.max(60, Math.min(3600, expiresInSec));
  const aud = audience ?? tokenUri ?? DEFAULT_OAUTH_BASE;
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: clientEmail,
    scope: Array.isArray(scopes) ? scopes.join(' ') : String(scopes),
    aud,
    iat,
    exp,
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claim))}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(privateKey);
  return `${signingInput}.${base64url(signature)}`;
}

// access_token 캐시 — 1시간 유효, 만료 60초 전 갱신 트리거.
const tokenCache = new Map(); // clientEmail → { token, expiresAt }

export function _clearTokenCacheForTests() {
  tokenCache.clear();
}

export async function fetchAccessToken({
  keyJson,
  oauthBase = DEFAULT_OAUTH_BASE,
  scopes,
  fetchImpl = fetch,
  logger = console,
  nowMs,
} = {}) {
  const email = keyJson?.client_email;
  if (!email) {
    throw new GoogleAuthError('fetchAccessToken: keyJson.client_email 누락.');
  }
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const cached = tokenCache.get(email);
  if (cached && cached.expiresAt - 60_000 > now) {
    logger.log?.(`[google_auth] OAuth 토큰 캐시 hit (남은 ${(cached.expiresAt - now) / 1000 | 0}s)`);
    return cached.token;
  }
  const assertion = signGcpServiceAccountJWT({
    keyJson,
    scopes,
    audience: keyJson.token_uri ?? oauthBase,
    nowSec: Math.floor(now / 1000),
  });
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  });
  const res = await fetchImpl(oauthBase, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch {
    throw new GoogleAuthError(
      `OAuth 응답이 JSON 이 아닙니다 (status=${res.status}): ${text.slice(0, 200)}`,
      { status: res.status, body: text, stage: 'oauth' }
    );
  }
  if (!res.ok || !parsed.access_token) {
    throw new GoogleAuthError(
      `GCP OAuth 토큰 교환 실패 ${res.status}: ${parsed.error ?? text.slice(0, 200)}`,
      { status: res.status, body: parsed, stage: 'oauth' }
    );
  }
  const expiresIn = Number(parsed.expires_in ?? 3600);
  tokenCache.set(email, { token: parsed.access_token, expiresAt: now + expiresIn * 1000 });
  logger.log?.(`[google_auth] OAuth 토큰 신규 발급 (expires_in=${expiresIn}s, email=${email})`);
  return parsed.access_token;
}

// 네이버 블로그 자동화 — 구조화 로거 (JSONL append + stdout 미러)
// 책임: 모든 모듈이 동일 인터페이스 (info/warn/error/event/log) 로 사건 기록.
//        stdout 포맷은 기존 ai-reels 파이프라인의 `[stage] ▶/✓/⚠/✖ msg` 와 호환되어
//        slack_server.js 의 STAGE_LOG_REGEX 에 자연스럽게 매칭된다.
// 비-목표: 로그 회전 / 외부 sink. 단순 append 만.

import fs from 'node:fs/promises';
import path from 'node:path';

const LEVEL_GLYPH = Object.freeze({ info: '▶', ok: '✓', warn: '⚠', error: '✖' });

function serializeError(err) {
  if (!err) return null;
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
      cause: err.cause ? serializeError(err.cause) : null,
      ...(err.status !== undefined ? { status: err.status } : {}),
    };
  }
  return { message: String(err) };
}

export function createLogger({
  logPath = 'outputs/naver_blog/run.log.jsonl',
  consoleLogger = console,
  stagePrefix = 'naver-blog',
} = {}) {
  let ensured = false;
  const ensureDir = async () => {
    if (ensured) return;
    await fs.mkdir(path.dirname(path.resolve(logPath)), { recursive: true });
    ensured = true;
  };

  const append = async (entry) => {
    try {
      await ensureDir();
      await fs.appendFile(logPath, JSON.stringify(entry) + '\n', 'utf8');
    } catch {
      // 파일 시스템 실패는 무시 — stdout 은 이미 출력됨.
    }
  };

  const emit = (level, stage, msg, meta) => {
    const glyph = LEVEL_GLYPH[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info'];
    const line = `[${stagePrefix}:${stage}] ${glyph} ${msg}`;
    const sink = level === 'error' ? consoleLogger.error : level === 'warn' ? consoleLogger.warn : consoleLogger.log;
    if (typeof sink === 'function') sink.call(consoleLogger, line);

    const entry = {
      ts: new Date().toISOString(),
      level,
      stage,
      msg,
      ...(meta && Object.keys(meta).length ? { meta: normalizeMeta(meta) } : {}),
    };
    // fire-and-forget — 호출자는 await 하지 않아도 됨.
    void append(entry);
  };

  return {
    info: (stage, msg, meta) => emit('info', stage, msg, meta),
    ok: (stage, msg, meta) => emit('ok', stage, msg, meta),
    warn: (stage, msg, meta) => emit('warn', stage, msg, meta),
    error: (stage, msg, meta) => emit('error', stage, msg, meta),
    event: (level, stage, msg, meta) => emit(level, stage, msg, meta),
    // gemini_client 가 기대하는 인터페이스 (logger.log / logger.warn) 동시 노출.
    log: (...args) => consoleLogger.log?.(...args),
    // 테스트/디버깅 용.
    _logPath: logPath,
  };
}

function normalizeMeta(meta) {
  const out = {};
  for (const [k, v] of Object.entries(meta)) {
    if (v instanceof Error) out[k] = serializeError(v);
    else out[k] = v;
  }
  return out;
}

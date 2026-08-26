#!/usr/bin/env bash
# 원클릭 설치/점검 스크립트 — Node 버전 확인 → SA 키 탐색 → .env 생성/보강 → 테스트 →
# 시트 연결 점검(읽기만). 시트에 실제로 쓰지 않고, 기존 .env 값도 덮어쓰지 않는다.
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR" || exit 1

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m⚠\033[0m %s\n' "$1"; }
err()  { printf '  \033[31m✖\033[0m %s\n' "$1"; }
step() { printf '\n\033[1m▶ %s\033[0m\n' "$1"; }

echo "네이버 부동산 시세 자동화 — 설치 점검 ($REPO_DIR)"

# ─── 1. Node 버전 ────────────────────────────────────────────────────────────
step "1/5 Node 런타임"
if ! command -v node >/dev/null 2>&1; then
  err "node 가 없습니다. https://nodejs.org 에서 LTS 버전 설치 후 다시 실행하세요."
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  err "Node $(node -v) — 22 이상이 필요합니다. nvm 또는 https://nodejs.org 로 업그레이드하세요."
  exit 1
fi
ok "Node $(node -v)"

# ─── 2. SA 키 탐색 ───────────────────────────────────────────────────────────
step "2/5 구글 서비스 어카운트 키"
KEY_PATH=""
for c in "$REPO_DIR/.secrets/service-account.json" "$REPO_DIR/service-account.json" \
  "$HOME/Downloads"/*service*account*.json "$HOME/Downloads"/*-????????????.json; do
  [ -f "$c" ] && { KEY_PATH="$c"; break; }
done
if [ -n "$KEY_PATH" ]; then
  ok "키 발견: $KEY_PATH"
  chmod 600 "$KEY_PATH" 2>/dev/null
  SA_EMAIL="$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$KEY_PATH','utf8')).client_email||'')}catch(e){}" 2>/dev/null)"
  [ -n "$SA_EMAIL" ] && ok "SA 계정: $SA_EMAIL (이 주소가 시트에 편집자로 공유돼 있어야 함)"
else
  warn "SA 키를 찾지 못했습니다. README 의 '구글 서비스 어카운트 만들기'를 먼저 진행하세요."
  warn "  발급받은 JSON 키는 이 프로젝트의 .secrets/service-account.json 에 두면 자동으로 찾습니다."
fi

# ─── 3. .env 생성/보강 ───────────────────────────────────────────────────────
step "3/5 .env 구성"
[ -f .env ] || cp .env.example .env
add_env() { # key value — 이미 있으면 건드리지 않음
  if grep -q "^$1=" .env 2>/dev/null && [ -n "$(grep "^$1=" .env | cut -d= -f2-)" ]; then
    ok "$1 (기존 값 유지)"
  elif [ -n "$2" ]; then
    if grep -q "^$1=" .env 2>/dev/null; then
      sed -i.bak "s|^$1=.*|$1=$2|" .env && rm -f .env.bak
    else
      printf '%s=%s\n' "$1" "$2" >> .env
    fi
    ok "$1 설정됨"
  else
    warn "$1 미설정 — .env 에 직접 입력 필요"
  fi
}
add_env RE_SHEETS_KEY_JSON "$KEY_PATH"
grep -q '^RE_SHEET_ID=' .env || echo 'RE_SHEET_ID=' >> .env
[ -n "$(grep '^RE_SHEET_ID=' .env | cut -d= -f2-)" ] && ok "RE_SHEET_ID (기존 값 유지)" || warn "RE_SHEET_ID 미설정 — .env 에 직접 입력 필요"
grep -q '^RE_DRY_RUN=' .env || { echo 'RE_DRY_RUN=1' >> .env; ok "RE_DRY_RUN=1 (안전 디폴트 — 실쓰기는 0 으로 변경)"; }

# ─── 4. 테스트 ───────────────────────────────────────────────────────────────
step "4/5 테스트"
if node --test 'tests/real_estate/*.test.js' >/tmp/re_test.log 2>&1; then
  ok "$(grep -E '^# pass' /tmp/re_test.log | head -1 | tr -d '#')건 통과"
else
  err "테스트 실패 — 자세한 내용: /tmp/re_test.log"
fi

# ─── 5. 시트 연결 점검 (읽기 전용) ───────────────────────────────────────────
step "5/5 구글시트 연결 (읽기만)"
SHEET_ID="$(grep '^RE_SHEET_ID=' .env | cut -d= -f2-)"
ENV_KEY_PATH="$(grep '^RE_SHEETS_KEY_JSON=' .env | cut -d= -f2-)"
if [ -n "$ENV_KEY_PATH" ] && [ -n "$SHEET_ID" ]; then
  node --env-file=.env --input-type=module -e '
    const { createSheetsClient } = await import("./src/real_estate/sheets_client.js");
    try {
      const c = createSheetsClient({ logger: { info(){}, warn(){}, error(){}, ok(){} } });
      const meta = await c.getSpreadsheetMeta(process.env.RE_SHEET_ID, "properties(title)");
      console.log(`  \x1b[32m✓\x1b[0m 시트 읽기 성공 — "${meta.properties?.title}" 연동 정상`);
    } catch (e) {
      console.log("  \x1b[31m✖\x1b[0m 시트 읽기 실패: " + e.message.slice(0, 200));
      console.log("     → 시트를 SA 이메일에 편집자로 공유했는지, Sheets API 가 켜져 있는지 확인");
    }
  ' 2>/dev/null || warn "점검 생략 (수동으로 dry-run 실행해 확인하세요)"
else
  warn "SA 키 또는 RE_SHEET_ID 가 없어 생략"
fi

cat <<EOF

────────────────────────────────────────────────────────
설치 점검 완료. RE_SHEET_ID/RE_SHEETS_KEY_JSON 이 비어 있다면 .env 에 채운 뒤 이어서:

  # 1) 시트에 안 쓰는 리허설 (권장 — 먼저 이것부터)
  npm run update:dry -- --dong <동이름>

  # 2) 실제 갱신 (순위 탭도 자동 갱신)
  RE_DRY_RUN=0 npm run update

  # 3) 임장보고서(React 대시보드) 생성
  npm run report -- --out App.jsx

자세한 사용법: README.md
────────────────────────────────────────────────────────
EOF

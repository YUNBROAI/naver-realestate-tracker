// 부동산 시세 자동화 — '순위' 탭 → 단일 파일 React 임장보고서(App.jsx) 생성기.
// 책임: 순위 탭 값(batchGet 결과) → 정제된 아파트 배열 → App.jsx 텍스트.
// 비-목표: Sheets I/O, 파일 쓰기 (CLI 인 scripts/real_estate/generate-report.js 담당).

// updateRankingTab (ranking_updater.js) 이 항상 이 순서로 쓰는 22개 컬럼.
// A(0)=순위 ... V(21)=Type. 위치가 고정이므로 헤더 재탐지 없이 인덱스로 바로 읽는다.
const COL = {
  rank: 0, dong: 1, name: 2, year: 3, totalHouseholds: 4,
  supplyM2: 5, supplyPyeong: 6, exclusiveM2: 7, exclusivePyeong: 8, units: 9,
  saleMin: 10, saleFloor: 11, jeonseMax: 12, jeonseFloor: 13,
  gap: 14, rate: 15, salePerPyeong: 16, jeonsePerPyeong: 17,
  rooms: 18, baths: 19, structure: 20, type: 21,
};

const PALETTE = [
  '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
  '#ec4899', '#14b8a6', '#f97316', '#6366f1', '#84cc16', '#06b6d4', '#a855f7',
];

function toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = Number(String(v).replaceAll(',', '').trim());
  return Number.isFinite(n) ? n : null;
}

function toEok(manwon, digits = 2) {
  if (manwon === null || manwon === undefined) return null;
  return Math.round((manwon / 10000) * 10 ** digits) / 10 ** digits;
}

function toStr(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

// 순위 탭의 원본 행(값 배열) 1개 → 정제된 아파트 객체. 매매최저가 없으면 null(제외 대상).
// 정제 규칙 2가지 (real-estate-workbench/output/App.jsx 수작업 생성 때 발견한 것을 일반화):
//  1) 전세 매물이 없으면 jeonse/gap/rate 를 null 로 — 원본 시트 수식은 전세가=0일 때
//     갭=매매가로 채우는데, 갭투자 지표로 오인되기 쉬움.
//  2) 전세최고가가 매매최저가보다 높아 갭이 음수가 되는 행(서로 다른 유닛의 매매-min /
//     전세-max 를 독립적으로 집계하며 생기는 왜곡)은 gap/rate 만 null 처리하고
//     매매가/전세가 자체는 참고용으로 남긴다.
export function cleanRow(row, id) {
  const sale = toEok(toNum(row[COL.saleMin]));
  if (sale === null) return null;

  const jeonseManwon = toNum(row[COL.jeonseMax]);
  const jeonse = jeonseManwon !== null ? toEok(jeonseManwon) : null;
  let gap = jeonse !== null ? Math.round((sale - jeonse) * 100) / 100 : null;
  let rate = jeonse !== null && sale > 0 ? Math.round((jeonse / sale) * 1000) / 10 : null;
  if (gap !== null && gap < 0) {
    gap = null;
    rate = null;
  }

  return {
    id,
    dong: toStr(row[COL.dong]) ?? '',
    name: toStr(row[COL.name]) ?? '',
    year: toStr(row[COL.year]),
    supplyPyeong: toNum(row[COL.supplyPyeong]),
    exclusivePyeong: toNum(row[COL.exclusivePyeong]),
    units: toNum(row[COL.units]),
    totalHouseholds: toNum(row[COL.totalHouseholds]),
    sale,
    saleFloor: toStr(row[COL.saleFloor]),
    jeonse,
    jeonseFloor: toStr(row[COL.jeonseFloor]),
    gap,
    rate,
    salePerPyeong: toNum(row[COL.salePerPyeong]),
    jeonsePerPyeong: toNum(row[COL.jeonsePerPyeong]),
    rooms: toStr(row[COL.rooms]),
    baths: toStr(row[COL.baths]),
    structure: toStr(row[COL.structure]),
    type: toStr(row[COL.type]),
  };
}

// 순위 탭 batchGet 결과(2차원 배열, 헤더 포함) → 정제된 아파트 배열.
// 매매최저가가 없는 행(빈 줄, 헤더 재출현 등)은 건너뛴다.
export function buildApartments(rows) {
  const out = [];
  for (let i = 1; i < rows.length; i += 1) {
    const cleaned = cleanRow(rows[i] ?? [], out.length + 1);
    if (cleaned) out.push(cleaned);
  }
  return out;
}

// 아파트 배열에서 등장하는 법정동 목록(첫 등장 순서) → 팔레트 색상 매핑.
export function assignDongColors(apartments) {
  const dongs = [];
  for (const a of apartments) if (!dongs.includes(a.dong)) dongs.push(a.dong);
  const colors = {};
  dongs.forEach((d, i) => { colors[d] = PALETTE[i % PALETTE.length]; });
  return colors;
}

function jsxHeader({ apartmentsJson, title, subtitleDongs }) {
  return `import React, { useMemo, useState } from "react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ScatterChart,
  Scatter,
  ZAxis,
} from "recharts";

// ─────────────────────────────────────────────────────────────────────────
// 이 파일은 scripts/real_estate/generate-report.js 가 Google Sheets '순위' 탭에서
// 자동 생성했습니다. 데이터를 고치려면 시트를 갱신하고 다시 생성하세요 — 이 배열을
// 직접 손으로 수정해도 다음 생성 때 덮어써집니다.
// 정제 규칙: 전세 매물 없는 행은 gap/rate=null, 전세최고가가 매매최저가보다 높아
// 갭이 음수가 되는 행도 gap/rate=null (매매가/전세가 값 자체는 유지).
// ─────────────────────────────────────────────────────────────────────────
const APARTMENTS = ${apartmentsJson};

const REPORT_TITLE = ${JSON.stringify(title)};
const REPORT_SUBTITLE_DONGS = ${JSON.stringify(subtitleDongs)};
`;
}

function jsxBody({ dongColorsJson }) {
  return `
const DONG_COLORS = ${dongColorsJson};

const DONG_LIST = Object.keys(DONG_COLORS);

function formatEok(v, digits = 1) {
  if (v === null || v === undefined || Number.isNaN(v)) return "-";
  return \`\${v.toFixed(digits)}억\`;
}

function formatPct(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return "-";
  return \`\${v.toFixed(1)}%\`;
}

function rateBadgeClass(rate) {
  if (rate === null || rate === undefined) return "bg-slate-100 text-slate-400";
  if (rate >= 80) return "bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200";
  if (rate >= 60) return "bg-amber-100 text-amber-700 ring-1 ring-amber-200";
  return "bg-rose-100 text-rose-700 ring-1 ring-rose-200";
}

function gapBadgeClass(gap) {
  if (gap === null || gap === undefined) return "bg-slate-100 text-slate-400";
  if (gap <= 3) return "bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200";
  if (gap <= 6) return "bg-amber-100 text-amber-700 ring-1 ring-amber-200";
  return "bg-rose-100 text-rose-700 ring-1 ring-rose-200";
}

function SummaryCard({ label, value, sub, accent }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
      <div className="text-xs font-semibold text-slate-500 sm:text-sm">{label}</div>
      <div className={\`mt-1.5 text-2xl font-extrabold sm:text-3xl \${accent}\`}>{value}</div>
      <div className="mt-1 text-[11px] text-slate-400 sm:text-xs">{sub}</div>
    </div>
  );
}

function GapChartTooltip({ active, payload }) {
  if (!active || !payload || !payload.length) return null;
  const row = payload[0].payload;
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3 text-xs shadow-lg">
      <div className="mb-1 font-bold text-slate-700">{row.fullName}</div>
      <div className="text-slate-400">{row.dong}</div>
      <div className="mt-1.5 space-y-0.5">
        <div className="text-rose-600">매매가 · {formatEok(row.sale)}</div>
        <div className="text-blue-600">전세가 · {formatEok(row.jeonse)}</div>
        <div className="font-semibold text-orange-600">매전갭 · {formatEok(row.gap)}</div>
      </div>
    </div>
  );
}

function ScatterTooltip({ active, payload }) {
  if (!active || !payload || !payload.length) return null;
  const row = payload[0].payload;
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3 text-xs shadow-lg">
      <div className="font-bold text-slate-700">{row.name}</div>
      <div className="text-slate-400">{row.dong}</div>
      <div className="mt-1 text-slate-600">
        공급 {row.x}평 · <span className="font-semibold text-rose-600">{formatEok(row.y)}</span>
      </div>
    </div>
  );
}

export default function App() {
  const [selectedDong, setSelectedDong] = useState("전체");
  const [search, setSearch] = useState("");

  const dongCounts = useMemo(() => {
    const counts = {};
    for (const a of APARTMENTS) counts[a.dong] = (counts[a.dong] || 0) + 1;
    return counts;
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return APARTMENTS.filter((a) => {
      if (selectedDong !== "전체" && a.dong !== selectedDong) return false;
      if (q && !a.name.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [selectedDong, search]);

  const summary = useMemo(() => {
    const withGap = filtered.filter((a) => a.gap !== null);
    const withRate = filtered.filter((a) => a.rate !== null);
    return {
      count: filtered.length,
      maxSale: filtered.length ? Math.max(...filtered.map((a) => a.sale)) : 0,
      minGap: withGap.length ? Math.min(...withGap.map((a) => a.gap)) : null,
      avgRate: withRate.length
        ? withRate.reduce((sum, a) => sum + a.rate, 0) / withRate.length
        : null,
    };
  }, [filtered]);

  const gapChartData = useMemo(() => {
    return filtered
      .filter((a) => a.gap !== null)
      .slice()
      .sort((a, b) => a.gap - b.gap)
      .slice(0, 20)
      .map((a) => ({
        label: a.name.length > 7 ? \`\${a.name.slice(0, 7)}…\` : a.name,
        fullName: \`\${a.name} (\${a.type || ""})\`,
        dong: a.dong,
        sale: a.sale,
        jeonse: a.jeonse,
        gap: a.gap,
      }));
  }, [filtered]);

  const scatterSeries = useMemo(() => {
    const groups = {};
    for (const a of filtered) {
      if (a.supplyPyeong === null || a.sale === null) continue;
      if (!groups[a.dong]) groups[a.dong] = [];
      groups[a.dong].push({ x: a.supplyPyeong, y: a.sale, name: a.name, dong: a.dong });
    }
    return groups;
  }, [filtered]);

  return (
    <div className="min-h-screen bg-slate-50 px-3 py-6 text-slate-800 sm:px-6 lg:px-10">
      <div className="mx-auto max-w-7xl">
        <header className="mb-6">
          <h1 className="text-2xl font-extrabold tracking-tight text-slate-900 sm:text-3xl">
            🏢 {REPORT_TITLE} 임장보고서
          </h1>
          <p className="mt-1.5 text-sm text-slate-500">
            {REPORT_SUBTITLE_DONGS.join("·")} — 매매최저가 기준 전체 {APARTMENTS.length}건 자동 수집 데이터
          </p>
        </header>

        <section className="mb-6 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
          <SummaryCard
            label="분석 단지 수"
            value={\`\${summary.count}건\`}
            sub={selectedDong === "전체" ? "전체 법정동" : selectedDong}
            accent="text-blue-600"
          />
          <SummaryCard
            label="최고 매매가"
            value={formatEok(summary.maxSale)}
            sub="현재 필터 기준"
            accent="text-rose-600"
          />
          <SummaryCard
            label="최소 갭투자액"
            value={summary.minGap !== null ? formatEok(summary.minGap) : "-"}
            sub="전세 매물 있는 단지 기준"
            accent="text-orange-600"
          />
          <SummaryCard
            label="평균 전세가율"
            value={summary.avgRate !== null ? formatPct(summary.avgRate) : "-"}
            sub="전세 매물 있는 단지 기준"
            accent="text-emerald-600"
          />
        </section>

        <section className="mb-6 flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap gap-1.5">
            {["전체", ...DONG_LIST].map((dong) => {
              const active = selectedDong === dong;
              const count = dong === "전체" ? APARTMENTS.length : dongCounts[dong] || 0;
              return (
                <button
                  key={dong}
                  onClick={() => setSelectedDong(dong)}
                  className={\`rounded-full px-3 py-1.5 text-xs font-semibold transition sm:text-sm \${
                    active
                      ? "bg-slate-900 text-white shadow"
                      : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                  }\`}
                >
                  {dong} <span className="opacity-60">({count})</span>
                </button>
              );
            })}
          </div>
          <div className="relative sm:w-64">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="단지명 검색"
              className="w-full rounded-full border border-slate-200 bg-slate-50 px-4 py-2 text-sm outline-none focus:border-slate-400 focus:bg-white"
            />
            {search && (
              <button
                onClick={() => setSearch("")}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-400 hover:text-slate-600"
              >
                ✕
              </button>
            )}
          </div>
        </section>

        <section className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
            <h2 className="mb-1 text-sm font-bold text-slate-700 sm:text-base">
              매전갭 최저 TOP {gapChartData.length}
            </h2>
            <p className="mb-3 text-xs text-slate-400">
              전세가(파랑) + 매전갭(주황) = 매매가 · 갭이 작을수록 투자 부담이 낮음
            </p>
            {gapChartData.length === 0 ? (
              <div className="flex h-72 items-center justify-center text-sm text-slate-400">
                전세 매물이 있는 단지가 없습니다.
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={gapChartData} margin={{ top: 4, right: 8, left: -12, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 10, fill: "#64748b" }}
                    interval={0}
                    angle={-35}
                    textAnchor="end"
                    height={60}
                  />
                  <YAxis
                    tick={{ fontSize: 11, fill: "#64748b" }}
                    tickFormatter={(v) => \`\${v}억\`}
                    width={40}
                  />
                  <Tooltip content={<GapChartTooltip />} />
                  <Legend
                    formatter={(value) => (value === "jeonse" ? "전세가" : "매전갭")}
                    wrapperStyle={{ fontSize: 12 }}
                  />
                  <Bar dataKey="jeonse" stackId="a" name="jeonse" fill="#3b82f6" radius={[0, 0, 0, 0]} />
                  <Bar dataKey="gap" stackId="a" name="gap" fill="#f97316" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
            <h2 className="mb-1 text-sm font-bold text-slate-700 sm:text-base">평형별 매매가 분포</h2>
            <p className="mb-3 text-xs text-slate-400">공급평형(X) · 매매가(Y) · 법정동별 색상 구분</p>
            <ResponsiveContainer width="100%" height={300}>
              <ScatterChart margin={{ top: 4, right: 8, left: -12, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis type="number" dataKey="x" name="평형" unit="평" tick={{ fontSize: 11, fill: "#64748b" }} />
                <YAxis
                  type="number"
                  dataKey="y"
                  name="매매가"
                  tickFormatter={(v) => \`\${v}억\`}
                  tick={{ fontSize: 11, fill: "#64748b" }}
                  width={40}
                />
                <ZAxis range={[50, 51]} />
                <Tooltip content={<ScatterTooltip />} cursor={{ strokeDasharray: "3 3" }} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                {Object.entries(scatterSeries).map(([dong, points]) => (
                  <Scatter key={dong} name={dong} data={points} fill={DONG_COLORS[dong] || "#94a3b8"} fillOpacity={0.75} />
                ))}
              </ScatterChart>
            </ResponsiveContainer>
          </div>
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-slate-100 p-4">
            <h2 className="text-sm font-bold text-slate-700 sm:text-base">전체 매물 상세 ({filtered.length}건)</h2>
            <span className="text-xs text-slate-400">스크롤하여 더 보기 ↓</span>
          </div>
          <div className="max-h-[600px] overflow-auto">
            <table className="w-full min-w-[860px] border-collapse text-left text-xs sm:text-sm">
              <thead className="sticky top-0 z-10 bg-slate-50 text-slate-500">
                <tr>
                  <th className="px-3 py-2.5 font-semibold">순위</th>
                  <th className="px-3 py-2.5 font-semibold">법정동</th>
                  <th className="px-3 py-2.5 font-semibold">단지명</th>
                  <th className="px-3 py-2.5 font-semibold">입주</th>
                  <th className="px-3 py-2.5 font-semibold">평형</th>
                  <th className="px-3 py-2.5 text-right font-semibold">매매가</th>
                  <th className="px-3 py-2.5 text-right font-semibold">전세가</th>
                  <th className="px-3 py-2.5 text-right font-semibold">매전갭</th>
                  <th className="px-3 py-2.5 text-right font-semibold">전세가율</th>
                  <th className="px-3 py-2.5 text-right font-semibold">평단가</th>
                  <th className="px-3 py-2.5 font-semibold">타입</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((a) => (
                  <tr key={a.id} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/70">
                    <td className="px-3 py-2 text-slate-400">{a.id}</td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span
                        className="inline-block h-2 w-2 rounded-full align-middle"
                        style={{ backgroundColor: DONG_COLORS[a.dong] || "#94a3b8" }}
                      />
                      <span className="ml-1.5 align-middle">{a.dong}</span>
                    </td>
                    <td className="px-3 py-2 font-medium text-slate-700">{a.name}</td>
                    <td className="px-3 py-2 text-slate-500 whitespace-nowrap">{a.year || "-"}</td>
                    <td className="px-3 py-2 text-slate-500 whitespace-nowrap">
                      {a.supplyPyeong ? \`\${a.supplyPyeong}평\` : "-"}
                      {a.exclusivePyeong ? <span className="text-slate-300"> / {a.exclusivePyeong}평</span> : null}
                    </td>
                    <td className="px-3 py-2 text-right font-bold text-rose-600 whitespace-nowrap">{formatEok(a.sale)}</td>
                    <td className="px-3 py-2 text-right font-semibold text-blue-600 whitespace-nowrap">{formatEok(a.jeonse)}</td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      <span className={\`rounded-full px-2 py-0.5 text-[11px] font-semibold \${gapBadgeClass(a.gap)}\`}>
                        {formatEok(a.gap)}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      <span className={\`rounded-full px-2 py-0.5 text-[11px] font-semibold \${rateBadgeClass(a.rate)}\`}>
                        {formatPct(a.rate)}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right text-slate-500 whitespace-nowrap">
                      {a.salePerPyeong ? \`\${a.salePerPyeong.toLocaleString()}만\` : "-"}
                    </td>
                    <td className="px-3 py-2 text-slate-400 whitespace-nowrap">{a.type || "-"}</td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={11} className="px-3 py-10 text-center text-slate-400">
                      조건에 맞는 매물이 없습니다.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <footer className="mt-6 text-center text-xs text-slate-400">
          출처: 네이버 부동산 매물 자동 수집 · Google Sheets "순위" 탭 기준 · 매매최저가 내림차순
        </footer>
      </div>
    </div>
  );
}
`;
}

// apartments: buildApartments() 결과. title: 예) "경기도 의왕시". subtitleDongs: 소제목에
// 쓸 법정동 목록(보통 assignDongColors 로 얻은 순서 그대로). dongColors: assignDongColors 결과.
export function renderAppJsx({ apartments, title, subtitleDongs, dongColors }) {
  const apartmentsJson = JSON.stringify(apartments);
  const dongColorsJson = JSON.stringify(dongColors, null, 2);
  return jsxHeader({ apartmentsJson, title, subtitleDongs }) + jsxBody({ dongColorsJson });
}

export { PALETTE, toEok, toNum };

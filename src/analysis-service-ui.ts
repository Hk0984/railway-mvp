import type { Project } from "./model";
import type { analyzeService } from "./service";
import { escapeHtml as e, numberText as n } from "./ui-utils";
import { clock } from "./analysis";
export interface AnalysisServiceInput {
  project: Project;
  timetableId: string;
  origin: string;
  destination: string;
  start: number;
  end: number;
}
let maximum = 2,
  minimum = 2,
  worker: Worker | null = null,
  result: ReturnType<typeof analyzeService> | null = null,
  error = "",
  stamp = "";
const fingerprint = (a: AnalysisServiceInput) =>
  JSON.stringify([a, maximum, minimum]);
function clear() {
  worker?.terminate();
  worker = null;
  result = null;
  error = "";
}
export function renderAnalysisService(input: AnalysisServiceInput) {
  if (stamp && stamp !== fingerprint(input)) {
    clear();
    stamp = "";
  }
  const r = result;
  const route = (j: NonNullable<typeof r>["journeys"][number]) =>
    j.legs
      .map(
        (l) =>
          `${l.typeName} ${l.trainNumber || l.trainId}（${input.project.stations.find((s) => s.id === l.origin.stationId)?.name ?? l.origin.stationId}→${input.project.stations.find((s) => s.id === l.destination.stationId)?.name ?? l.destination.stationId}）`,
      )
      .map(e)
      .join(" → ");
  return `<section class="panel" id="analysis-od-service"><h2>ODの有効本数（乗換対応）</h2><p>出発駅をより遅く出ても、同じ時刻以前に目的駅へ着ける後発旅程があれば、先発は数えません。乗換回数が増えても、この条件を満たす後発だけを残します。</p><div class="route-options"><label>許容する乗換<select id="analysis-service-transfers">${[0, 1, 2, 3, 4].map((v) => `<option value="${v}" ${v === maximum ? "selected" : ""}>${v === 0 ? "直通のみ" : v + "回まで"}</option>`).join("")}</select></label><label>最低乗換時間（分）<input id="analysis-service-minimum" type="number" min="0" step="any" value="${minimum}"></label><button class="primary" data-service-action="run">この条件で有効本数を分析</button>${worker ? '<button data-service-action="cancel">分析を中止</button>' : ""}</div><p class="muted">上の発着駅・方向・種別・時間帯・ダイヤを使用。旅客が利用できる営業列車のみ。集計終了後の後続便も判定に含め、同一発車時刻は1出発機会として数えます。</p>${worker ? '<p role="status">乗換を含む後発旅程を分析中…</p>' : ""}${error ? `<p role="alert">${e(error)}</p>` : ""}${r ? `<div class="metrics"><article class="metric"><span>有効本数（出発機会）</span><strong id="analysis-effective-count">${r.journeyCount}<small>機会</small></strong><p>乗換${maximum}回まで・最低${minimum}分</p></article><article class="metric"><span>期待待ち時間</span><strong>${n(r.journeyWait.minutes)}<small>分</small></strong><p>利用可能な到着時間割合 ${n(r.journeyWait.coverage * 100)}%</p></article></div><p>例：07:00発・08:00着に対して07:10発・乗換2回・08:00着があれば、07:10の1機会を計上します。07:10発の到着が08:01なら両方を残します。</p><div class="table-wrap"><table><thead><tr><th>有効な発車</th><th>目的駅着</th><th>乗換</th><th>利用旅程</th></tr></thead><tbody>${r.journeys.map((j) => `<tr><td>${clock(j.departure)}</td><td>${clock(j.arrival)}</td><td>${j.transferCount}回</td><td>${route(j)}</td></tr>`).join("") || '<tr><td colspan="4">条件を満たす有効な出発機会はありません。</td></tr>'}</tbody></table></div><details id="analysis-replaced-direct"><summary>後発へ置き換えられる先発直通列車（${r.replacedDirect.length}本）</summary><p>先発直通の本数と、有効な出発機会は別指標です。表示窓外の後発も示します。</p><div class="table-wrap"><table><thead><tr><th>先発列車</th><th>先発の発→着</th><th>代替後発の発→着</th><th>後発の乗換</th><th>代替旅程</th></tr></thead><tbody>${r.replacedDirect.map((v) => `<tr><td>${e(v.trainNumber || v.trainId)}</td><td>${clock(v.departure)} → ${clock(v.arrival)}</td><td>${clock(v.replacement.departure)} → ${clock(v.replacement.arrival)}</td><td>${v.replacement.transferCount}回</td><td>${route(v.replacement)}</td></tr>`).join("")}</tbody></table></div></details><p>有効機会の間隔：平均 ${n(r.journeyHeadways?.mean)}分 ／ 最大 ${n(r.journeyHeadways?.max)}分 ／ 中央値 ${n(r.journeyHeadways?.median)}分 ／ 標準偏差 ${n(r.journeyHeadways?.sd)}分。</p>` : '<p class="muted">条件を選んで分析してください。条件を変更すると前の結果を消去します。</p>'}</section>`;
}
export function analysisServiceChange(
  el: HTMLInputElement,
  render: () => void,
) {
  if (el.id === "analysis-service-transfers") {
    maximum = Number(el.value);
    clear();
    stamp = "";
    render();
    return true;
  }
  if (el.id === "analysis-service-minimum") {
    const v = Number(el.value);
    if (el.value.trim() && Number.isFinite(v) && v >= 0) minimum = v;
    else error = "最低乗換時間は0以上の分で指定してください";
    worker?.terminate();
    worker = null;
    result = null;
    stamp = "";
    render();
    return true;
  }
  return false;
}
export function analysisServiceClick(
  el: HTMLElement,
  input: AnalysisServiceInput,
  render: () => void,
) {
  const action = el.dataset.serviceAction;
  if (!action) return false;
  clear();
  if (action === "cancel") {
    render();
    return true;
  }
  if (input.origin === input.destination || !(input.end > input.start)) {
    error = "異なる発着駅と有効な時間帯を指定してください";
    render();
    return true;
  }
  stamp = fingerprint(input);
  const active = new Worker(
    new URL("./analysis-service-worker.ts", import.meta.url),
    { type: "module" },
  );
  worker = active;
  active.onmessage = (event) => {
    if (worker !== active) return;
    active.terminate();
    worker = null;
    if (stamp !== fingerprint(input)) return;
    if (event.data.type === "error") error = event.data.message;
    else result = event.data.result;
    render();
  };
  active.onerror = (ev) => {
    if (worker !== active) return;
    clear();
    error = ev.message;
    render();
  };
  active.postMessage({
    ...input,
    maxTransfers: maximum,
    minimumTransferSeconds: minimum * 60,
  });
  render();
  return true;
}

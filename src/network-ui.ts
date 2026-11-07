import {
  diagnosticView,
  diagnosticChange,
  diagnosticCsv,
} from "./diagnostic-ui";
import { precisionView } from "./precision-analysis";
import { workspace } from "./workspace";
import { networkSample } from "./network-sample";
import {
  validateIntegration,
  networkDemandCsv,
  importNetworkDemand,
  type IntegrationState,
} from "./network-model";
import { validateTransferLinks } from "./routing";
import { stationKey, type StationRef } from "./routing-model";
import {
  defaultAssignmentConfig,
  type AssignmentConfig,
  type AssignmentResult,
} from "./assignment-model";
import {
  flowSummary,
  passengerFlows,
  odFlowRows,
  trainContributions,
  compareBenefits,
} from "./flow-analysis";
import { clock } from "./analysis";
import { download, csv } from "./io";
import {
  trainLoadsCsv,
  segmentLoadsCsv,
  allocationsCsv,
  unallocatedCsv,
} from "./assignment-io";
import {
  escapeHtml as e,
  numberText as n,
  parseClock,
  type UIContext,
} from "./ui-utils";
import { purposeLabels, purposes } from "./temporal-model";
let resultLabels: string[] = [];
let results: AssignmentResult[] = [],
  resultIndex = 0,
  error = "",
  progress = "",
  worker: Worker | null = null,
  stamp = "",
  dirty = false,
  analysisOrigin = "",
  analysisDestination = "",
  trainKey = "";
let draft = new Map<string, string | boolean>();
export function restoreNetworkForm() {
  for (const [selector, value] of draft) {
    const el = document.querySelector<HTMLInputElement>(selector);
    if (el) {
      if (typeof value === "boolean") el.checked = value;
      else el.value = value;
    }
  }
}
export function currentNetworkResult() {
  return !dirty && stamp === fingerprint() ? results[resultIndex] : undefined;
}
const read = (id: string) =>
  (document.getElementById(id) as HTMLInputElement)?.value ?? "";
const checked = (id: string) =>
  (document.getElementById(id) as HTMLInputElement)?.checked ?? false;
const refs = () =>
  workspace.projects.flatMap((p) =>
    p.stations.map((s) => ({
      key: stationKey({ datasetId: p.datasetId!, stationId: s.id }),
      label: `${p.name} ／ ${s.name} ［${p.datasetId}/${s.id}］`,
    })),
  );
const label = (r: StationRef) =>
  workspace.projects.find((p) => p.datasetId === r.datasetId)?.name +
  " ／ " +
  (workspace.projects
    .find((p) => p.datasetId === r.datasetId)
    ?.stations.find((s) => s.id === r.stationId)?.name ?? r.stationId);
const options = (value: string) =>
  refs()
    .map(
      (r) =>
        `<option value="${e(r.key)}" ${value === r.key ? "selected" : ""}>${e(r.label)}</option>`,
    )
    .join("");
const fingerprint = () =>
  JSON.stringify([
    workspace.integration,
    workspace.transferLinks,
    workspace.integration?.config.serviceMapping?.members.map((m) => {
      const p = workspace.projects.find((p) => p.datasetId === m.datasetId);
      return [
        m,
        p?.stations,
        p?.timetables.find((d) => d.id === m.timetableId),
        p?.serviceClasses,
        p?.typeCapacities,
        p?.capacitySettings,
        p?.oud2?.warnings,
      ];
    }),
  ]);
function clear(message = "") {
  worker?.terminate();
  worker = null;
  results = [];
  stamp = "";
  progress = message;
}
const numeric = (id: string, text: string, value: number, min = 0) =>
  `<label>${text}<input id="${id}" type="number" min="${min}" step="any" value="${value}"></label>`;
function settings() {
  const state = workspace.integration,
    c = state?.config ?? {
      ...defaultAssignmentConfig(),
      capacityConstrained: true,
      arrivalModel: {
        mode: "minute" as const,
        distribution: "uniform" as const,
        stepSeconds: 60,
      },
    };
  const extra = `<details><summary>0.6：競合・時刻精度・診断</summary><p class="notice">同時刻一括方式は乗車可能時刻のFIFO、同着集団の比例配分を使います。整数の同余はOD内容・到着時刻・経路で決定します。秒単位の旅客時刻はモデル仮定で、時刻表の秒を推測しません。</p><div class="route-options"><label>乗車競合<select id="net-competition"><option value="simultaneous" ${c.competition === "simultaneous" ? "selected" : ""}>同時刻一括・FIFO・同着比例</option><option value="legacy" ${c.competition !== "simultaneous" ? "selected" : ""}>0.5互換（登録順）</option></select></label><label>枠内時刻<select id="net-timing">${[
    ["midpoint", "A：従来の枠内中点"],
    ["start", "B：枠開始"],
    ["uniform", "C：一様到着の数値積分"],
    ["weighted", "D：指定分布の数値積分"],
  ]
    .map(
      ([v, text]) =>
        `<option value="${v}" ${(c.arrivalModel?.timing ?? "midpoint") === v ? "selected" : ""}>${text}</option>`,
    )
    .join(
      "",
    )}</select></label>${numeric("net-integration", "積分刻み（秒・モデル仮定）", c.arrivalModel?.integrationSeconds ?? 1, 1)}${numeric("net-cutoff", "乗車締切（発車の何秒前）", c.boardingCutoffSeconds ?? 0)}<label>診断<select id="net-diagnostic"><option value="summary" ${c.diagnosticMode !== "full" ? "selected" : ""}>概要・人数監査</option><option value="full" ${c.diagnosticMode === "full" ? "selected" : ""}>全件・集団追跡</option></select></label></div><p>乗換時間と明示徒歩に締切秒を加えた時刻条件で判定します。締切0秒では発車時刻ちょうどを許可。Cは一様分布、Dは上の指定分布を使います。積分は秒刻みの中点による近似です。整数化で小さいセルの丸めに影響されます。</p></details>`;
  return `<section class="panel" id="network-settings">${extra}<h2>統合ダイヤ・時刻分布</h2><p class="notice">ダイヤ名から曜日・カレンダーを推測しません。各路線のダイヤを選び、共通区分と設定根拠を明示してください。駅名・列車番号が同じでもIDを統合しません。</p><div class="table-wrap"><table><thead><tr><th>利用</th><th>データセット</th><th>対象ダイヤ</th><th>手動で対応する共通区分</th></tr></thead><tbody>${workspace.projects
    .map((p) => {
      const m = c.serviceMapping?.members.find(
        (m) => m.datasetId === p.datasetId,
      );
      return `<tr><td><input type="checkbox" data-net-use="${e(p.datasetId)}" ${m ? "checked" : ""}></td><td>${e(p.name)}<small class="block">${e(p.datasetId)}</small></td><td><select data-net-dia="${e(p.datasetId)}">${p.timetables.map((d) => `<option value="${e(d.id)}" ${d.id === m?.timetableId ? "selected" : ""}>${e(d.name)}</option>`).join("")}</select></td><td><input data-net-group="${e(p.datasetId)}" value="${e(m?.group ?? "")}"></td></tr>`;
    })
    .join(
      "",
    )}</tbody></table></div><div class="route-options"><label>共通利用日区分<input id="net-group" value="${e(c.serviceMapping?.group ?? "")}"></label><label>対応付けの根拠<input id="net-basis" value="${e(c.serviceMapping?.basis ?? "")}"></label><label>需要開始<input id="net-start" value="${clock(c.start)}"></label><label>需要終了<input id="net-end" value="${clock(c.end)}"></label><label>輸送の計算終了<input id="net-horizon" value="${clock(c.simulationEnd ?? c.end + c.maxJourneySeconds)}"></label><label>配分方式<select id="net-method"><option value="fastest" ${c.method === "fastest" ? "selected" : ""}>最速到着</option><option value="logit" ${c.method === "logit" ? "selected" : ""}>目的別ロジット</option></select></label><label>輸送定員<select id="net-capacity"><option value="on" ${c.capacityConstrained ? "selected" : ""}>制約あり</option><option value="off" ${!c.capacityConstrained ? "selected" : ""}>無制約</option></select></label><label>定員不明便<select id="net-unknown"><option value="error">計算停止</option><option value="exclude" ${c.unknownCapacityPolicy === "exclude" ? "selected" : ""}>明示除外</option></select></label><label>到着時刻モデル<select id="net-arrival-mode"><option value="minute" ${c.arrivalModel?.mode === "minute" ? "selected" : ""}>時刻分布モデル</option><option value="representative" ${c.arrivalModel?.mode !== "minute" ? "selected" : ""}>従来の代表時刻</option></select></label><label>枠内の分布<select id="net-distribution">${[
    ["uniform", "一様"],
    ["front", "前半集中"],
    ["back", "後半集中"],
    ["custom", "任意重み"],
  ]
    .map(
      ([id, text]) =>
        `<option value="${id}" ${(c.arrivalModel?.distribution ?? "uniform") === id ? "selected" : ""}>${text}</option>`,
    )
    .join(
      "",
    )}</select></label>${numeric("net-step", "到着枠の刻み（秒）", c.arrivalModel?.stepSeconds ?? 60, 1)}<label>任意重み（カンマ区切り）<input id="net-weights" value="${e(c.arrivalModel?.weights?.join(",") ?? "")}" placeholder="例：1,2,4"></label><label>人数<select id="net-integer"><option value="fractional" ${!c.integer ? "selected" : ""}>実数</option><option value="integer" ${c.integer ? "selected" : ""}>整数・最大剰余</option></select></label>${numeric("net-transfers", "最大乗換回数", c.maxTransfers)}${numeric("net-minimum", "最低乗換（分）", c.minimumTransferSeconds / 60)}${numeric("net-wait", "初期待ち上限（分）", c.maxWaitSeconds / 60)}${numeric("net-duration", "駅到着後の所要上限（分）", c.maxJourneySeconds / 60, 1)}${numeric("net-choices", "ロジット候補上限", c.maxChoices, 1)}<label>利用可能な移動制約タグ<input id="net-permits" value="${e(state?.permittedRestrictions.join(",") ?? "")}"></label></div><details><summary>目的別ロジット係数</summary><div class="table-wrap"><table><thead><tr><th>目的</th><th>乗車</th><th>待ち</th><th>徒歩</th><th>1乗換の分</th><th>感度</th></tr></thead><tbody>${purposes.map((p) => `<tr><td>${purposeLabels[p]}</td>${(["riding", "waiting", "walking", "transferPenalty", "scale"] as const).map((k) => `<td><input type="number" min="0" step="any" data-net-purpose="${p}" data-net-coefficient="${k}" value="${c.coefficients[p][k]}"></td>`).join("")}</tr>`).join("")}</tbody></table></div></details><p class="muted">需要時刻は出発駅で乗車機会を探し始める時刻です。アクセス時間はOD行で明示した場合だけ加算します。1分枠も発車境界で細分し、枠の中点で集計します。個人単位の連続到着ではありません。</p><div class="actions"><button data-net-action="save-settings" class="primary">統合条件を保存</button><button data-net-action="sample">架空の鉄道・バス網を追加</button><button data-net-action="workspace">全データ・統合設定JSON</button></div></section>`;
}
function links() {
  return `<section class="panel" id="network-links"><h2>徒歩連絡（明示設定のみ）</h2><div class="route-options"><label>接続元<select id="net-link-from">${options("")}</select></label><label>接続先<select id="net-link-to">${options("")}</select></label>${numeric("net-link-walk", "徒歩秒", 180)}${numeric("net-link-extra", "追加乗換秒", 0)}<label>方向<select id="net-link-direction"><option value="forward">片方向</option><option value="both">双方向</option></select></label><label>移動制約タグ<input id="net-link-restrictions" placeholder="未入力＝制約なし"></label><label>設定根拠<input id="net-link-basis"></label><button data-net-action="add-link">徒歩連絡を追加</button></div><p class="muted">移動制約付きリンクは、統合条件でそのタグを明示許可した場合だけ利用します。無効化したリンクは保存したまま検索から除外します。</p><div class="table-wrap"><table><thead><tr><th>接続</th><th>方向</th><th>徒歩＋追加</th><th>制約・根拠</th><th>操作</th></tr></thead><tbody>${workspace.transferLinks.map((l) => `<tr><td>${e(label(l.from))} → ${e(label(l.to))}</td><td>${l.direction === "both" ? "双方向" : "片方向"}</td><td>${l.walkingSeconds}＋${l.additionalTransferSeconds ?? 0}秒</td><td>${e(l.restrictions?.join(",") ?? "")} ／ ${e(l.basis)}</td><td><button data-net-toggle="${e(l.id)}">${l.enabled === false ? "有効にする" : "無効にする"}</button><button data-net-remove-link="${e(l.id)}">削除</button></td></tr>`).join("")}</tbody></table></div></section>`;
}
function demands() {
  const state = workspace.integration,
    c = state?.config ?? defaultAssignmentConfig();
  return `<section class="panel" id="network-demands"><h2>統合OD需要</h2><p class="notice">人口からの需要自動生成とは独立した固定需要です。異なる路線の需要を移し替えただけで新規旅客を加算しません。復元は「ダイヤデータ管理」の全データセットJSON読込を使用してください。</p><div class="route-options"><label>出発駅<select id="net-od-origin">${options("")}</select></label><label>目的駅<select id="net-od-destination">${options("")}</select></label><label>目的<select id="net-od-purpose">${purposes.map((p) => `<option value="${p}">${purposeLabels[p]}</option>`).join("")}</select></label><label>往復<select id="net-od-kind"><option value="outbound">往路</option><option value="return">帰路</option></select></label><label>時間枠開始<input id="net-od-start" value="${clock(c.start)}"></label><label>時間枠終了<input id="net-od-end" value="${clock(c.end)}"></label>${numeric("net-od-count", "人数", 60)}${numeric("net-od-access", "明示アクセス（秒）", 0)}<label>出典<select id="net-od-source"><option value="manual">手動設定</option><option value="estimated">推計</option><option value="observed">実測（利用者指定）</option></select></label><button data-net-action="add-demand">ODを追加</button></div><div class="actions"><button data-net-action="demand-csv">統合OD CSV・テンプレート</button><label class="file-button">統合OD CSV置換<input type="file" accept=".csv" id="net-demand-file"></label><button data-net-action="import-current">現在のプロジェクトの時間帯需要を追加</button></div><p>保存OD ${state?.demands.length ?? 0}件・${n(state?.demands.reduce((s, d) => s + d.passengers, 0) ?? 0)}人。0人のODは経路探索しません。</p><div class="table-wrap"><table><thead><tr><th>OD</th><th>目的・出典</th><th>時間枠</th><th>人数</th><th>操作</th></tr></thead><tbody>${
    state?.demands
      .slice(0, 100)
      .map(
        (d, i) =>
          `<tr><td>${e(label({ datasetId: d.datasetId, stationId: d.origin }))} → ${e(label({ datasetId: d.destinationDatasetId ?? d.datasetId, stationId: d.destination }))}</td><td>${purposeLabels[d.purpose]} / ${e({ manual: "手動設定値", estimated: "推計値", observed: "実測値" }[d.source])}</td><td>${clock(d.start)}–${clock(d.end)}</td><td>${n(d.passengers)}</td><td><button data-net-remove-demand="${i}">削除</button></td></tr>`,
      )
      .join("") ?? ""
  }</tbody></table></div></section>`;
}
function resultsHtml(r: AssignmentResult) {
  const flows = passengerFlows(r);
  if (!analysisOrigin && flows[0]) analysisOrigin = stationKey(flows[0].origin);
  if (!analysisDestination && flows[0])
    analysisDestination = stationKey(flows[0].destination);
  const selected = flows.filter(
      (f) =>
        stationKey(f.origin) === analysisOrigin &&
        stationKey(f.destination) === analysisDestination,
    ),
    summary = flowSummary(selected),
    cohortIds = new Set(selected.map((f) => f.cohortId)),
    extra =
      r.capacity?.events
        .filter((e) => cohortIds.has(e.cohortId))
        .reduce((s, e) => s + e.additionalWaitPersonSeconds, 0) ?? 0;
  const loads = (r.capacity?.loads ?? r.loads)
      .slice()
      .sort((a, b) => b.peakLoad - a.peakLoad),
    picked = loads.find((l) => l.key === trainKey) ?? loads[0];
  if (picked) trainKey = picked.key;
  const benefit =
    results.length > 1 ? compareBenefits(results[0], results[1]) : null;
  const totals = r.capacity?.totals;
  const metrics = totals
    ? [
        ["需要", totals.selected],
        ["需要発生前", totals.notStarted ?? 0],
        ["輸送完了", totals.completed],
        ["車内", totals.inTransit],
        ["徒歩・アクセス中", totals.walking],
        ["駅で待機", totals.waiting],
        ["経路なし", totals.noPath],
      ]
    : [
        ["需要", r.totals.selected],
        ["予定配分", r.totals.assigned],
        ["未配分", r.totals.unassigned],
      ];
  return `<section class="panel" id="network-result"><h2>統合配分結果（推計）</h2><label>計算結果<select id="net-result-index">${results.map((v, i) => `<option value="${i}" ${i === resultIndex ? "selected" : ""}>${e(resultLabels[i] ?? String(i + 1))} ／ ${v.config.arrivalModel?.mode === "minute" ? "時刻分布" : "代表時刻"}・${v.config.capacityConstrained ? "定員制約あり" : "無制約"}</option>`).join("")}</select></label><div class="metrics">${metrics.map(([text, value]) => `<article class="metric"><span>${text}</span><strong>${n(value as number)}<small>人</small></strong></article>`).join("")}</div><p>乗車イベント ${n((r.capacity?.loads ?? r.loads).reduce((s, l) => s + l.totalBoardings, 0))}人回 ／ 積み残し経験 ${n(totals?.deniedUnique)}人 ／ 追加待ち ${n((totals?.additionalWaitPersonSeconds ?? 0) / 60)}人分。徒歩中を輸送完了に含めません。</p><div class="actions">${["result-json", "od-csv", "train-csv", "segment-csv", "paths-csv", "untransported-csv"].map((id) => `<button data-net-action="${id}">${({ "result-json": "分析結果JSON", "od-csv": "OD流動CSV", "train-csv": "列車CSV", "segment-csv": "区間CSV", "paths-csv": "旅程CSV", "untransported-csv": "未輸送CSV" } as Record<string, string>)[id]}</button>`).join("")}</div>${benefit ? `<p class="notice">代表時刻／時刻分布の比較：共通輸送 ${n(benefit.common)}人、比較対象外 ${n(benefit.excluded)}人、総旅客時間差 ${n(benefit.travelChangePersonSeconds / 60)}人分。${e(benefit.reason)}</p>` : ""}<details><summary>読込・計算警告</summary><ul>${[...new Set(r.capacity?.warnings ?? r.diagnostics.warnings)].map((w) => `<li>${e(w)}</li>`).join("")}</ul></details></section><section class="panel"><h2>OD別の旅客流動</h2><div class="route-options"><label>出発駅<select id="net-analysis-origin">${options(analysisOrigin)}</select></label><label>目的駅<select id="net-analysis-destination">${options(analysisDestination)}</select></label></div><div id="od-flow-summary"><p>対象 ${n(summary.demand)}人 ／ 輸送完了 ${n(summary.completed)}人 ／ 未輸送 ${n(summary.untransported)}人。</p><p>平均所要 ${n(summary.meanTravelSeconds === null ? null : summary.meanTravelSeconds / 60)}分 ／ 平均待ち ${n(summary.meanWaitingSeconds === null ? null : summary.meanWaitingSeconds / 60)}分 ／ 追加待ち ${n(extra / 60)}人分。平均の対象は輸送完了旅客のみ、時間評価から除外 ${n(summary.excludedTimePassengers)}人。</p></div><div class="table-wrap"><table><thead><tr><th>到着時刻</th><th>目的</th><th>状態</th><th>人数</th><th>利用列車・乗換</th></tr></thead><tbody>${selected
    .slice(0, 100)
    .map(
      (f) =>
        `<tr><td>${clock(f.time)}</td><td>${purposeLabels[f.purpose as keyof typeof purposeLabels]}</td><td>${e(({ notStarted: "需要発生前", completed: "輸送完了", inTransit: "車内移動", walking: "徒歩・アクセス中", waiting: "乗車待ち", noPath: "経路なし" } as Record<string, string>)[f.state])}</td><td>${n(f.passengers)}</td><td>${f.legs.map((l) => e(l.datasetId + " / " + l.timetableId + " / " + (l.trainNumber || l.trainId))).join(" → ") || "乗車なし"}（乗換 ${f.transfers}回）</td></tr>`,
    )
    .join(
      "",
    )}</tbody></table></div><h3>時間帯別需要と輸送完了</h3><div class="table-wrap"><table><thead><tr><th>時台</th><th>需要</th><th>完了</th><th>未輸送</th></tr></thead><tbody>${odFlowRows(
    r,
  )
    .filter(
      (v) =>
        stationKey(v.origin) === analysisOrigin &&
        stationKey(v.destination) === analysisDestination,
    )
    .map(
      (v) =>
        `<tr><td>${v.hour}:00</td><td>${n(v.demand)}</td><td>${n(v.completed)}</td><td>${n(v.untransported)}</td></tr>`,
    )
    .join(
      "",
    )}</tbody></table></div></section>${picked ? trainHtml(r, picked) : ""}`;
}
function trainHtml(r: AssignmentResult, l: AssignmentResult["loads"][number]) {
  const loads = r.capacity?.loads ?? r.loads,
    contributions = trainContributions(r, l.key),
    denied =
      r.capacity?.events
        .filter((e) => e.trainKey === l.key && e.type === "denied")
        .reduce((s, e) => s + e.passengers, 0) ?? 0,
    width = Math.max(550, l.stops.length * 70),
    step = width / Math.max(1, l.stops.length - 1),
    max = Math.max(1, l.peakLoad, l.capacity ?? 0),
    points = l.stops
      .map((s, i) => ({ s, i }))
      .filter(
        ({ s }) =>
          l.observedUntil === undefined ||
          (s.departure ?? s.arrival ?? Infinity) <= l.observedUntil,
      )
      .map(
        ({ i }) =>
          `${i * step},${150 - ((l.segmentLoads[i] ?? 0) / max) * 130}`,
      )
      .join(" ");
  return `<section class="panel" id="network-train-detail"><h2>列車別の乗降・混雑要因</h2><label>列車・便<select id="net-analysis-train">${loads.map((v) => `<option value="${e(v.key)}" ${v.key === l.key ? "selected" : ""}>${e(v.datasetId + " / " + v.timetableId + " / " + (v.trainNumber || v.trainId))}</option>`).join("")}</select></label><p>最大車内 ${n(l.peakLoad)}人 ／ 輸送定員 ${l.capacity === null ? "不明" : n(l.capacity)}人 ／ 最大混雑率 ${l.peakOccupancy === null ? "未算出" : n(l.peakOccupancy * 100) + "%"} ／ 積み残し ${n(denied)}人回。</p><p>最大混雑区間：${l.peakSegments.map((i) => e(label({ datasetId: l.datasetId, stationId: l.stops[i].stationId })) + " → " + e(label({ datasetId: l.datasetId, stationId: l.stops[i + 1].stationId }))).join("、") || "該当なし"}</p><div class="flow-scroll"><svg role="img" aria-label="区間車内人数" viewBox="-10 0 ${width + 20} 170" style="min-width:${width}px;height:170px"><polyline points="${points}" fill="none" stroke="#087f71" stroke-width="3"/></svg></div><div class="table-wrap"><table><thead><tr><th>駅・停留所</th><th>着 / 発</th><th>乗車</th><th>降車</th><th>次区間車内</th><th>混雑率</th></tr></thead><tbody>${l.stops.map((s, i) => `<tr><td>${e(label({ datasetId: l.datasetId, stationId: s.stationId }))}</td><td>${s.arrival === undefined ? "—" : clock(s.arrival)} / ${s.departure === undefined ? "—" : clock(s.departure)}</td><td>${n(l.boardings[i])}</td><td>${n(l.alightings[i])}</td><td>${l.segmentObserved?.[i] === false ? "期間外" : i < l.segmentLoads.length ? n(l.segmentLoads[i]) : "—"}</td><td>${l.occupancies[i] === null || l.occupancies[i] === undefined ? "—" : n(l.occupancies[i]! * 100) + "%"}</td></tr>`).join("")}</tbody></table></div><h3>最大断面のOD内訳（計算根拠）</h3><p class="muted">同じ断面を乗車区間に含む旅客だけを集計しています。構成比を示すもので、需要が混雑を引き起こした因果関係を観測したものではありません。未輸送の旅客は乗車人数へ加えません。</p><div class="table-wrap"><table><thead><tr><th>OD</th><th>目的</th><th>人数</th><th>最大断面の比率</th><th>うち乗換乗車</th></tr></thead><tbody>${contributions.map((v) => `<tr><td>${e(label(v.origin))} → ${e(label(v.destination))}</td><td>${purposeLabels[v.purpose as keyof typeof purposeLabels]}</td><td>${n(v.passengers)}</td><td>${l.peakLoad ? n((v.passengers / l.peakLoad) * 100) + "%" : "—"}</td><td>${n(v.transferBoardings)}</td></tr>`).join("")}</tbody></table></div></section>`;
}
export function renderNetwork(ctx: UIContext) {
  if (stamp && stamp !== fingerprint()) {
    clear("データ・条件が変わったため以前の結果を無効化しました");
    stamp = "";
  }
  const r = results[resultIndex];
  return `<div id="network-page"><p class="notice">統合配分は実測人数ではなく推計です。実ファイル同士の徒歩接続は自動登録しません。架空サンプルは計算検証用です。</p>${error ? `<p role="alert" class="notice">${e(error)}</p>` : ""}<p id="network-progress" role="status">${e(progress)}</p>${settings()}${links()}${demands()}<section class="panel"><div class="actions"><button data-net-action="run" class="primary">統合旅客配分を計算</button><button data-net-action="compare-arrival">代表時刻と時刻分布を比較</button><button data-net-action="precision">時刻精度4方式を比較</button><button data-net-action="scenario-range">仮定シナリオの変動幅を比較</button>${worker ? '<button data-net-action="cancel">計算を中止</button>' : ""}</div></section>${r ? '<div id="network-results-area">' + resultsHtml(r) + precisionView(results, resultLabels) + diagnosticView(r) + "</div>" : '<div class="route-empty">条件・明示徒歩連絡・統合ODを確認して計算してください。</div>'}</div>`;
}
function saveConditions(ctx: UIContext) {
  const previous = workspace.integration,
    base = previous?.config ?? defaultAssignmentConfig(),
    members = Array.from(
      document.querySelectorAll<HTMLInputElement>("[data-net-use]:checked"),
    ).map((el) => {
      const id = el.dataset.netUse!;
      return {
        ...base.serviceMapping?.members.find((m) => m.datasetId === id),
        datasetId: id,
        timetableId: (
          document.querySelector(
            `[data-net-dia="${CSS.escape(id)}"]`,
          ) as HTMLSelectElement
        ).value,
        group: (
          document.querySelector(
            `[data-net-group="${CSS.escape(id)}"]`,
          ) as HTMLInputElement
        ).value,
      };
    });
  const config: AssignmentConfig = {
    ...base,
    competition: read("net-competition") as "legacy" | "simultaneous",
    diagnosticMode: read("net-diagnostic") as "summary" | "full",
    boardingCutoffSeconds: Number(read("net-cutoff")),
    serviceMapping: {
      ...base.serviceMapping,
      group: read("net-group"),
      basis: read("net-basis"),
      members,
    },
    start: parseClock(read("net-start")),
    end: parseClock(read("net-end")),
    simulationEnd: parseClock(read("net-horizon")),
    method: read("net-method") as "fastest" | "logit",
    capacityConstrained: read("net-capacity") === "on",
    unknownCapacityPolicy: read("net-unknown") as "error" | "exclude",
    integer: read("net-integer") === "integer",
    maxTransfers: Number(read("net-transfers")),
    minimumTransferSeconds: Number(read("net-minimum")) * 60,
    maxWaitSeconds: Number(read("net-wait")) * 60,
    maxJourneySeconds: Number(read("net-duration")) * 60,
    maxChoices: Number(read("net-choices")),
    arrivalModel: {
      ...base.arrivalModel,
      timing: read("net-timing") as "midpoint",
      integrationSeconds: Number(read("net-integration")),
      mode: read("net-arrival-mode") as "minute" | "representative",
      distribution: read("net-distribution") as "uniform",
      stepSeconds: Number(read("net-step")),
      weights: read("net-weights").trim()
        ? read("net-weights").split(",").map(Number)
        : undefined,
    },
    coefficients: structuredClone(base.coefficients),
  };
  for (const el of Array.from(
    document.querySelectorAll<HTMLInputElement>("[data-net-purpose]"),
  ))
    config.coefficients[
      el.dataset.netPurpose as keyof typeof config.coefficients
    ][el.dataset.netCoefficient as "riding"] = Number(el.value);
  const state: IntegrationState = {
    ...previous,
    version: 1,
    config,
    permittedRestrictions: read("net-permits")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean),
    demands: previous?.demands ?? [],
  };
  validateIntegration(state, workspace.projects);
  workspace.integration = state;
  clear("統合条件を保存しました");
  dirty = false;
  draft.clear();
  ctx.save();
}
function start(ctx: UIContext, compareArrival: boolean, experiment = "") {
  if (dirty) throw new Error("変更した統合条件を先に保存してください");
  const state = workspace.integration;
  if (!state)
    throw new Error("統合条件を保存するか架空サンプルを追加してください");
  validateIntegration(state, workspace.projects);
  clear();
  stamp = fingerprint();
  const current = new Worker(new URL("./network-worker.ts", import.meta.url), {
    type: "module",
  });
  worker = current;
  progress = "統合索引と旅客配分を計算中…";
  current.onmessage = (event) => {
    if (worker !== current) return;
    const d = event.data;
    if (d.type === "progress") {
      const el = document.querySelector("#network-progress");
      if (el)
        el.textContent = `${d.mode === "minute" ? "時刻分布" : "代表時刻"}：${d.done}/${d.total} ${d.stage === "events" ? "イベント" : "OD"}`;
      return;
    }
    const transferMs = d.sentAt
      ? performance.timeOrigin + performance.now() - d.sentAt
      : null;
    worker = null;
    current.terminate();
    if (stamp !== fingerprint()) {
      clear("条件変更のため結果を破棄しました");
    } else if (d.type === "error") error = d.message;
    else {
      results = d.results;
      resultLabels = d.labels ?? [];
      resultIndex = compareArrival ? 1 : 0;
      progress = "統合配分完了。全データセットで人数・時刻・定員を検証しました";
    }
    const renderStarted = performance.now();
    ctx.render();
    const renderMs = performance.now() - renderStarted;
    if (d.type === "result") {
      const report = {
        workerComputeMs: d.workerComputeMs,
        transferAndSchedulingMs: transferMs,
        renderMs,
        resultTimings: results.map((r) => r.diagnostics.timings),
      };
      (
        globalThis as typeof globalThis & { railwayPerformance?: unknown }
      ).railwayPerformance = report;
      const target = document.querySelector("#network-progress");
      if (target)
        target.textContent += ` ／ Worker ${Math.round(d.workerComputeMs)}ms・転送等 ${Math.round(transferMs ?? 0)}ms・描画 ${Math.round(renderMs)}ms`;
    }
  };
  current.onerror = (event) => {
    clear();
    error = event.message;
    ctx.render();
  };
  current.postMessage({
    state,
    compareArrival,
    experiment,
    links: workspace.transferLinks,
    projects: workspace.projects.map((p) => ({
      ...p,
      analytics: undefined,
      temporal: undefined,
      temporalConfig: undefined,
    })),
  });
}
export function networkClick(button: HTMLElement, ctx: UIContext) {
  const action = button.dataset.netAction,
    toggle = button.dataset.netToggle,
    remove = button.dataset.netRemoveLink,
    removeDemand = button.dataset.netRemoveDemand;
  if (!action && !toggle && !remove && removeDemand === undefined) return false;
  try {
    error = "";
    if (toggle || remove) {
      const next = workspace.transferLinks
        .map((l) =>
          l.id === toggle ? { ...l, enabled: l.enabled === false } : l,
        )
        .filter((l) => l.id !== remove);
      workspace.transferLinks = next;
      clear();
      ctx.save();
    } else if (removeDemand !== undefined) {
      workspace.integration!.demands.splice(Number(removeDemand), 1);
      clear();
      ctx.save();
    } else if (action === "save-settings") saveConditions(ctx);
    else if (action === "sample") {
      const sample = networkSample();
      for (const p of sample.projects) {
        if (workspace.projects.some((v) => v.datasetId === p.datasetId))
          throw new Error("架空ネットワークは既に登録済みです");
      }
      workspace.projects.push(...sample.projects);
      workspace.transferLinks.push(...sample.links);
      workspace.integration = {
        version: 1,
        config: {
          ...sample.config,
          competition: "simultaneous",
          diagnosticMode: "summary",
        },
        permittedRestrictions: [],
        demands: sample.demands,
      };
      dirty = false;
      draft.clear();
      clear("架空の鉄道・バス網を追加しました。実在の接続ではありません");
      ctx.save();
    } else if (action === "workspace") {
      download(
        "integrated-workspace.json",
        JSON.stringify(workspace, null, 2),
        "application/json",
      );
      return true;
    } else if (action === "add-link") {
      const from = JSON.parse(read("net-link-from")) as [string, string],
        to = JSON.parse(read("net-link-to")) as [string, string],
        link = {
          id: crypto.randomUUID(),
          from: { datasetId: from[0], stationId: from[1] },
          to: { datasetId: to[0], stationId: to[1] },
          walkingSeconds: Number(read("net-link-walk")),
          additionalTransferSeconds: Number(read("net-link-extra")),
          direction: read("net-link-direction") as "forward" | "both",
          basis: read("net-link-basis"),
          enabled: true,
          restrictions: read("net-link-restrictions")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        };
      validateTransferLinks(
        [link],
        workspace.projects.map((p) => ({
          datasetId: p.datasetId!,
          project: p,
        })),
      );
      workspace.transferLinks.push(link);
      clear();
      ctx.save();
    } else if (action === "add-demand") {
      const state = workspace.integration;
      if (!state) throw new Error("先に統合条件を保存してください");
      const [datasetId, origin] = JSON.parse(read("net-od-origin")),
        [destinationDatasetId, destination] = JSON.parse(
          read("net-od-destination"),
        );
      const row = {
        datasetId,
        origin,
        destinationDatasetId,
        destination,
        purpose: read("net-od-purpose") as "commute",
        kind: read("net-od-kind") as "outbound",
        start: parseClock(read("net-od-start")),
        end: parseClock(read("net-od-end")),
        passengers: Number(read("net-od-count")),
        source: read("net-od-source") as "manual",
        accessSeconds: Number(read("net-od-access")),
      };
      const next = { ...state, demands: [...state.demands, row] };
      validateIntegration(next, workspace.projects);
      workspace.integration = next;
      clear();
      ctx.save();
    } else if (action === "demand-csv") {
      download(
        "network-demand.csv",
        networkDemandCsv(workspace.integration?.demands ?? []),
        "text/csv",
      );
      return true;
    } else if (action === "import-current") {
      const state = workspace.integration;
      if (!state || !ctx.project.temporal)
        throw new Error("統合条件と現在の時間帯需要が必要です");
      const next = {
        ...state,
        demands: [
          ...state.demands,
          ...ctx.project.temporal.slots.map((d) => ({
            ...d,
            datasetId: ctx.project.datasetId!,
            destinationDatasetId: ctx.project.datasetId!,
          })),
        ],
      };
      validateIntegration(next, workspace.projects);
      workspace.integration = next;
      clear();
      ctx.save();
    } else if (action === "precision" || action === "scenario-range")
      start(ctx, false, action);
    else if (action === "run" || action === "compare-arrival")
      start(ctx, action === "compare-arrival");
    else if (action === "cancel")
      clear("計算を中止しました。部分結果は表示しません");
    else {
      const r = results[resultIndex];
      if (!r) throw new Error("配分結果がありません");
      if (action === "diagnostic-csv") {
        download("assignment-diagnostic.csv", diagnosticCsv(r), "text/csv");
        return true;
      }
      if (action === "diagnostic-json") {
        download(
          "assignment-diagnostic.json",
          JSON.stringify(
            {
              version: "0.6",
              config: r.config,
              input: r.input,
              audit: r.audit,
              packets: r.capacity?.packets,
            },
            null,
            2,
          ),
          "application/json",
        );
        return true;
      }
      if (action === "result-json")
        download(
          "network-analysis.json",
          JSON.stringify(
            {
              version: "0.6",
              resultLabels,
              comparisonResults: results.length > 1 ? results : undefined,
              generatedAt: new Date().toISOString(),
              serviceMapping: r.config.serviceMapping,
              result: r,
            },
            null,
            2,
          ),
          "application/json",
        );
      if (action === "od-csv") {
        const rows = odFlowRows(r);
        download(
          "network-od-flows.csv",
          csv([
            [
              "originDataset",
              "origin",
              "destinationDataset",
              "destination",
              "purpose",
              "hour",
              "demand",
              "completed",
              "untransported",
              "meanTravelSeconds",
              "meanWaitingSeconds",
            ],
            ...rows.map((v) => [
              v.origin.datasetId,
              v.origin.stationId,
              v.destination.datasetId,
              v.destination.stationId,
              v.purpose,
              v.hour,
              v.demand,
              v.completed,
              v.untransported,
              v.meanTravelSeconds ?? "",
              v.meanWaitingSeconds ?? "",
            ]),
          ]),
          "text/csv",
        );
      }
      const exports = {
        "train-csv": ["network-trains.csv", trainLoadsCsv],
        "segment-csv": ["network-segments.csv", segmentLoadsCsv],
        "paths-csv": ["network-paths.csv", allocationsCsv],
        "untransported-csv": ["network-untransported.csv", unallocatedCsv],
      } as const;
      const entry = exports[action as keyof typeof exports];
      if (entry) download(entry[0], entry[1](r), "text/csv");
      return true;
    }
  } catch (err) {
    error = (err as Error).message;
  }
  ctx.render();
  return true;
}
export async function networkChange(el: HTMLInputElement, ctx: UIContext) {
  const selector = el.id
    ? "#" + CSS.escape(el.id)
    : el.dataset.netUse
      ? `[data-net-use="${CSS.escape(el.dataset.netUse)}"]`
      : el.dataset.netDia
        ? `[data-net-dia="${CSS.escape(el.dataset.netDia)}"]`
        : el.dataset.netGroup
          ? `[data-net-group="${CSS.escape(el.dataset.netGroup)}"]`
          : el.dataset.netPurpose
            ? `[data-net-purpose="${el.dataset.netPurpose}"][data-net-coefficient="${el.dataset.netCoefficient}"]`
            : "";
  if (
    selector &&
    el.type !== "file" &&
    !el.id.startsWith("net-analysis") &&
    el.id !== "net-result-index"
  )
    draft.set(selector, el.type === "checkbox" ? el.checked : el.value);
  if (el.id === "net-demand-file") {
    try {
      if (!workspace.integration)
        throw new Error("先に統合条件を保存してください");
      const file = el.files?.[0];
      if (file) {
        const demands = importNetworkDemand(
          await file.text(),
          workspace.integration,
          workspace.projects,
        );
        workspace.integration = { ...workspace.integration, demands };
        clear("統合ODを読み込みました");
        ctx.save();
        error = "";
      }
    } catch (err) {
      error = (err as Error).message;
    }
    ctx.render();
    return;
  }
  if (results[resultIndex] && diagnosticChange(el, results[resultIndex]))
    return;
  if (el.id === "net-result-index") {
    resultIndex = Number(el.value);
    ctx.render();
    return;
  }
  if (el.id === "net-analysis-origin") {
    analysisOrigin = el.value;
    ctx.render();
    return;
  }
  if (el.id === "net-analysis-destination") {
    analysisDestination = el.value;
    ctx.render();
    return;
  }
  if (el.id === "net-analysis-train") {
    trainKey = el.value;
    ctx.render();
    return;
  }
  if (el.closest("#network-settings")) {
    dirty = true;
    clear("統合条件が未保存です。保存後に再計算してください");
    document.querySelector("#network-results-area")?.remove();
    document.querySelector("#network-progress")!.textContent = progress;
  }
}

import {
  renderCapacityControls,
  renderCapacityOutput,
  renderCapacityComparison,
  capacityEventsCsv,
  capacityStatesCsv,
} from "./capacity-output";
import { clock } from "./analysis";
import {
  defaultAssignmentConfig,
  validateAssignmentConfig,
  type AssignmentConfig,
  type AssignmentResult,
  type TrainLoad,
} from "./assignment-model";
import { classificationCounts } from "./classification";
import {
  defaultTemporalConfig,
  generateTemporalDemand,
} from "./temporal-demand";
import { purposeLabels, purposes } from "./temporal-model";
import {
  trainLoadsCsv,
  segmentLoadsCsv,
  unallocatedCsv,
  allocationsCsv,
} from "./assignment-io";
import { download } from "./io";
import { escapeHtml as e, numberText as n, type UIContext } from "./ui-utils";
let dataset = "",
  direction = "",
  selected = "",
  displayMethod = "fastest",
  error = "",
  progress = "",
  worker: Worker | null = null,
  results: AssignmentResult[] = [],
  runStamp = "",
  sourceProject: unknown;
const labels = {
  fastest: "最短所要時間（駅到着から）",
  logit: "確率的選択（ロジット）",
};
function stamp(ctx: UIContext) {
  const p = ctx.project;
  return JSON.stringify([
    p.datasetId,
    ctx.diaId,
    p.assignmentConfig,
    p.serviceClasses,
    p.typeCapacities,
    p.capacitySettings,
    p.timetables
      .find((d) => d.id === ctx.diaId)
      ?.trains.map((t) => [t.id, t.capacity]),
    p.temporal?.slots,
    ctx.links.filter(
      (l) => l.from.datasetId === p.datasetId && l.to.datasetId === p.datasetId,
    ),
  ]);
}
function stop() {
  worker?.terminate();
  worker = null;
  progress = "";
}
function ensure(ctx: UIContext) {
  ctx.project.assignmentConfig ??= defaultAssignmentConfig();
  if (dataset !== ctx.project.datasetId) {
    stop();
    dataset = ctx.project.datasetId!;
    results = [];
    selected = "";
    error = "";
  }
  if (
    (results.length || worker) &&
    (sourceProject !== ctx.project || runStamp !== stamp(ctx))
  ) {
    stop();
    results = [];
    error =
      "需要・営業区分・定員・ダイヤ・配分条件が変わりました。再計算してください";
  }
}
const btn = (action: string, text: string, cls = "") =>
  `<button type="button" data-assignment-action="${action}" class="${cls}">${text}</button>`;
const numeric = (
  id: string,
  label: string,
  value: number,
  min = 0,
  step = "any",
  max?: number,
) =>
  `<label>${label}<input id="${id}" type="number" min="${min}" step="${step}" ${max === undefined ? "" : `max="${max}"`} value="${value}"></label>`;
function name(ctx: UIContext, id: string, datasetId = ctx.project.datasetId) {
  return (
    ctx.projects
      .find((p) => p.datasetId === datasetId)
      ?.stations.find((s) => s.id === id)?.name ?? id
  );
}
function segmentName(ctx: UIContext, l: TrainLoad, i: number) {
  return `${name(ctx, l.stops[i].stationId, l.datasetId)} → ${name(ctx, l.stops[i + 1].stationId, l.datasetId)}`;
}
function display(ctx: UIContext) {
  return (
    results.find(
      (r) =>
        r.config.method + (r.capacity ? ":capacity" : "") === displayMethod,
    ) ?? results[0]
  );
}
export function currentAssignmentResult(ctx: UIContext) {
  ensure(ctx);
  return display(ctx);
}
function detail(ctx: UIContext, l: TrainLoad) {
  const max = Math.max(1, l.peakLoad, ...l.boardings, ...l.alightings);
  const width = Math.max(550, l.stops.length * 74),
    step = width / Math.max(1, l.stops.length - 1);
  const visible = l.stops
    .map((s, i) => ({ s, i }))
    .filter(
      ({ s }) =>
        l.observedUntil === undefined ||
        (s.departure ?? s.arrival ?? Infinity) <= l.observedUntil,
    );
  const points = visible
    .map(
      ({ i }) => `${i * step},${150 - ((l.segmentLoads[i] ?? 0) / max) * 130}`,
    )
    .join(" ");
  return `<section class="panel" id="train-load-detail"><h2>${e(l.trainNumber || l.trainId)} ／ ${e(l.typeName)}の旅客数推移</h2><p class="muted">入力ODに基づく推計値。乗車 ${n(l.totalBoardings)}人・降車 ${n(l.totalAlightings)}人・最大車内 ${n(l.peakLoad)}人。${l.capacity === null ? "定員不明のため混雑率は算出しません" : `定員 ${n(l.capacity, 0)}人（${l.capacitySource === "train" ? "個別設定" : "種別設定"}）・最大混雑率 ${n(l.peakOccupancy! * 100)}%`}</p><div class="flow-scroll"><svg class="load-line-chart" viewBox="-10 0 ${width + 20} 175" style="min-width:${width}px" role="img" aria-label="各停車位置の発車後車内人数。正確な人数は下表に記載"><path d="M0 150 H${width}" stroke="#dae5df" fill="none"/><polyline points="${points}" fill="none" stroke="#087f71" stroke-width="3"/>${visible.map(({ i }) => `<circle cx="${i * step}" cy="${150 - ((l.segmentLoads[i] ?? 0) / max) * 130}" r="4" fill="#087f71"/>`).join("")}</svg><div class="stop-bars" style="min-width:${width}px">${l.stops.map((s, i) => `<div class="stop-bar"><div class="bar-pair"><i title="乗車 ${n(l.boardings[i])}人" style="height:${(l.boardings[i] / max) * 90}px"></i><i title="降車 ${n(l.alightings[i])}人" class="alight-bar" style="height:${(l.alightings[i] / max) * 90}px"></i></div><small>${e(name(ctx, s.stationId, l.datasetId))}</small></div>`).join("")}</div></div><p class="muted">線＝発車後の車内人数、緑棒＝乗車、橙棒＝降車。同一列車内の乗車から降車までだけを計上します。通過駅の乗降は0です。</p><div class="table-wrap"><table><thead><tr><th>駅・停留所</th><th>着 / 発</th><th>乗車</th><th>降車</th><th>次区間の車内</th><th>混雑率</th></tr></thead><tbody>${l.stops.map((s, i) => `<tr><td>${e(name(ctx, s.stationId, l.datasetId))}${s.status === "pass" ? "（通過）" : ""}</td><td>${s.arrival === undefined ? "—" : clock(s.arrival)} / ${s.departure === undefined ? "—" : clock(s.departure)}</td><td>${n(l.boardings[i])}</td><td>${n(l.alightings[i])}</td><td>${l.segmentObserved?.[i] === false ? "期間外" : i < l.segmentLoads.length ? n(l.segmentLoads[i]) : l.totalBoardings > l.totalAlightings ? "輸送途中" : "終着 0"}</td><td>${l.occupancies[i] == null ? "—" : n(l.occupancies[i]! * 100) + "%"}</td></tr>`).join("")}</tbody></table></div></section>`;
}
function output(ctx: UIContext, r: AssignmentResult) {
  const totals = r.totals,
    loads = r.loads
      .filter((l) => !direction || l.direction === direction)
      .sort(
        (a, b) =>
          b.peakLoad - a.peakLoad ||
          b.totalBoardings - a.totalBoardings ||
          a.trainId.localeCompare(b.trainId),
      );
  const picked = loads.find((l) => l.key === selected) ?? loads[0];
  if (picked) selected = picked.key;
  const c = new Map(r.cohorts.map((c) => [c.id, c]));
  return `<div class="metrics"><article class="metric"><span>対象時間窓の需要</span><strong>${n(totals.selected)}<small>人</small></strong><p>窓の外 ${n(totals.outsideWindow)}人を別記</p></article><article class="metric"><span>配分済み</span><strong>${n(totals.assigned)}<small>人</small></strong><p>乗換を含む乗車イベント ${n(totals.boardingEvents)}回</p></article><article class="metric"><span>未配分需要</span><strong>${n(totals.unassigned)}<small>人</small></strong><p>人数と理由を保持しています</p></article><article class="metric"><span>需要の収支差</span><strong>${n(totals.selected - totals.assigned - totals.unassigned, 7)}<small>人</small></strong><p>全OD行・到着枠・列車収支を検証済み</p></article></div>${new Set(results.map((x) => x.config.method)).size > 1 ? `<section class="panel"><h2>同じ需要で2方式を比較</h2><div class="table-wrap"><table><thead><tr><th>方式</th><th>配分済み</th><th>未配分</th><th>最大車内人数</th><th>旅客のいる列車</th><th>最多列車の乗車イベント比率</th></tr></thead><tbody>${results.map((x) => `<tr><td>${labels[x.config.method]}</td><td>${n(x.totals.assigned)}</td><td>${n(x.totals.unassigned)}</td><td>${n(Math.max(0, ...x.loads.map((l) => l.peakLoad)))}</td><td>${x.loads.filter((l) => l.peakLoad > 0).length}</td><td>${n(x.totals.boardingEvents ? (Math.max(0, ...x.loads.map((l) => l.totalBoardings)) / x.totals.boardingEvents) * 100 : 0)}%</td></tr>`).join("")}</tbody></table></div></section>` : ""}<section class="panel"><div class="route-result-heading"><h2>列車別の推定旅客数ランキング</h2><label>表示する計算結果<select id="assignment-result-method">${results.map((x) => `<option value="${x.config.method}" ${x === r ? "selected" : ""}>${labels[x.config.method]}</option>`).join("")}</select></label></div><p class="muted">最大車内人数の順。方向は表示だけに適用し、配分・乗換の計算は両方向で実施します。定員超過も全員乗車として計算し、容量制約・積み残しは未対応です。</p><div class="actions">${btn("trains-csv", "列車集計CSV")}${btn("segments-csv", "区間・乗降CSV")}${btn("allocations-csv", "配分旅程CSV")}${btn("unallocated-csv", "未配分CSV")}</div><div class="table-wrap"><table><thead><tr><th>列車・便</th><th>種別 / 方向</th><th>延べ乗車</th><th>最大車内</th><th>最大混雑区間</th><th>定員</th><th>最大混雑率</th></tr></thead><tbody>${loads.map((l) => `<tr><td><button data-assignment-load="${e(l.key)}">${e(l.trainNumber || l.trainId)}</button></td><td>${e(l.typeName)} / ${l.direction === "down" ? "下り" : "上り"}</td><td>${n(l.totalBoardings)}</td><td><b>${n(l.peakLoad)}</b></td><td>${l.peakSegments.map((i) => e(segmentName(ctx, l, i))).join("<br>") || "—"}</td><td>${l.capacity === null ? "不明" : n(l.capacity, 0)}</td><td>${l.peakOccupancy === null ? "算出不可" : `<span class="tag ${l.peakOccupancy > 1 ? "over-capacity" : "green"}">${n(l.peakOccupancy * 100)}%</span>`}</td></tr>`).join("")}</tbody></table></div><h3>列車への集中（乗車イベント比率）</h3><div class="concentration-bars">${
    loads
      .filter((l) => l.totalBoardings > 0)
      .slice(0, 10)
      .map(
        (l) =>
          `<div><span>${e(l.trainNumber || l.trainId)}</span><i style="width:${Math.max(1, totals.boardingEvents ? (l.totalBoardings / totals.boardingEvents) * 100 : 0)}%"></i><b>${n(totals.boardingEvents ? (l.totalBoardings / totals.boardingEvents) * 100 : 0)}%</b></div>`,
      )
      .join("") || '<p class="muted">この方向に配分された旅客はいません。</p>'
  }</div><p class="muted">乗換旅客は利用する各列車に計上します。CSVは全方向の計算結果を保存します。計算 ${n(r.diagnostics.milliseconds / 1000, 2)}秒・経路プロフィール ${r.diagnostics.profiles}OD。</p></section>${picked ? detail(ctx, picked) : ""}<section class="panel"><h2>未配分需要の明細</h2><div class="table-wrap"><table><thead><tr><th>OD</th><th>到着時間枠</th><th>目的 / 往復</th><th>入力の出典</th><th>人数</th><th>理由</th></tr></thead><tbody>${r.unallocated
    .map((u) => {
      const cohort = c.get(u.cohortId)!,
        d = r.input[cohort.demandIndex];
      return `<tr><td>${e(name(ctx, d.origin, d.datasetId))} → ${e(name(ctx, d.destination, d.datasetId))}</td><td>${clock(cohort.start)}–${clock(cohort.end)}</td><td>${purposeLabels[d.purpose]} / ${d.kind === "return" ? "帰路" : "往路"}</td><td>${{ estimated: "推計", observed: "実測", manual: "手動" }[d.source]}</td><td>${n(u.passengers)}</td><td>${e(u.reason)}</td></tr>`;
    })
    .join(
      "",
    )}</tbody></table></div><details class="notice"><summary>読み込み・配分の警告 ${r.diagnostics.warnings.length}件</summary><ul>${r.diagnostics.warnings.map((w) => `<li>${e(w)}</li>`).join("")}</ul></details></section>`;
}
export function renderAssignment(ctx: UIContext) {
  ensure(ctx);
  const p = ctx.project,
    c = p.assignmentConfig!,
    counts = classificationCounts(p, ctx.diaId),
    r = display(ctx);
  return `<div id="assignment-page"><section class="panel"><span class="eyebrow">PASSENGER ASSIGNMENT & LOADS</span><h2>旅客配分・混雑分析</h2><p class="notice">すべて需要モデルに基づく推計値です。入力需要の出典は保持しますが、列車別人数は実測値ではありません。営業 ${counts.passenger}本のみを使用し、非営業 ${counts.nonPassenger}本・要確認 ${counts.review}本を除外します。<button data-page="8">営業区分・定員を確認</button></p>${renderCapacityControls(ctx)}<div class="route-options"><label>対象ダイヤ<select id="assignment-dia">${p.timetables.map((d) => `<option value="${e(d.id)}" ${d.id === ctx.diaId ? "selected" : ""}>${e(d.name)}</option>`).join("")}</select></label>${numeric("assignment-start", "駅到着需要の開始（時）", c.start / 3600, 0, ".25")}${numeric("assignment-end", "終了（時・24時以降可）", c.end / 3600, 0, ".25")}<label>方式<select id="assignment-method"><option value="fastest" ${c.method === "fastest" ? "selected" : ""}>最短所要時間</option><option value="logit" ${c.method === "logit" ? "selected" : ""}>確率的選択（ロジット）</option></select></label><label>表示方向<select id="assignment-direction"><option value="" ${!direction ? "selected" : ""}>全方向</option><option value="down" ${direction === "down" ? "selected" : ""}>下り</option><option value="up" ${direction === "up" ? "selected" : ""}>上り</option></select></label></div><details><summary>乗客到着・経路選択の条件</summary><div class="route-options">${numeric("assignment-transfers", "最大乗換回数", c.maxTransfers, 0, "1", 4)}${numeric("assignment-minimum", "最低乗換（分）", c.minimumTransferSeconds / 60)}${numeric("assignment-wait", "最大初期待ち（分）", c.maxWaitSeconds / 60)}${numeric("assignment-duration", "最大総所要（分）", c.maxJourneySeconds / 60, 1)}${numeric("assignment-choices", "確率方式の候補上限", c.maxChoices, 1, "1", 30)}<label>人数の扱い<select id="assignment-integer"><option value="fractional" ${!c.integer ? "selected" : ""}>実数配分</option><option value="integer" ${c.integer ? "selected" : ""}>整数配分（整数の需要が必要）</option></select></label></div><p class="muted">各時間枠内で駅に一様到着すると仮定し、便の発車時刻・待ち上限で到着枠を分割します。最短方式は駅到着から目的地到着までを最小化。確率方式は下の一般化負担で候補を重み付けします。</p><div class="table-wrap"><table><thead><tr><th>目的</th><th>乗車時間の係数</th><th>待ち時間の係数</th><th>徒歩の係数</th><th>1乗換の負担（分）</th><th>ロジット感度（1/分）</th></tr></thead><tbody>${purposes.map((p) => `<tr><td>${purposeLabels[p]}</td>${(["riding", "waiting", "walking", "transferPenalty", "scale"] as const).map((k) => `<td><input type="number" min="0" step="any" data-choice-purpose="${p}" data-choice-key="${k}" value="${c.coefficients[p][k]}"></td>`).join("")}</tr>`).join("")}</tbody></table></div></details><div class="actions">${btn("run", "需要を列車へ配分", "primary")}${btn("compare", "同じ需要で2方式を比較")}${btn("capacity-compare", "定員制約あり／なしを比較")}${worker ? btn("cancel", "計算を中止") : ""}${!p.temporal ? btn("sample-demand", "現在の都市属性から時間帯需要を生成") : ""}</div><p id="assignment-progress" role="status">${e(progress)}</p>${error ? `<p role="alert" class="notice">${e(error)}</p>` : ""}<p class="muted">配分対象は現在のデータセットの保存済み時間帯需要です。方向フィルターは結果の表示のみ。別データセットを経由する配分、路線外OD、増解結・確定できないレコード間直通は扱いません。計算結果は再読み込み後に再計算してください。設定はJSON・ブラウザに保存します。</p></section>${results.some((x) => x.capacity) ? `<label>計算結果を切替<select id="assignment-capacity-view">${results.map((x) => `<option value="${x.config.method + (x.capacity ? ":capacity" : "")}" ${x === r ? "selected" : ""}>${labels[x.config.method]}・${x.capacity ? "制約あり" : "無制約"}</option>`).join("")}</select></label>` : ""}${renderCapacityComparison(results)}${r ? (r.capacity ? renderCapacityOutput(ctx, r, detail, direction, selected) : output(ctx, r)) : '<div class="route-empty">時間帯需要を用意し、営業区分を確認してから配分してください。需要のない都市属性に架空の人数は追加しません。</div>'}</div>`;
}
function start(ctx: UIContext, compare: boolean, compareCapacity = false) {
  ensure(ctx);
  validateAssignmentConfig(ctx.project.assignmentConfig!);
  if (!ctx.project.temporal)
    throw new Error("先に時間帯別ODを生成・設定してください");
  stop();
  error = "";
  results = [];
  sourceProject = ctx.project;
  runStamp = stamp(ctx);
  progress = "営業列車の索引を作成し、配分を計算しています…";
  const current = new Worker(
    new URL("./assignment-worker.ts", import.meta.url),
    { type: "module" },
  );
  worker = current;
  const config = structuredClone(ctx.project.assignmentConfig!);
  displayMethod =
    config.method + (config.capacityConstrained ? ":capacity" : "");
  current.onmessage = (event) => {
    if (worker !== current) return;
    const data = event.data;
    if (data.type === "progress") {
      progress = `${labels[data.method as "fastest" | "logit"]}：${data.done} / ${data.total} ${data.stage === "events" ? "乗降イベント" : "OD"}`;
      const el = document.querySelector("#assignment-progress");
      if (el) el.textContent = progress;
      return;
    }
    stop();
    if (data.type === "error") error = data.message;
    else {
      results = data.results;
      progress = "計算終了。需要と列車の乗降収支を検証しました";
    }
    ctx.render();
  };
  current.onerror = (event) => {
    if (worker !== current) return;
    stop();
    error = event.message || "計算Workerが停止しました";
    ctx.render();
  };
  current.postMessage({
    selections: [
      {
        datasetId: ctx.project.datasetId!,
        project: {
          ...ctx.project,
          analytics: undefined,
          temporal: undefined,
          temporalConfig: undefined,
        },
        timetableId: ctx.diaId,
        passengerOnly: true,
      },
    ],
    links: ctx.links.filter(
      (l) =>
        l.from.datasetId === ctx.project.datasetId &&
        l.to.datasetId === ctx.project.datasetId,
    ),
    input: ctx.project.temporal.slots.map((r) => ({
      ...r,
      datasetId: ctx.project.datasetId!,
    })),
    config,
    compare,
    compareCapacity,
  });
  ctx.save();
}
export function assignmentClick(button: HTMLElement, ctx: UIContext) {
  if (button.dataset.assignmentLoad) {
    selected = button.dataset.assignmentLoad;
    ctx.render();
    return true;
  }
  const action = button.dataset.assignmentAction;
  if (!action) return false;
  try {
    if (
      action === "run" ||
      action === "compare" ||
      action === "capacity-compare"
    )
      start(ctx, action === "compare", action === "capacity-compare");
    else if (action === "cancel") {
      stop();
      error = "計算を中止しました。途中結果は表示しません";
    } else if (action === "sample-demand") {
      ctx.project.temporal = generateTemporalDemand(
        ctx.project,
        ctx.project.temporalConfig ??
          defaultTemporalConfig(ctx.project.oud2?.serviceDayStart ?? 14400),
        ctx.project.costs,
      );
      ctx.save();
    } else {
      const r = display(ctx);
      if (!r) throw new Error("先に配分を計算してください");
      if (action === "capacity-events" || action === "capacity-states") {
        if (!r.capacity) throw new Error("定員制約の結果がありません");
        download(
          action + ".csv",
          action === "capacity-events"
            ? capacityEventsCsv(r)
            : capacityStatesCsv(r),
          "text/csv",
        );
        return true;
      }
      const exportResult = r.capacity ? { ...r, loads: r.capacity.loads } : r;
      const exports = {
        "trains-csv": ["train-loads.csv", trainLoadsCsv(exportResult)],
        "segments-csv": ["segment-loads.csv", segmentLoadsCsv(exportResult)],
        "allocations-csv": ["passenger-allocations.csv", allocationsCsv(r)],
        "unallocated-csv": ["unallocated-demand.csv", unallocatedCsv(r)],
      };
      const data = exports[action as keyof typeof exports];
      if (data) {
        download(data[0], data[1], "text/csv");
        return true;
      }
    }
  } catch (err) {
    stop();
    error = (err as Error).message;
  }
  ctx.render();
  return true;
}
export function assignmentChange(el: HTMLInputElement, ctx: UIContext) {
  try {
    ensure(ctx);
    if (el.id === "assignment-direction") {
      direction = el.value;
      ctx.render();
      return;
    }
    if (
      el.id === "assignment-result-method" ||
      el.id === "assignment-capacity-view"
    ) {
      displayMethod = el.value;
      ctx.render();
      return;
    }
    if (el.id === "assignment-dia") {
      const header = document.querySelector<HTMLSelectElement>("#diaId")!;
      header.value = el.value;
      header.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }
    if (el.type === "number" && (!el.value.trim() || !el.validity.valid))
      throw new Error("配分条件の数値を確認してください");
    const c = structuredClone(ctx.project.assignmentConfig!);
    if (el.dataset.choicePurpose)
      c.coefficients[el.dataset.choicePurpose as keyof typeof c.coefficients][
        el.dataset.choiceKey as "riding"
      ] = Number(el.value);
    else
      switch (el.id) {
        case "assignment-capacity":
          c.capacityConstrained = el.value === "on";
          break;
        case "assignment-unknown":
          c.unknownCapacityPolicy = el.value as "error" | "exclude";
          break;
        case "assignment-horizon":
          c.simulationEnd = Number(el.value) * 3600;
          break;
        case "assignment-start":
          c.start = Number(el.value) * 3600;
          break;
        case "assignment-end":
          c.end = Number(el.value) * 3600;
          break;
        case "assignment-method":
          c.method = el.value as AssignmentConfig["method"];
          break;
        case "assignment-transfers":
          c.maxTransfers = Number(el.value);
          break;
        case "assignment-minimum":
          c.minimumTransferSeconds = Number(el.value) * 60;
          break;
        case "assignment-wait":
          c.maxWaitSeconds = Number(el.value) * 60;
          break;
        case "assignment-duration":
          c.maxJourneySeconds = Number(el.value) * 60;
          break;
        case "assignment-choices":
          c.maxChoices = Number(el.value);
          break;
        case "assignment-integer":
          c.integer = el.value === "integer";
          break;
      }
    validateAssignmentConfig(c);
    stop();
    results = [];
    ctx.project.assignmentConfig = c;
    ctx.save();
    error = "";
  } catch (err) {
    error = (err as Error).message;
  }
  ctx.render();
}

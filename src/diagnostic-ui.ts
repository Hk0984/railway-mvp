import type { AssignmentResult } from "./assignment-model";
import { statesAt } from "./assignment-diagnostics";
import { escapeHtml as e, numberText as n } from "./ui-utils";
import { csv } from "./io";
const labels: Record<string, string> = {
  notStarted: "需要発生前",
  waiting: "駅で待機",
  inTransit: "乗車中",
  walking: "徒歩・乗換中",
  completed: "輸送完了",
  noPath: "経路なし",
  demand: "需要発生",
  arrival: "駅到着",
  ready: "乗車候補",
  "walk-start": "徒歩開始",
  "walk-end": "徒歩完了",
  alight: "降車",
  board: "乗車成功",
  split: "集団分割",
  denied: "定員不足・積み残し",
  reroute: "再探索",
  "initial-route": "初期経路",
  "route-selected": "再選択経路",
  "boarding-candidates": "同時刻候補",
  untransported: "未輸送確定",
};
let demand = "",
  station = "",
  train = "",
  page = 0,
  time = "",
  replacing = false;
export function diagnosticChange(el: HTMLInputElement, r: AssignmentResult) {
  if (!el.id.startsWith("diag-")) return false;
  if (replacing) return true;
  if (el.id === "diag-demand") demand = el.value;
  if (el.id === "diag-station") station = el.value;
  if (el.id === "diag-train") train = el.value;
  if (el.id === "diag-time") time = el.value;
  if (el.id === "diag-page") page = Number(el.value);
  else page = 0;
  replacing = true;
  try {
    const node = document.querySelector("#assignment-diagnostic");
    if (node?.isConnected) node.outerHTML = diagnosticView(r);
  } finally {
    replacing = false;
  }
  return true;
}
export function diagnosticCsv(r: AssignmentResult) {
  return csv([
    [
      "sequence",
      "timeSeconds",
      "kind",
      "packetId",
      "parentId",
      "cohortId",
      "demandIndex",
      "passengers",
      "datasetId",
      "stationId",
      "trainKey",
      "from",
      "to",
      "detail",
    ],
    ...(r.audit?.events ?? []).map((v) => [
      v.sequence,
      v.time,
      v.kind,
      v.packetId,
      v.parentId ?? "",
      v.cohortId,
      v.demandIndex,
      v.passengers,
      v.datasetId,
      v.stationId,
      v.trainKey ?? "",
      v.from,
      v.to,
      v.detail,
    ]),
  ]);
}
export function diagnosticView(r: AssignmentResult) {
  const a = r.audit;
  if (!a)
    return '<section class="panel"><h2>旅客追跡・人数収支</h2><p>同時刻一括方式・定員制約ありで実行すると診断できます。旧方式の結果にはログを生成しません。</p></section>';
  const filtered = a.events.filter(
    (v) =>
      (!demand || String(v.demandIndex) === demand) &&
      (!station || JSON.stringify([v.datasetId, v.stationId]) === station) &&
      (!train || v.trainKey === train || v.detail.includes(train)),
  );
  page = Math.min(page, Math.max(0, Math.ceil(filtered.length / 200) - 1));
  const at = statesAt(r, time === "" ? r.capacity!.horizon : Number(time));
  const stations = [
      ...new Map(
        a.events.map((v) => [
          JSON.stringify([v.datasetId, v.stationId]),
          v.datasetId + " / " + v.stationId,
        ]),
      ).entries(),
    ],
    loads = r.capacity!.loads;
  return `<section class="panel" id="assignment-diagnostic"><h2>旅客追跡・人数収支（推計）</h2><p>${e(a.rule)}</p><p>検査 ${a.checks}回 ／ 収支エラー ${a.errors.length}件。記録方式 ${a.mode === "full" ? "全件" : "概要（個別ログなし）"}。${a.snapshotIntervalNotice ? "概要の時点を間引いています。" : ""}</p><div class="route-options"><label>監査時刻（運行日秒）<input id="diag-time" type="number" min="0" value="${time || r.capacity!.horizon}"></label><label>ODレコード<select id="diag-demand"><option value="">全件</option>${r.input.map((d, i) => `<option value="${i}" ${demand === String(i) ? "selected" : ""}>#${i} ${e(d.datasetId + "/" + d.origin)} → ${e((d.destinationDatasetId ?? d.datasetId) + "/" + d.destination)} / ${e(d.purpose)}</option>`).join("")}</select></label><label>駅<select id="diag-station"><option value="">全駅</option>${stations.map(([id, text]) => `<option value="${e(id)}" ${station === id ? "selected" : ""}>${e(text)}</option>`).join("")}</select></label><label>列車<select id="diag-train"><option value="">全列車</option>${loads.map((l) => `<option value="${e(l.key)}" ${train === l.key ? "selected" : ""}>${e(l.datasetId + "/" + l.timetableId + "/" + l.trainId)}</option>`).join("")}</select></label></div><p>監査時点 ${at.time}秒：${Object.entries(
    at.states,
  )
    .map(([k, v]) => `${labels[k]} ${n(v)}人`)
    .join(
      " ／ ",
    )}。合計 ${n(Object.values(at.states).reduce((s, v) => s + v, 0))}人／対象需要 ${n(at.total)}人。</p><p class="muted">全件記録では任意時刻の状態を再構成します。概要では指定時刻以前の最新監査点です。経路なしは理由を記録し、未確認営業・不明定員・未登録連絡は既存の読込／配分警告と併せて確認してください。未登録連絡が経路不在の原因と確認できない場合は断定しません。</p><div class="actions"><button data-net-action="diagnostic-csv">診断CSV（全ログ）</button><button data-net-action="diagnostic-json">診断JSON</button></div><p>${Object.entries(
    a.counts,
  )
    .map(([k, v]) => `${labels[k] ?? e(k)} ${v}件`)
    .join(
      " ／ ",
    )}</p><label>ログページ<select id="diag-page">${Array.from({ length: Math.max(1, Math.ceil(filtered.length / 200)) }, (_, i) => `<option value="${i}" ${page === i ? "selected" : ""}>${i + 1}</option>`).join("")}</select>（該当 ${filtered.length}件・200件／ページ）</label><div class="table-wrap"><table><thead><tr><th>秒</th><th>イベント</th><th>集団／分割元</th><th>OD行・到着セル</th><th>人数</th><th>位置</th><th>状態</th><th>経路・理由</th></tr></thead><tbody>${filtered
    .slice(page * 200, (page + 1) * 200)
    .map(
      (v) =>
        `<tr><td>${n(v.time)}</td><td>${labels[v.kind] ?? e(v.kind)}</td><td>${v.packetId}／${v.parentId ?? "—"}</td><td>#${v.demandIndex}・${e(v.cohortId)}</td><td>${n(v.passengers)}</td><td>${e(v.datasetId + "/" + v.stationId)}</td><td>${labels[v.from]} → ${labels[v.to]}</td><td>${e(v.detail)}</td></tr>`,
    )
    .join("")}</tbody></table></div></section>`;
}

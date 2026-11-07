import { clock } from "./analysis";
import { csv } from "./io";
import { escapeHtml as e, numberText as n, type UIContext } from "./ui-utils";
import type { AssignmentResult, TrainLoad } from "./assignment-model";
export function renderCapacityControls(ctx: UIContext) {
  const c = ctx.project.assignmentConfig!;
  return `<div class="route-options"><label>輸送定員制約<select id="assignment-capacity"><option value="off" ${!c.capacityConstrained ? "selected" : ""}>無制約（0.3互換）</option><option value="on" ${c.capacityConstrained ? "selected" : ""}>制約あり・積み残し再探索</option></select></label><label>定員不明便<select id="assignment-unknown"><option value="error" ${(c.unknownCapacityPolicy ?? "error") === "error" ? "selected" : ""}>計算を止めて設定を確認</option><option value="exclude" ${c.unknownCapacityPolicy === "exclude" ? "selected" : ""}>不明便を明示除外</option></select></label><label>輸送計算の終了（時）<input id="assignment-horizon" type="number" min="${c.end / 3600}" step="any" value="${(c.simulationEnd ?? c.end + c.maxJourneySeconds) / 3600}"></label></div><p class="muted">制約ありでは輸送定員を使用し、降車→乗車の順で処理します。座席定員のみの便は定員不明として扱います。FIFOは集計到着枠の代表時刻に基づき、徒歩連絡を含む容量配分は未対応です。</p>`;
}
export function stationCapacityMetrics(r: AssignmentResult) {
  const o = r.capacity!;
  const map = new Map<
      string,
      {
        stationId: string;
        hour: number;
        desired: number;
        boarded: number;
        denied: number;
        reassigned: number;
        extra: number;
        peakWaiting: number;
      }
    >(),
    waiting = new Map<string, number>();
  const flows: {
    time: number;
    stationId: string;
    amount: number;
    kind: string;
    reassigned: number;
    extra: number;
  }[] = [];
  const cohorts = new Map(r.cohorts.map((c) => [c.id, c]));
  for (const a of r.allocations) {
    const c = cohorts.get(a.cohortId)!,
      d = r.input[c.demandIndex];
    if (c.arrival <= o.horizon)
      flows.push({
        time: c.arrival,
        stationId: d.origin,
        amount: a.passengers,
        kind: "ready",
        reassigned: 0,
        extra: 0,
      });
  }
  for (const u of r.unallocated) {
    const c = cohorts.get(u.cohortId)!,
      d = r.input[c.demandIndex];
    if (c.arrival <= o.horizon)
      flows.push({
        time: c.arrival,
        stationId: d.origin,
        amount: u.passengers,
        kind: "unreachable",
        reassigned: 0,
        extra: 0,
      });
  }
  for (const ev of o.events) {
    if (ev.type === "alight") {
      if (ev.stationId !== ev.destination)
        flows.push({
          time: ev.time,
          stationId: ev.stationId,
          amount: ev.passengers,
          kind: "ready",
          reassigned: 0,
          extra: 0,
        });
    } else
      flows.push({
        time: ev.time,
        stationId: ev.stationId,
        amount: ev.passengers,
        kind: ev.type,
        reassigned: ev.reassigned,
        extra: ev.additionalWaitPersonSeconds,
      });
  }
  flows.sort((a, b) => a.time - b.time || (a.kind === "ready" ? -1 : 1));
  for (const f of flows) {
    const hour = Math.floor(f.time / 3600),
      key = JSON.stringify([f.stationId, hour]),
      row = map.get(key) ?? {
        stationId: f.stationId,
        hour,
        desired: 0,
        boarded: 0,
        denied: 0,
        reassigned: 0,
        extra: 0,
        peakWaiting: waiting.get(f.stationId) ?? 0,
      };
    let w = waiting.get(f.stationId) ?? 0;
    if (f.kind === "ready") {
      row.desired += f.amount;
      w += f.amount;
    }
    if (f.kind === "unreachable") row.desired += f.amount;
    if (f.kind === "board") {
      row.boarded += f.amount;
      w -= f.amount;
      row.reassigned += f.reassigned;
      row.extra += f.extra;
    }
    if (f.kind === "denied") row.denied += f.amount;
    waiting.set(f.stationId, w);
    row.peakWaiting = Math.max(row.peakWaiting, w);
    map.set(key, row);
  }
  return [...map.values()];
}
export function capacityEventsCsv(r: AssignmentResult) {
  const c = new Map(r.cohorts.map((c) => [c.id, c]));
  return csv([
    [
      "type",
      "timeSeconds",
      "stationId",
      "trainKey",
      "cohortId",
      "destination",
      "purpose",
      "passengers",
      "reassignedBoardingEvents",
      "extraWaitPersonSeconds",
      "source",
    ],
    ...r.capacity!.events.map((v) => [
      v.type,
      v.time,
      v.stationId,
      v.trainKey,
      v.cohortId,
      v.destination,
      v.purpose,
      v.passengers,
      v.reassigned,
      v.additionalWaitPersonSeconds,
      r.input[c.get(v.cohortId)!.demandIndex].source,
    ]),
  ]);
}
export function capacityStatesCsv(r: AssignmentResult) {
  return csv([
    [
      "packetId",
      "cohortId",
      "state",
      "stationId",
      "destination",
      "passengers",
      "denials",
      "reason",
    ],
    ...r.capacity!.packets.map((p) => [
      p.id,
      p.cohortId,
      p.state,
      p.stationId,
      p.destination,
      p.passengers,
      p.denials,
      p.reason ?? "",
    ]),
  ]);
}
export function renderQueueCharts(r: AssignmentResult) {
  const hours = new Map<number, number>();
  for (const e of r.capacity!.events)
    if (e.type === "denied") {
      const h = Math.floor(e.time / 3600);
      hours.set(h, (hours.get(h) ?? 0) + e.passengers);
    }
  const peak = Math.max(1, ...hours.values());
  return `<section class="panel"><h2>時間帯別の積み残し（推計・延べ）</h2><div class="concentration-bars">${
    [...hours]
      .sort((a, b) => a[0] - b[0])
      .map(
        ([h, amount]) =>
          `<div><span>${h}:00</span><i style="width:${(amount / peak) * 100}%"></i><b>${n(amount)}人回</b></div>`,
      )
      .join("") || "積み残しはありません"
  }</div></section>`;
}
export function renderCapacityComparison(results: AssignmentResult[]) {
  const a = results.find((r) => !r.capacity),
    b = results.find((r) => r.capacity);
  if (!a || !b) return "";
  const t = b.capacity!.totals;
  const rows = [
    ["配分済み／輸送完了", a.totals.assigned, t.completed],
    [
      "未配分／未輸送（待機・途中・経路なし）",
      a.totals.unassigned,
      t.waiting + t.inTransit + t.noPath + (t.walking ?? 0),
    ],
    [
      "最大車内人数",
      Math.max(0, ...a.loads.map((l) => l.peakLoad)),
      Math.max(0, ...b.capacity!.loads.map((l) => l.peakLoad)),
    ],
  ];
  const max = Math.max(
    1,
    ...a.loads.map((l) => Math.max(l.peakLoad, l.capacity ?? 0)),
  );
  return `<section class="panel" id="capacity-comparison"><h2>同じ需要の定員制約あり／なし（推計）</h2><div class="table-wrap"><table><thead><tr><th>指標</th><th>無制約</th><th>制約あり</th></tr></thead><tbody>${rows.map(([label, x, y]) => `<tr><td>${label}</td><td>${n(x as number)}</td><td>${n(y as number)}</td></tr>`).join("")}</tbody></table></div><h3>列車別の最大断面需要と設定輸送定員</h3><p class="muted">緑＝無制約配分の最大車内人数、橙＝設定輸送定員。延べ乗車は途中の空席再利用を含むため定員とは直接比較しません。</p><div class="concentration-bars">${a.loads
    .filter((l) => l.peakLoad > 0)
    .slice(0, 15)
    .map(
      (l) =>
        `<div><span>${e(l.trainNumber || l.trainId)} 需要</span><i style="width:${(l.peakLoad / max) * 100}%"></i><b>${n(l.peakLoad)}</b></div><div><span>輸送定員</span><i style="width:${((l.capacity ?? 0) / max) * 100}%;background:#c6843a"></i><b>${l.capacity === null ? "不明" : n(l.capacity)}</b></div>`,
    )
    .join("")}</div></section>`;
}
export function renderCapacityOutput(
  ctx: UIContext,
  r: AssignmentResult,
  detail: (ctx: UIContext, l: TrainLoad) => string,
  direction: string,
  selectedKey = "",
) {
  const o = r.capacity!,
    t = o.totals;
  const name = (id: string) =>
    ctx.project.stations.find((s) => s.id === id)?.name ?? id;
  const hasWalking = r.capacity!.packets.some((p) =>
    p.walks?.some((w) => !w.access),
  );
  const rows = hasWalking ? [] : stationCapacityMetrics(r);
  const loads = o.loads
    .filter((l) => !direction || l.direction === direction)
    .sort((a, b) => b.peakLoad - a.peakLoad);
  const picked =
    loads.find((l) => l.key === selectedKey) ??
    loads.find((l) => l.peakLoad > 0) ??
    loads[0];
  return `<section id="capacity-result" class="panel"><h2>定員制約ありの輸送結果（推計）</h2><p class="notice">集計終端 ${clock(o.horizon)}。元の予定旅程をそのまま乗車実績とは扱いません。乗車できなかった部分だけを再探索します。積み残し実人数と、同じ旅客の再発を含む延べ回数を区別します。</p><div class="metrics">${[
    ["目的地へ輸送完了", t.completed],
    ["輸送途中", t.inTransit],
    ["徒歩・アクセス中", t.walking ?? 0],
    ["駅で待機", t.waiting],
    ["経路なし", t.noPath],
    ["積み残し経験人数", t.deniedUnique],
    ["後続便乗車（延べ）", t.reassigned],
    ["対象需要", t.selected],
    [
      "人数収支差",
      t.selected -
        t.completed -
        t.inTransit -
        t.waiting -
        t.noPath -
        (t.walking ?? 0),
    ],
  ]
    .map(
      ([label, v]) =>
        `<article class="metric"><span>${label}</span><strong>${n(v as number)}<small>人</small></strong></article>`,
    )
    .join(
      "",
    )}</div><p>積み残し延べ ${n(t.deniedEvents)}人回 ／ 後続便乗車までの総追加待ち ${n(t.additionalWaitPersonSeconds / 60)}人分。終了時点の待機者の未完了待ちはこの確定値に含めません。</p><div class="actions"><button data-assignment-action="trains-csv">実乗降・列車CSV</button><button data-assignment-action="segments-csv">実区間CSV</button><button data-assignment-action="capacity-events">乗降・積み残しCSV</button><button data-assignment-action="capacity-states">最終旅客状態CSV</button></div><div class="table-wrap"><table><thead><tr><th>列車</th><th>乗車</th><th>降車</th><th>最大車内</th><th>最大混雑区間</th><th>定員</th><th>最大混雑率</th><th>延べ積み残し</th><th>後続便乗車</th></tr></thead><tbody>${loads.map((l) => `<tr><td><button data-assignment-load="${e(l.key)}">${e(l.trainNumber || l.trainId)}</button></td><td>${n(l.totalBoardings)}</td><td>${n(l.totalAlightings)}</td><td>${n(l.peakLoad)}</td><td>${l.peakSegments.map((i) => e(name(l.stops[i].stationId)) + " → " + e(name(l.stops[i + 1].stationId))).join("<br>") || "—"}</td><td>${n(l.capacity ?? 0)}</td><td>${l.peakOccupancy === null ? "算出不可" : n(l.peakOccupancy * 100) + "%"}</td><td>${n(o.events.filter((e) => e.trainKey === l.key && e.type === "denied").reduce((s, e) => s + e.passengers, 0))}</td><td>${n(o.events.filter((e) => e.trainKey === l.key).reduce((s, e) => s + e.reassigned, 0))}</td></tr>`).join("")}</tbody></table></div><h3>列車別の最大混雑率</h3><div class="concentration-bars">${loads
    .filter((l) => l.peakLoad > 0)
    .slice(0, 15)
    .map(
      (l) =>
        `<div><span>${e(l.trainNumber || l.trainId)}</span><i style="width:${(l.peakOccupancy ?? 0) * 100}%"></i><b>${n((l.peakOccupancy ?? 0) * 100)}%</b></div>`,
    )
    .join(
      "",
    )}</div><h3>駅・時間帯別の乗車と積み残し</h3>${hasWalking ? '<p class="notice">徒歩を含む駅別の最大待機表はこの旧画面では未対応です。統合配分画面の旅客状態とOD内訳を確認してください。</p>' : ""}<div class="table-wrap"><table><thead><tr><th>駅</th><th>時間</th><th>乗車希望</th><th>実際の乗車</th><th>積み残し（延べ）</th><th>平均追加待ち</th><th>最大待機</th></tr></thead><tbody>${rows.map((s) => `<tr><td>${e(name(s.stationId))}</td><td>${s.hour}:00</td><td>${n(s.desired)}</td><td>${n(s.boarded)}</td><td>${n(s.denied)}</td><td>${s.reassigned ? n(s.extra / s.reassigned / 60) + "分" : "—"}</td><td>${n(s.peakWaiting)}</td></tr>`).join("")}</tbody></table></div><p class="muted">最大待機は到着枠代表時刻での駅別在庫推計。後続便への再配分人数・積み残し回数は乗車イベントです。輸送途中は終着後0に補正せず車内残数として保存します。計算 ${n(o.milliseconds / 1000, 2)}秒。</p><details><summary>警告 ${o.warnings.length}件</summary><ul>${o.warnings.map((w) => `<li>${e(w)}</li>`).join("")}</ul></details></section>${renderQueueCharts(r)}${picked ? detail(ctx, picked) : ""}`;
}

import type { AssignmentResult } from "./assignment-model";
import { passengerFlows, flowSummary } from "./flow-analysis";
import { escapeHtml as e, numberText as n } from "./ui-utils";
export function precisionMetrics(r: AssignmentResult) {
  const f = passengerFlows(r),
    s = flowSummary(f),
    ls = r.capacity?.loads ?? r.loads;
  return {
    completed: s.completed,
    untransported: s.untransported,
    meanWaitMinutes:
      s.meanWaitingSeconds === null ? null : s.meanWaitingSeconds / 60,
    meanTravelMinutes:
      s.meanTravelSeconds === null ? null : s.meanTravelSeconds / 60,
    peakLoad: Math.max(0, ...ls.map((l) => l.peakLoad)),
    peakRate: ls.some((l) => l.peakOccupancy !== null)
      ? Math.max(
          ...ls.flatMap((l) =>
            l.peakOccupancy === null ? [] : [l.peakOccupancy],
          ),
        )
      : null,
    denied: r.capacity?.totals.deniedUnique ?? null,
    additionalWait: r.capacity
      ? r.capacity.totals.additionalWaitPersonSeconds / 60
      : null,
    lastArrival: f.some((f) => f.state === "completed")
      ? Math.max(
          ...f
            .filter((f) => f.state === "completed")
            .map((f) => f.legs.at(-1)!.arrival),
        )
      : null,
  };
}
export function precisionView(rs: AssignmentResult[], labels: string[]) {
  if (rs.length < 2) return "";
  const metrics = rs.map(precisionMetrics),
    keys = Object.keys(metrics[0]) as (keyof (typeof metrics)[0])[],
    range = keys.map((key) => {
      const values = metrics.flatMap((m) => (m[key] === null ? [] : [m[key]!]));
      return {
        key,
        min: values.length ? Math.min(...values) : null,
        max: values.length ? Math.max(...values) : null,
      };
    });
  return `<section class="panel" id="precision-comparison"><h2>設定したシナリオの変動幅</h2><p class="notice">統計的な信頼区間ではありません。時刻表の秒を補完せず、旅客到着・締切・選択・容量の仮定を変えています。平均時間は完了者のみ。未輸送人数を併記します。</p><div class="table-wrap"><table><thead><tr><th>条件</th><th>完了／未輸送</th><th>平均待ち分</th><th>平均旅行分</th><th>最大車内／混雑率</th><th>積み残し</th><th>追加待ち人分</th><th>最終着秒</th></tr></thead><tbody>${metrics.map((m, i) => `<tr><td>${e(labels[i] ?? String(i + 1))}</td><td>${n(m.completed)}／${n(m.untransported)}</td><td>${n(m.meanWaitMinutes)}</td><td>${n(m.meanTravelMinutes)}</td><td>${n(m.peakLoad)}／${m.peakRate === null ? "不明" : n(m.peakRate * 100) + "%"}</td><td>${n(m.denied)}</td><td>${n(m.additionalWait)}</td><td>${n(m.lastArrival)}</td></tr>`).join("")}</tbody></table></div><details><summary>全指標の範囲・条件</summary><pre>${e(JSON.stringify({ range, conditions: rs.map((r) => r.config) }, null, 2))}</pre></details><h3>基準との差がある列車（最大断面）</h3><div class="table-wrap"><table><thead><tr><th>条件・列車</th><th>基準人数</th><th>比較人数</th><th>差分</th></tr></thead><tbody>${rs
    .slice(1)
    .flatMap((r, i) => {
      const before = new Map(
        (rs[0].capacity?.loads ?? rs[0].loads).map((l) => [l.key, l]),
      );
      return (r.capacity?.loads ?? r.loads).flatMap((l) => {
        const a = before.get(l.key)?.peakLoad ?? 0;
        return Math.abs(l.peakLoad - a) > 1e-6
          ? [
              `<tr><td>${e(labels[i + 1] ?? String(i + 2))} ／ ${e(l.key)}</td><td>${n(a)}</td><td>${n(l.peakLoad)}</td><td>${n(l.peakLoad - a)}</td></tr>`,
            ]
          : [];
      });
    })
    .slice(0, 200)
    .join(
      "",
    )}</tbody></table></div><p class="muted">先頭200差分。全条件・列車・OD行・到着セルと時刻は分析JSONで出力できます。</p></section>`;
}

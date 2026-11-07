import { consistencyView } from "./comparison-view";
import type { CalibrationRun } from "./calibration";
import type { SensitivityRow } from "./sensitivity";
import { escapeHtml as e, numberText as n } from "./ui-utils";
import type { ComparisonResult } from "./comparison";
export function benefitView(r: ComparisonResult) {
  const b = r.benefits;
  if (!b) return "";
  return `${consistencyView(r)}<section id="passenger-benefits"><h3>固定需要の利用者時間比較</h3><p class="notice">${e(b.reason)}</p>${b.comparable ? `<p>共通輸送 ${n(b.common)}人 ／ 比較対象外 ${n(b.excluded)}人。改善 ${n(b.improved)}人、悪化 ${n(b.worsened)}人、不変 ${n(b.unchanged)}人。</p><p>総旅行時間差（後−前）${n(b.travelChangePersonSeconds / 60)}人分、1人平均差 ${b.common ? n(b.travelChangePersonSeconds / b.common / 60) + "分" : "未算出"}、総待ち時間差 ${n(b.waitingChangePersonSeconds / 60)}人分。金銭換算はしません。</p><div class="table-wrap"><table><thead><tr><th>OD・目的</th><th>共通輸送人数</th><th>総時間差</th><th>対象外</th></tr></thead><tbody>${b.odRows.map((v) => `<tr><td>${e(v.origin.datasetId + "/" + v.origin.stationId)} → ${e(v.destination.datasetId + "/" + v.destination.stationId)} / ${e(v.purpose)}</td><td>${n(v.passengers)}</td><td>${n(v.changePersonSeconds / 60)}人分</td><td>${n(v.excluded)}人</td></tr>`).join("")}</tbody></table></div><div class="table-wrap"><table><thead><tr><th>基準側の駅到着時台</th><th>共通人数</th><th>総時間差</th></tr></thead><tbody>${b.rows.map((v) => `<tr><td>${v.hour}:00</td><td>${n(v.passengers)}</td><td>${n(v.changePersonSeconds / 60)}人分</td></tr>`).join("")}</tbody></table></div>` : ""}</section>`;
}
export function validationView(r: CalibrationRun) {
  const rows = r.after.rows.filter((v) => v.role === "validation"),
    max = Math.max(1, ...rows.flatMap((v) => [v.observed, v.estimated])),
    mean = rows.length
      ? rows.reduce((s, v) => s + v.error, 0) / rows.length
      : null;
  return `<section id="independent-validation"><h3>独立検証用データの散布図</h3><p>対象期間 ${e(r.period)} ／ 検証 ${rows.length}件 ／ 平均誤差 ${n(mean)}人。学習用データを点に含めません。</p>${rows.length ? `<svg viewBox="0 0 460 300" role="img" aria-label="観測人数と推計人数の散布図" style="width:100%;max-width:600px"><path d="M45 10 V255 H445 M45 255 L430 20" fill="none" stroke="#b6c9c2"/>${rows.map((v) => `<circle cx="${45 + (v.observed / max) * 375}" cy="${255 - (v.estimated / max) * 235}" r="5" fill="#087f71"><title>${e(v.id)} 観測${n(v.observed)} / 推計${n(v.estimated)}</title></circle>`).join("")}<text x="165" y="290">観測人数（人）</text><text x="2" y="18">推計人数</text></svg>` : '<p class="muted">検証用の観測がないため散布図は未算出です。</p>'}<div class="table-wrap"><table><thead><tr><th>駅・OD / 条件</th><th>誤差人数</th><th>過大・過小</th></tr></thead><tbody>${rows
    .map((v) => {
      const o = r.observationSnapshot?.find((o) => o.id === v.id);
      return `<tr><td>${o ? e([o.datasetId, o.stationId || o.origin + " → " + o.destination, o.dayGroup, o.startSeconds === undefined ? "時間条件なし" : o.startSeconds + "–" + o.endSeconds + "秒"].filter(Boolean).join(" ／ ")) : e(v.id) + "（過去の対応情報なし）"}</td><td>${n(v.error)}</td><td>${v.error > 0 ? "過大" : v.error < 0 ? "過小" : "一致"}</td></tr>`;
    })
    .join(
      "",
    )}</tbody></table></div><p class="muted">時刻条件のない観測を時間帯別誤差へ分解しません。観測条件が異なる場合は期間ラベルを分けます。列車断面の実測比較はOD校正と別に実施します。</p></section>`;
}
export function sensitivityView(rows: SensitivityRow[]) {
  return `<section class="panel" id="sensitivity-result"><h2>自動生成モデルの感度（推計）</h2><p class="notice">固定保存ODを変更せず、都市属性と固定費用から各条件の需要を再生成しています。β・発生係数・利用率の変更は需要も変わるため、固定需要の利用者便益とは区別します。実測データがない場合は感度分析だけで、精度が検証された意味ではありません。</p><div class="table-wrap"><table><thead><tr><th>条件</th><th>対象需要</th><th>完了</th><th>未輸送</th><th>最大混雑率</th><th>積み残し経験</th><th>平均所要</th></tr></thead><tbody>${rows.map((v) => `<tr><td>${e(v.label)}</td>${v.error ? `<td colspan="6">未算出：${e(v.error)}</td>` : `<td>${n(v.demand)}</td><td>${n(v.completed)}</td><td>${n(v.untransported)}</td><td>${v.peakOccupancy === null ? "未算出" : n(v.peakOccupancy * 100) + "%"}</td><td>${v.denied === null ? "未算出" : n(v.denied)}</td><td>${n(v.meanTravelMinutes)}分</td>`}</tr>`).join("")}</tbody></table></div><p class="muted">基準と全変種で同じ配分方式を使用。最速方式では選択係数の主効果は同着候補の選択です。既知の輸送定員だけを変更し、不明定員を補完しません。係数・定員の感度だけで因果関係を断定しません。</p><button data-lab-action="sensitivity-json">感度結果・係数JSON</button></section>`;
}

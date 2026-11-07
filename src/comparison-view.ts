import type { ComparisonResult } from "./comparison";
import { escapeHtml as e, numberText as n } from "./ui-utils";
export function consistencyView(r: ComparisonResult) {
  const c = r.consistency;
  if (!c) return "";
  const facts = r.facts;
  return `<section id="comparison-consistency"><h3>比較条件・完了率の監査</h3><p class="notice">${e(c.warning)}</p><p>輸送完了率 A ${c.completionBefore === null ? "未算出" : n(c.completionBefore * 100) + "%"} ／ B ${c.completionAfter === null ? "未算出" : n(c.completionAfter * 100) + "%"}。同一需要 ${c.sameDemand ? "確認済み" : "不一致"}。</p><div class="table-wrap"><table><thead><tr><th>条件</th><th>照合</th><th>A</th><th>B</th></tr></thead><tbody>${c.conditions.map((v) => `<tr><td>${e(v.field)}</td><td>${!v.available ? "情報不足" : v.equal ? "一致" : "差異あり・条件を確認"}</td><td>${e(JSON.stringify(v.before) ?? "保存情報なし")}</td><td>${e(JSON.stringify(v.after) ?? "保存情報なし")}</td></tr>`).join("")}</tbody></table></div>${
    facts
      ? `<p>${e(facts.note)}</p><h4>差の大きいOD・時台</h4><div class="table-wrap"><table><thead><tr><th>OD・目的・時台</th><th>完了差</th><th>未輸送差</th><th>平均待ち差</th></tr></thead><tbody>${facts.od
          .slice(0, 100)
          .map(
            (v) =>
              `<tr><td>${e(v.key)}</td><td>${n(v.completedChange)}人</td><td>${n(v.untransportedChange)}人</td><td>${v.meanWaitChangeSeconds === null ? "比較不能" : n(v.meanWaitChangeSeconds / 60) + "分"}</td></tr>`,
          )
          .join(
            "",
          )}</tbody></table></div><h4>駅・時台の積み残し差（人回）</h4><div class="table-wrap"><table><tbody>${facts.stations
          .slice(0, 100)
          .map(
            (v) =>
              `<tr><td>${e(v.key)}</td><td>A ${n(v.before)}</td><td>B ${n(v.after)}</td><td>差 ${n(v.difference)}</td></tr>`,
          )
          .join(
            "",
          )}</tbody></table></div><h4>列車の最大断面差</h4><div class="table-wrap"><table><tbody>${facts.trains
          .slice(0, 100)
          .map(
            (v) =>
              `<tr><td>${e(v.key)}</td><td>A ${n(v.before)}</td><td>B ${n(v.after)}</td><td>差 ${n(v.difference)}</td></tr>`,
          )
          .join("")}</tbody></table></div>`
      : ""
  }</section>`;
}

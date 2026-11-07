import { analytics, buildScenario, projectForScenario } from "./scenarios";
import {
  importObservations,
  observationTemplate,
  calibrateDemand,
  evaluateObservations,
  evaluateTrainObservations,
  type CalibrationRun,
} from "./calibration";
import {
  resplitTemporal,
  generateTemporalDemand,
  defaultTemporalConfig,
} from "./temporal-demand";
import { defaultAssignmentConfig } from "./assignment-model";
import { currentAssignmentResult } from "./assignment-ui";
import {
  validationView,
  sensitivityView,
  benefitView,
} from "./validation-view";
import type { SensitivityRow } from "./sensitivity";
import { workspace } from "./workspace";
import { currentNetworkResult } from "./network-ui";
import { download, csv } from "./io";
import { validateProject } from "./model";
import type { ComparisonResult } from "./comparison";
import { escapeHtml as e, numberText as n, type UIContext } from "./ui-utils";
let active = "",
  error = "",
  notice = "",
  worker: Worker | null = null,
  comparison: ComparisonResult | null = null,
  sourceStamp = "";
let sensitivities: SensitivityRow[] = [];
const val = (id: string) =>
  (document.getElementById(id) as HTMLInputElement)?.value ?? "";
const checked = (id: string) =>
  (document.getElementById(id) as HTMLInputElement)?.checked ?? false;
function scenarioCapacity() {
  const text = val("scenario-capacity").trim();
  if (!text) return undefined;
  const value = Number(text);
  if (!Number.isInteger(value) || value <= 0)
    throw new Error("シナリオ輸送定員は正の整数か空欄にしてください");
  return {
    value,
    kind: "transport" as const,
    basis: "利用者のシナリオ比較用輸送定員",
  };
}
let form: Record<string, string | boolean> = {};
export function restoreAnalyticsForm() {
  for (const [id, value] of Object.entries(form)) {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (el) {
      if (typeof value === "boolean") el.checked = value;
      else el.value = value;
    }
  }
  const d = document.getElementById(
    "compare-destination",
  ) as HTMLSelectElement | null;
  if (d && !form["compare-destination"]) d.selectedIndex = d.options.length - 1;
  const after = document.getElementById(
    "compare-after",
  ) as HTMLSelectElement | null;
  if (after && !form["compare-after"] && after.options.length > 1)
    after.selectedIndex = 1;
}
const signature = (ctx: UIContext) =>
  JSON.stringify([
    ctx.project.datasetId,
    ctx.project.stations,
    ctx.project.costs,
    ctx.project.temporalConfig,
    ctx.project.timetables,
    ctx.project.serviceClasses,
    ctx.project.capacitySettings,
    ctx.project.typeCapacities,
    ctx.project.assignmentConfig,
    ctx.project.temporal,
    ctx.project.analytics?.scenarios,
  ]);
function comparisonHtml(r: ComparisonResult) {
  return `<section class="panel" id="comparison-result"><h2>${r.fixedDemand ? "固定需要のダイヤ比較" : "同じダイヤの需要シナリオ比較"}（推計）</h2><p>${e(r.assumptions)}</p><div class="table-wrap"><table><thead><tr><th>指標</th><th>前／A</th><th>後／B</th><th>差分（B−A）</th><th>単位</th></tr></thead><tbody>${r.rows.map((v) => `<tr><td>${e(v.label)}</td><td>${v.before === null ? "未算出" : n(v.before)}</td><td>${v.after === null ? "未算出" : n(v.after)}</td><td>${v.difference === null ? "—" : n(v.difference)}</td><td>${e(v.unit)}</td></tr>`).join("")}</tbody></table></div>${benefitView(r)}<button data-lab-action="comparison-json">比較結果・条件JSON</button><button data-lab-action="benefits-csv">OD別利用者時間CSV</button><button data-lab-action="comparison-csv">比較CSV</button></section>`;
}
function calibrationHtml(ctx: UIContext, r: CalibrationRun) {
  const observations = analytics(ctx.project).observations.filter(
    (o) => o.period === r.period && !r.excluded.some((x) => x.id === o.id),
  );
  return `<section class="panel" id="calibration-result"><h2>校正結果：${e(r.method)}</h2><p>${r.converged ? "収束／制約なし" : "未収束"}・反復 ${r.iterations}回・対象期間 ${e(r.period)}。ODは観測そのものではなく校正後の推計です。</p><div class="table-wrap"><table><thead><tr><th>用途</th><th>使用件数</th><th>校正前MAE</th><th>校正後MAE</th><th>校正前RMSE</th><th>校正後RMSE</th></tr></thead><tbody>${(
    ["fit", "validation"] as const
  )
    .map((role) => {
      const before = r.before.rows.filter((x) => x.role === role),
        after = r.after.rows.filter((x) => x.role === role);
      const metric = (rows: typeof before, square: boolean) =>
        rows.length
          ? square
            ? Math.sqrt(
                rows.reduce((s, x) => s + x.error * x.error, 0) / rows.length,
              )
            : rows.reduce((s, x) => s + Math.abs(x.error), 0) / rows.length
          : null;
      return `<tr><td>${role === "fit" ? "学習" : "検証（学習不使用）"}</td><td>${after.length}</td>${[metric(before, false), metric(after, false), metric(before, true), metric(after, true)].map((v) => `<td>${v === null ? "未算出" : n(v)}</td>`).join("")}</tr>`;
    })
    .join(
      "",
    )}</tbody></table></div><div class="table-wrap"><table><thead><tr><th>ID / 用途</th><th>観測人数</th><th>推計人数</th><th>誤差人数</th><th>相対誤差</th></tr></thead><tbody>${r.after.rows.map((v) => `<tr><td>${e(v.id)} / ${e(v.role)}</td><td>${n(v.observed)}</td><td>${n(v.estimated)}</td><td>${n(v.error)}</td><td>${v.relativeError === null ? "基準0のため未算出" : n(v.relativeError * 100) + "%"}</td></tr>`).join("")}</tbody></table></div>${validationView(r)}<details><summary>係数・対象駅・除外理由</summary><pre>${e(JSON.stringify({ seed: r.seedCoefficients, selected: r.selectedCoefficients, targetStations: r.targetStations, excluded: r.excluded }, null, 2))}</pre></details><button data-lab-action="apply-calibration">校正した往路ODを時間帯モデルに適用</button><p class="muted">時間分布・帰路率は現在の明示設定で再配分します。観測CSVは上書きしません。</p></section>`;
}
export function renderAnalytics(ctx: UIContext) {
  const p = ctx.project;
  if (active !== p.datasetId) {
    sensitivities = [];
    form = {};
    worker?.terminate();
    worker = null;
    comparison = null;
    active = p.datasetId!;
    error = "";
    notice = "";
  }
  if ((comparison || sensitivities.length) && sourceStamp !== signature(ctx)) {
    sensitivities = [];
    comparison = null;
    notice = "入力条件が変わったため比較結果を無効化しました";
  }
  const a = analytics(p),
    last = a.calibrations.at(-1),
    options = p.timetables
      .map((d) => `<option value="${e(d.id)}">${e(d.name)}</option>`)
      .join(""),
    stations = p.stations
      .map(
        (s) => `<option value="${e(s.id)}">${e(s.name)}［${e(s.id)}］</option>`,
      )
      .join("");
  return `<div id="analytics-page"><p class="notice">観測値・設定値・推計結果を区別します。CSVは駅IDで照合し、異なる観測期間を混ぜません。これらの処理はブラウザ内のみで実行します。</p>${error ? `<p class="notice" role="alert">${e(error)}</p>` : ""}<p role="status" id="lab-status">${e(notice)}</p><section class="panel"><h2>実測データとOD需要校正</h2><div class="actions"><button data-lab-action="template-v05">曜日・時間条件付きCSV</button><button data-lab-action="template">観測CSVテンプレート</button><label class="file-button">実測CSVを置換読込<input type="file" id="observation-file" accept=".csv"></label></div><p>${a.observations.length}件の観測データ。kind＝boarding / alighting / od / load、role＝fit / validation。期間ラベルは完全一致で選択します。</p><label>観測期間<input id="lab-period" list="observation-periods" value="${e(a.observations[0]?.period ?? "")}"><datalist id="observation-periods">${[...new Set(a.observations.map((o) => o.period))].map((v) => `<option value="${e(v)}"></option>`).join("")}</datalist></label><label><input type="checkbox" id="lab-trip-ends"> 駅乗降人数を往路ODの発生・集中人数として使えることを確認した</label><label><input type="checkbox" id="lab-fit-coefficients"> fit用ODがある場合にβ・雇用吸引係数倍率を有界格子探索する</label><p class="muted">通常の駅乗車人員には乗換・帰路が含まれるため、そのままOD発生量と同一視できません。未確認なら駅別観測は除外します。列車断面実測はOD校正に使用しません。目的情報のない観測は全目的合計の往路として扱います。</p><details><summary>観測データのID・期間・出典を確認</summary><pre>${e(JSON.stringify(a.observations, null, 2))}</pre></details><label>配分結果の参照元<select id="lab-load-source"><option value="current">現在のプロジェクトの配分</option><option value="integrated">統合旅客配分</option></select></label><label><input type="checkbox" id="lab-load-aligned"> 観測期間・対象旅客集団が輸送計算の対象と一致することを確認した</label><button data-lab-action="load-validate">直近の配分と列車断面実測を比較</button><button data-lab-action="calibrate">現在の往路ODを校正</button></section>${last ? calibrationHtml(ctx, last) : ""}<section class="panel"><h2>需要モデル・シナリオの保存</h2><div class="route-options"><label>シナリオ名<input id="scenario-name" value="需要条件 ${a.scenarios.length + 1}"></label><label>モデル<select id="scenario-mode"><option value="automatic">自動生成</option><option value="observed">実績OD入力</option><option value="hybrid">ハイブリッド</option></select></label>${[
    ["population", "人口"],
    ["employment", "雇用"],
    ["students", "学生"],
    ["railShare", "利用率"],
    ["concentration", "時間集中（重み指数）"],
  ]
    .map(
      ([id, label]) =>
        `<label>${label}倍率<input type="number" min="0" step="any" id="scenario-${id}" value="1"></label>`,
    )
    .join(
      "",
    )}</div><p class="muted">実績・ハイブリッドは上の期間のfit用ODを、目的未指定のため通勤往路として明示採用します。帰路と時間分布は既存設定を使用。実測値がない架空鉄道は自動生成を利用できます。</p><div class="actions"><label>比較用の一律輸送定員（空欄＝共通設定）<input type="number" min="1" step="1" id="scenario-capacity"></label><p class="muted">この定員はシナリオ比較時だけ適用します。需要の切替は配分画面の共通定員を変更しません。</p><button data-lab-action="scenario-create">条件から生成して保存</button><button data-lab-action="scenario-snapshot">現在の時間帯需要をそのまま保存</button></div><div class="table-wrap"><table><thead><tr><th>シナリオ</th><th>方式</th><th>時間帯総量</th><th>設定前提</th><th>切替</th></tr></thead><tbody>${a.scenarios.map((s) => `<tr><td>${e(s.name)}</td><td>${e(s.mode)}</td><td>${n(s.temporal.slots.reduce((a, d) => a + d.passengers, 0))}</td><td>${e(s.assumptions)}</td><td><button data-lab-scenario="${e(s.id)}">この需要へ切替</button></td></tr>`).join("")}</tbody></table></div></section><section class="panel"><h2>ダイヤ改正・需要シナリオの比較</h2><div class="route-options"><label>比較方法<select id="compare-mode"><option value="timetable">固定需要でダイヤ比較</option><option value="scenario">同じダイヤでシナリオ比較</option></select></label><label>前ダイヤ／共通ダイヤ<select id="compare-before">${options}</select></label><label>後ダイヤ<select id="compare-after">${options}</select></label><label>シナリオA<select id="compare-scenario-a">${a.scenarios.map((s) => `<option value="${e(s.id)}">${e(s.name)}</option>`).join("")}</select></label><label>シナリオB<select id="compare-scenario-b">${a.scenarios.map((s) => `<option value="${e(s.id)}">${e(s.name)}</option>`).join("")}</select></label><label>分析OD発駅<select id="compare-origin">${stations}</select></label><label>分析OD着駅<select id="compare-destination">${stations}</select></label></div><p class="muted">配分条件・需要到着時間窓・定員制約は「旅客配分・混雑分析」の保存設定を使用します。同じ駅ID体系内で比較し、需要の自動再生成はしません。</p><button data-lab-action="compare">比較計算</button>${worker ? '<button data-lab-action="cancel">計算を中止</button>' : ""}</section>${comparison ? comparisonHtml(comparison) : ""}<section class="panel"><h2>モデルの感度分析</h2><p>現在の都市属性・固定費用で自動生成を行います。保存済みの手動・実測ODを置換しません。</p><label>全条件共通の配分方式<select id="sensitivity-method"><option value="logit">ロジット</option><option value="fastest">最速到着</option></select></label><button data-lab-action="sensitivity">9条件の感度を計算</button></section>${sensitivities.length ? sensitivityView(sensitivities) : ""}</div>`;
}
export function analyticsClick(button: HTMLElement, ctx: UIContext) {
  const action = button.dataset.labAction,
    scenario = button.dataset.labScenario;
  if (!action && !scenario) return false;
  const p = ctx.project,
    a = analytics(p);
  try {
    error = "";
    if (scenario) {
      const s = a.scenarios.find((s) => s.id === scenario)!;
      p.temporal = structuredClone(s.temporal);
      p.temporalConfig = structuredClone(s.temporal.config);
      a.activeScenarioId = s.id;
      ctx.save();
      notice = "保存した固定需要へ切り替えました";
    } else if (action === "sensitivity-json") {
      download(
        "model-sensitivity.json",
        JSON.stringify(
          {
            datasetId: p.datasetId,
            timetableId: ctx.diaId,
            rows: sensitivities,
          },
          null,
          2,
        ),
        "application/json",
      );
      return true;
    } else if (action === "sensitivity") {
      worker?.terminate();
      comparison = null;
      sensitivities = [];
      sourceStamp = signature(ctx);
      const expected = sourceStamp,
        current = new Worker(
          new URL("./sensitivity-worker.ts", import.meta.url),
          { type: "module" },
        );
      worker = current;
      notice = "感度分析を計算中…";
      current.onmessage = (event) => {
        if (worker !== current) return;
        const data = event.data;
        if (data.type === "progress") {
          const el = document.querySelector("#lab-status");
          if (el) el.textContent = `感度分析 ${data.done}/${data.total} 条件`;
          return;
        }
        current.terminate();
        worker = null;
        if (
          expected !== signature(ctx) ||
          workspace.projects.find(
            (p) => p.datasetId === ctx.project.datasetId,
          ) !== ctx.project
        )
          error = "入力変更のため感度結果を破棄しました";
        else if (data.type === "error") error = data.message;
        else {
          sensitivities = data.rows;
          notice = "感度分析終了。実測による独立検証とは別の結果です";
        }
        ctx.render();
      };
      current.onerror = (event) => {
        current.terminate();
        worker = null;
        error = event.message;
        ctx.render();
      };
      const config = {
        ...(p.assignmentConfig ?? defaultAssignmentConfig()),
        method: val("sensitivity-method") === "fastest" ? "fastest" : "logit",
      };
      current.postMessage({
        project: {
          ...p,
          analytics: undefined,
          temporal: undefined,
          temporalConfig: p.temporal?.config ?? p.temporalConfig,
          costs: p.temporal?.costs ?? p.costs,
        },
        timetableId: ctx.diaId,
        config,
      });
    } else if (action === "template" || action === "template-v05") {
      download(
        "observations-template.csv",
        observationTemplate(action === "template-v05"),
        "text/csv",
      );
      return true;
    } else if (action === "load-validate") {
      if (!checked("lab-load-aligned"))
        throw new Error("観測期間と配分時間窓の一致を確認してください");
      const result =
        val("lab-load-source") === "integrated"
          ? currentNetworkResult()
          : currentAssignmentResult(ctx);
      if (!result) throw new Error("先に旅客配分を実行してください");
      const metrics = evaluateTrainObservations(
        result,
        a.observations.map((o) => ({
          ...o,
          datasetId: o.datasetId ?? p.datasetId,
        })),
        val("lab-period"),
      );
      notice = `列車断面の配分検証：${metrics.count}件、MAE ${metrics.mae === null ? "未算出" : n(metrics.mae)}人、RMSE ${metrics.rmse === null ? "未算出" : n(metrics.rmse)}人、平均誤差 ${n(metrics.meanError)}人。除外 ${metrics.excluded?.length ?? 0}件：${
        metrics.excluded
          ?.slice(0, 5)
          .map((x) => x.id + " " + x.reason)
          .join("、") ?? ""
      }。OD校正には使用しません。`;
    } else if (action === "calibrate") {
      const seed =
        p.temporal?.dailyOutbound ??
        generateTemporalDemand(
          p,
          p.temporalConfig ?? defaultTemporalConfig(),
          p.costs,
        ).dailyOutbound;
      a.calibrations.push(
        calibrateDemand(
          p,
          seed,
          a.observations,
          val("lab-period"),
          checked("lab-trip-ends"),
          checked("lab-fit-coefficients"),
        ),
      );
      ctx.save();
    } else if (action === "apply-calibration") {
      const r = a.calibrations.at(-1)!;
      if (!r.converged) throw new Error("未収束の校正結果は適用できません");
      const current =
        p.temporal ??
        generateTemporalDemand(
          p,
          p.temporalConfig ?? defaultTemporalConfig(),
          p.costs,
        );
      p.temporal = resplitTemporal({
        ...current,
        config: structuredClone(r.selectedCoefficients),
        dailyOutbound: structuredClone(r.daily),
        manualSplits: [],
        generated: r.daily.reduce((s, d) => s + d.passengers, 0),
        unallocated: 0,
      });
      p.temporalConfig = structuredClone(r.selectedCoefficients);
      ctx.save();
      notice = "校正後の推計往路を適用しました";
    } else if (action === "scenario-create") {
      const factors = {
        population: Number(val("scenario-population")),
        employment: Number(val("scenario-employment")),
        students: Number(val("scenario-students")),
        railShare: Number(val("scenario-railShare")),
        concentration: Number(val("scenario-concentration")),
      };
      const scenario = buildScenario(
        p,
        val("scenario-name"),
        val("scenario-mode") as "automatic",
        val("lab-period"),
        factors,
      );
      scenario.capacityOverride = scenarioCapacity();
      a.scenarios.push(scenario);
      ctx.save();
    } else if (action === "scenario-snapshot") {
      if (!p.temporal) throw new Error("保存する時間帯需要がありません");
      if (!val("scenario-name").trim())
        throw new Error("シナリオ名を入力してください");
      a.scenarios.push({
        id: crypto.randomUUID(),
        name: val("scenario-name"),
        mode: "automatic",
        temporal: structuredClone(p.temporal),
        created: new Date().toISOString(),
        assumptions: "既存時間帯需要の固定コピー。出典をそのまま保存",
        capacityOverride: scenarioCapacity(),
      });
      validateProject(p);
      ctx.save();
    } else if (action === "cancel") {
      worker?.terminate();
      worker = null;
      notice = "中止しました。部分比較は表示しません";
    } else if (action === "comparison-json") {
      if (comparison)
        download(
          "timetable-comparison.json",
          JSON.stringify(
            { version: "0.6", datasetId: p.datasetId, comparison },
            null,
            2,
          ),
          "application/json",
        );
      return true;
    } else if (action === "benefits-csv") {
      const b = comparison?.benefits;
      if (!b?.comparable)
        throw new Error("同一入力需要でないため便益CSVは未算出です");
      download(
        "passenger-benefits.csv",
        csv([
          [
            "originDataset",
            "origin",
            "destinationDataset",
            "destination",
            "purpose",
            "commonPassengers",
            "changePersonMinutes",
            "excluded",
          ],
          ...b.odRows.map((v) => [
            v.origin.datasetId,
            v.origin.stationId,
            v.destination.datasetId,
            v.destination.stationId,
            v.purpose,
            v.passengers,
            v.changePersonSeconds / 60,
            v.excluded,
          ]),
        ]),
        "text/csv",
      );
      return true;
    } else if (action === "comparison-csv") {
      if (comparison)
        download(
          "comparison.csv",
          csv([
            ["metric", "before", "after", "difference", "unit"],
            ...comparison.rows.map((r) => [
              r.label,
              r.before ?? "",
              r.after ?? "",
              r.difference ?? "",
              r.unit,
            ]),
          ]),
          "text/csv",
        );
      return true;
    } else if (action === "compare") {
      if (!p.temporal) throw new Error("固定する時間帯需要がありません");
      worker?.terminate();
      comparison = null;
      const scenarioMode = val("compare-mode") === "scenario",
        s1 = a.scenarios.find((s) => s.id === val("compare-scenario-a")),
        s2 = a.scenarios.find((s) => s.id === val("compare-scenario-b"));
      if (scenarioMode && (!s1 || !s2))
        throw new Error("比較する2シナリオを保存してください");
      const input = (scenarioMode ? s1!.temporal : p.temporal).slots.map(
          (r) => ({ ...r, datasetId: p.datasetId! }),
        ),
        afterInput = scenarioMode
          ? s2!.temporal.slots.map((r) => ({ ...r, datasetId: p.datasetId! }))
          : undefined;
      const beforeId = val("compare-before"),
        afterId = scenarioMode ? beforeId : val("compare-after"),
        origin = val("compare-origin"),
        destination = val("compare-destination");
      sourceStamp = signature(ctx);
      const stamp = sourceStamp;
      const current = new Worker(
        new URL("./comparison-worker.ts", import.meta.url),
        { type: "module" },
      );
      worker = current;
      notice = "比較を計算中…";
      current.onmessage = (e) => {
        if (worker !== current) return;
        if (e.data.type === "progress") {
          const el = document.querySelector("#lab-status");
          if (el) el.textContent = e.data.message;
          return;
        }
        current.terminate();
        worker = null;
        if (
          stamp !== signature(ctx) ||
          workspace.projects.find(
            (p) => p.datasetId === ctx.project.datasetId,
          ) !== ctx.project
        ) {
          error = "入力が変わったため比較結果を破棄しました";
        } else if (e.data.type === "error") error = e.data.message;
        else {
          comparison = e.data.result;
          notice = "比較終了。同じ条件と需要IDを検証しました";
        }
        ctx.render();
      };
      current.onerror = (e) => {
        current.terminate();
        worker = null;
        error = e.message;
        ctx.render();
      };
      current.postMessage({
        project: projectForScenario(p, scenarioMode ? s1 : undefined),
        afterProject: scenarioMode ? projectForScenario(p, s2) : undefined,
        input,
        afterInput,
        beforeId,
        afterId,
        config: p.assignmentConfig ?? defaultAssignmentConfig(),
        origin,
        destination,
      });
    }
  } catch (err) {
    error = (err as Error).message;
  }
  ctx.render();
  return true;
}
export async function analyticsChange(el: HTMLInputElement, ctx: UIContext) {
  if (el.id !== "observation-file") {
    if (el.id) form[el.id] = el.type === "checkbox" ? el.checked : el.value;
    return;
  }
  try {
    const file = el.files?.[0];
    if (!file) return;
    const observations = importObservations(ctx.project, await file.text());
    analytics(ctx.project).observations = observations;
    ctx.save();
    error = "";
    notice = `実測データ${observations.length}件を読み込みました`;
  } catch (err) {
    error = (err as Error).message;
  }
  ctx.render();
}

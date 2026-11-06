import { clock } from "./analysis";
import { timetableCosts } from "./demand";
import {
  defaultTemporalConfig,
  generateTemporalDemand,
  resplitTemporal,
  resizeTimeSlots,
  allocateVolume,
} from "./temporal-demand";
import {
  validateTemporalConfig,
  purposeLabels,
  purposes,
  type TemporalState,
  type TemporalConfig,
} from "./temporal-model";
import { validateProject, type Purpose } from "./model";
import { download, csv } from "./io";
import { escapeHtml as e, numberText as n, type UIContext } from "./ui-utils";

let dataset = "",
  origin = "",
  destination = "",
  purpose: Purpose = "commute",
  manualDaily = 0,
  manualSource = "manual",
  costSource = "manual",
  error = "";
function ensure(ctx: UIContext) {
  if (dataset !== ctx.project.datasetId) {
    dataset = ctx.project.datasetId!;
    origin = ctx.project.stations[0].id;
    destination = ctx.project.stations.at(-1)!.id;
    error = "";
  }
  ctx.project.temporalConfig ??= structuredClone(
    ctx.project.temporal?.config ??
      defaultTemporalConfig(ctx.project.oud2?.serviceDayStart ?? 14400),
  );
}
const btn = (action: string, label: string, cls = "") =>
  `<button type="button" data-temporal-action="${action}" class="${cls}">${label}</button>`;
const input = (attrs: string, value: number) =>
  `<input type="number" min="0" step="any" ${attrs} value="${value}">`;
function selectedSlots(state: TemporalState) {
  return state.slots.filter(
    (s) =>
      s.origin === origin &&
      s.destination === destination &&
      s.purpose === purpose,
  );
}
function slotTable(ctx: UIContext) {
  const state = ctx.project.temporal;
  if (!state)
    return '<p class="notice">日間需要を生成するか、日間ODを手動設定してください。</p>';
  const slots = selectedSlots(state),
    c = state.config;
  const startTimes = new Set(
    Array.from(
      { length: 1440 / c.slotMinutes },
      (_, i) => c.serviceDayStart + i * c.slotMinutes * 60,
    ),
  );
  slots.forEach((s) => startTimes.add(s.start));
  return `<div class="table-wrap"><table><thead><tr><th>時間枠</th><th>往路人数（編集可）</th><th>帰路人数</th><th>出典</th></tr></thead><tbody>${[
    ...startTimes,
  ]
    .sort((a, b) => a - b)
    .map((t) => {
      const outgoing = slots.filter(
          (s) => s.start === t && s.kind === "outbound",
        ),
        back = slots.filter((s) => s.start === t && s.kind === "return");
      return `<tr><td>${clock(t)}–${clock(t + c.slotMinutes * 60)}</td><td>${
        t < c.serviceDayStart + 86400
          ? input(
              `data-slot-start="${t}" aria-label="${clock(t)}の往路人数"`,
              outgoing.reduce((s, r) => s + r.passengers, 0),
            )
          : n(outgoing.reduce((s, r) => s + r.passengers, 0))
      }</td><td>${n(back.reduce((s, r) => s + r.passengers, 0))}</td><td>${[...new Set([...outgoing, ...back].map((s) => ({ estimated: "推計値", manual: "手動設定値", observed: "実測値" })[s.source]))].join(" / ") || "—"}</td></tr>`;
    })
    .join("")}</tbody></table></div>`;
}
export function renderTemporal(ctx: UIContext) {
  ensure(ctx);
  const p = ctx.project,
    c = p.temporalConfig!,
    state = p.temporal;
  const options = (selected: string) =>
    p.stations
      .map(
        (s) =>
          `<option value="${e(s.id)}" ${selected === s.id ? "selected" : ""}>${e(s.name)} ｜ ${e(s.id)}</option>`,
      )
      .join("");
  const daily = state?.daily.reduce((s, r) => s + r.passengers, 0) ?? 0,
    slots = state?.slots.reduce((s, r) => s + r.passengers, 0) ?? 0;
  return `<div id="temporal-page"><section class="panel"><div class="panel-heading"><span class="eyebrow">DAILY DEMAND → TIME SLICES</span><h2>目的別・時間帯別のOD需要</h2><p>日間需要と時間分布を保存し、ダイヤを切り替えても同じ需要で比較できます。既存の単一時間帯重力モデルはそのまま利用できます。</p></div><div class="route-options"><label>時間単位<select id="temporal-slot"><option value="60" ${c.slotMinutes === 60 ? "selected" : ""}>1時間</option><option value="15" ${c.slotMinutes === 15 ? "selected" : ""}>15分</option></select></label><label>解析日開始（時）${input('id="temporal-start" max="23"', c.serviceDayStart / 3600)}</label><label>抵抗係数 β（1/分）${input('id="temporal-beta"', c.beta)}</label><label>人数の丸め<select id="temporal-rounding"><option value="fractional" ${c.rounding === "fractional" ? "selected" : ""}>実数（残差調整で保存）</option><option value="integer" ${c.rounding === "integer" ? "selected" : ""}>整数（最大剰余法）</option></select></label><label>再生成に使う固定費用<select id="temporal-cost"><option value="manual" ${costSource === "manual" ? "selected" : ""}>既存の手動時間行列</option><option value="snapshot" ${costSource === "snapshot" ? "selected" : ""}>現在のダイヤの最短直通時間を固定</option></select></label></div><p class="notice">初期係数・時間分布・滞在時間は架空の仮定です。日間往路 Oᵢ = 人口 × 鉄道利用率 × 目的別発生係数。吸引力は雇用・学生・商業の別係数を使用します。帰路時刻は往路枠開始＋固定移動時間＋滞在時間から求め、時間枠へ集約します。</p><div class="table-wrap"><table><thead><tr><th>目的</th><th>日間発生係数</th><th>雇用の吸引</th><th>学生の吸引</th><th>商業の吸引</th><th>帰宅・帰路率（0〜1）</th></tr></thead><tbody>${c.purposes.map((r) => `<tr><td>${purposeLabels[r.purpose]}</td>${(["generation", "employmentWeight", "studentWeight", "attractionWeight", "returnShare"] as const).map((k) => `<td>${input(`data-purpose="${r.purpose}" data-profile-key="${k}" aria-label="${purposeLabels[r.purpose]} ${k}" ${k === "returnShare" ? 'max="1"' : ""}`, r[k])}</td>`).join("")}</tr>`).join("")}</tbody></table></div><details><summary>時間帯別の相対発生比率を編集（各目的内で正規化）</summary><div class="table-wrap time-profile-table"><table><thead><tr><th>時間帯</th>${c.purposes.map((r) => `<th>${purposeLabels[r.purpose]}</th>`).join("")}</tr></thead><tbody>${Array.from({ length: 1440 / c.slotMinutes }, (_, i) => `<tr><td>${clock(c.serviceDayStart + i * c.slotMinutes * 60)}</td>${c.purposes.map((r) => `<td>${input(`data-time-purpose="${r.purpose}" data-time-index="${i}" aria-label="${purposeLabels[r.purpose]} ${i}枠の比率"`, r.timeWeights[i])}</td>`).join("")}</tr>`).join("")}</tbody></table></div></details><details><summary>滞在時間分布を編集（帰路の時刻）</summary><div class="table-wrap"><table><thead><tr><th>目的</th><th>滞在1（分）</th><th>重み1</th><th>滞在2（分）</th><th>重み2</th></tr></thead><tbody>${c.purposes.map((r) => `<tr><td>${purposeLabels[r.purpose]}</td>${r.stayDistribution.map((s, i) => `<td>${input(`data-stay-purpose="${r.purpose}" data-stay-index="${i}" data-stay-key="minutes"`, s.minutes)}</td><td>${input(`data-stay-purpose="${r.purpose}" data-stay-index="${i}" data-stay-key="weight"`, s.weight)}</td>`).join("")}</tr>`).join("")}</tbody></table></div></details><div class="actions">${btn("generate", "都市データから日間ODを再生成", "primary")}${btn("resplit", "日間ODを維持して時間配分を更新")}${btn("csv", "時間帯OD CSV出力")}</div><p class="muted">再生成はこの時間帯需要シナリオを置換します。係数・β・費用の変更は再生成時に日間人数へ反映します。時間分布・滞在・帰路率の変更は既存日間往路を使って再配分します。手動の時間帯配分はODごとの設定として保持します。</p></section>${error ? `<div role="alert" class="notice">${e(error)}</div>` : ""}${state ? `<div class="metrics"><article class="metric"><span>保存した日間需要（往路＋生成帰路）</span><strong>${n(daily)}<small>人</small></strong></article><article class="metric"><span>時間帯別の合計</span><strong>${n(slots)}<small>人</small></strong><p>差分 ${n(slots - daily, 8)}人</p></article><article class="metric"><span>発生モデルの未配分往路</span><strong>${n(Math.max(0, state.unallocated))}<small>人</small></strong><p>手動上書きは発生モデルの総量を変更します</p></article></div>${state.warnings.map((w) => `<p class="notice">${e(w)}</p>`).join("")}<details class="panel"><summary>日間生成時の係数と固定費用の前提</summary><p class="muted">現在のダイヤと独立した所要時間行列を保存しています。帰路が翌運行日以降になる場合も時刻を折り返さず保持します。実測・手動の往路から生成した帰路は推計値です。</p><pre>${e(JSON.stringify(state.dailyCoefficientSnapshot ?? state.config, null, 2))}</pre></details>` : ""}<section class="panel"><h2>任意ODの日間・時間帯人数を編集</h2><div class="route-options"><label>出発駅<select id="temporal-origin">${options(origin)}</select></label><label>到着駅<select id="temporal-destination">${options(destination)}</select></label><label>目的<select id="temporal-purpose">${purposes.map((p) => `<option value="${p}" ${purpose === p ? "selected" : ""}>${purposeLabels[p]}</option>`).join("")}</select></label><label>日間往路人数${input('id="temporal-manual-daily"', manualDaily)}</label><label>入力値の出典<select id="temporal-source"><option value="manual" ${manualSource === "manual" ? "selected" : ""}>手動設定値</option><option value="observed" ${manualSource === "observed" ? "selected" : ""}>実測値（利用者が指定）</option><option value="estimated" ${manualSource === "estimated" ? "selected" : ""}>推計値</option></select></label>${btn("daily", "日間人数を設定")}</div><p class="muted">日間の選択OD往路：${n(state?.dailyOutbound.filter((d) => d.origin === origin && d.destination === destination && d.purpose === purpose).reduce((s, r) => s + r.passengers, 0))}人。時間枠の往路人数を編集すると出典を手動設定値とし、そのODの日間人数も合計から再集計します。帰路は再計算します。</p>${slotTable(ctx)}</section></div>`;
}
function current(ctx: UIContext) {
  ensure(ctx);
  return (
    ctx.project.temporal ??
    generateTemporalDemand(
      ctx.project,
      ctx.project.temporalConfig!,
      ctx.project.costs,
    )
  );
}
function apply(ctx: UIContext, state: TemporalState) {
  const before = ctx.project.temporal;
  ctx.project.temporal = state;
  try {
    validateProject(ctx.project);
  } catch (err) {
    ctx.project.temporal = before;
    throw err;
  }
  ctx.save();
}
export function temporalClick(button: HTMLElement, ctx: UIContext) {
  const action = button.dataset.temporalAction;
  if (!action) return false;
  try {
    ensure(ctx);
    if (action === "generate") {
      apply(
        ctx,
        generateTemporalDemand(
          ctx.project,
          ctx.project.temporalConfig!,
          costSource === "snapshot"
            ? timetableCosts(ctx.project, ctx.diaId)
            : ctx.project.costs,
        ),
      );
    } else if (action === "resplit")
      apply(
        ctx,
        resplitTemporal({
          ...current(ctx),
          config: ctx.project.temporalConfig!,
        }),
      );
    else if (action === "daily") {
      if (
        origin === destination ||
        !Number.isFinite(manualDaily) ||
        manualDaily < 0
      )
        throw new Error("発着駅を分け、非負の日間人数を指定してください");
      const state = structuredClone(current(ctx));
      state.dailyOutbound = state.dailyOutbound.filter(
        (r) =>
          !(
            r.origin === origin &&
            r.destination === destination &&
            r.purpose === purpose
          ),
      );
      state.dailyOutbound.push({
        origin,
        destination,
        purpose,
        passengers: manualDaily,
        source: manualSource as "manual",
        kind: "outbound",
      });
      state.manualSplits = state.manualSplits?.filter(
        (r) =>
          !(
            r.origin === origin &&
            r.destination === destination &&
            r.purpose === purpose
          ),
      );
      apply(
        ctx,
        resplitTemporal({ ...state, config: ctx.project.temporalConfig! }),
      );
    } else if (action === "csv") {
      const s = ctx.project.temporal;
      if (!s) throw new Error("時間帯需要を生成してください");
      download(
        "temporal-od.csv",
        csv([
          [
            "datasetId",
            "origin",
            "destination",
            "purpose",
            "kind",
            "startSeconds",
            "endSeconds",
            "passengers",
            "source",
            "scenarioId",
          ],
          ...s.slots.map((r) => [
            ctx.project.datasetId!,
            r.origin,
            r.destination,
            r.purpose,
            r.kind,
            r.start,
            r.end,
            r.passengers,
            r.source,
            s.config.id,
          ]),
        ]),
        "text/csv",
      );
      return true;
    }
    error = "";
  } catch (err) {
    error = (err as Error).message;
  }
  ctx.render();
  return true;
}
export function temporalChange(el: HTMLInputElement, ctx: UIContext) {
  ensure(ctx);
  try {
    if (el.type === "number" && (!el.value.trim() || !el.validity.valid))
      throw new Error("数値の範囲を確認してください");
    if (el.id === "temporal-origin") origin = el.value;
    else if (el.id === "temporal-destination") destination = el.value;
    else if (el.id === "temporal-purpose") purpose = el.value as Purpose;
    else if (el.id === "temporal-manual-daily") {
      manualDaily = Number(el.value);
      return;
    } else if (el.id === "temporal-source") {
      manualSource = el.value;
      return;
    } else if (el.id === "temporal-cost") {
      costSource = el.value;
      return;
    } else if (el.dataset.slotStart) {
      const state = structuredClone(current(ctx));
      const c = state.config;
      const count = 1440 / c.slotMinutes;
      const counts = Array.from({ length: count }, (_, i) =>
        state.slots
          .filter(
            (r) =>
              r.origin === origin &&
              r.destination === destination &&
              r.purpose === purpose &&
              r.kind === "outbound" &&
              r.start === c.serviceDayStart + i * c.slotMinutes * 60,
          )
          .reduce((s, r) => s + r.passengers, 0),
      );
      counts[
        (Number(el.dataset.slotStart) - c.serviceDayStart) /
          (c.slotMinutes * 60)
      ] = Number(el.value);
      state.manualSplits =
        state.manualSplits?.filter(
          (s) =>
            !(
              s.origin === origin &&
              s.destination === destination &&
              s.purpose === purpose
            ),
        ) ?? [];
      state.manualSplits.push({ origin, destination, purpose, counts });
      state.dailyOutbound = state.dailyOutbound.filter(
        (r) =>
          !(
            r.origin === origin &&
            r.destination === destination &&
            r.purpose === purpose
          ),
      );
      state.dailyOutbound.push({
        origin,
        destination,
        purpose,
        passengers: counts.reduce((a, b) => a + b, 0),
        source: "manual",
        kind: "outbound",
      });
      apply(ctx, resplitTemporal(state));
    } else {
      let config = structuredClone(ctx.project.temporalConfig!);
      if (el.id === "temporal-slot")
        config = resizeTimeSlots(config, Number(el.value) as 60 | 15);
      else if (el.id === "temporal-start")
        config.serviceDayStart = Number(el.value) * 3600;
      else if (el.id === "temporal-beta") config.beta = Number(el.value);
      else if (el.id === "temporal-rounding")
        config.rounding = el.value as TemporalConfig["rounding"];
      else if (el.dataset.profileKey) {
        const r = config.purposes.find(
          (p) => p.purpose === el.dataset.purpose,
        )!;
        (r as unknown as Record<string, unknown>)[el.dataset.profileKey] =
          Number(el.value);
      } else if (el.dataset.timePurpose)
        config.purposes.find(
          (p) => p.purpose === el.dataset.timePurpose,
        )!.timeWeights[Number(el.dataset.timeIndex)] = Number(el.value);
      else if (el.dataset.stayPurpose) {
        const stay = config.purposes.find(
          (p) => p.purpose === el.dataset.stayPurpose,
        )!.stayDistribution[Number(el.dataset.stayIndex)];
        stay[el.dataset.stayKey as "minutes" | "weight"] = Number(el.value);
      }
      validateTemporalConfig(config);
      const old = ctx.project.temporalConfig!;
      const oldState = ctx.project.temporal;
      if (oldState) {
        const next = structuredClone(oldState);
        if (config.slotMinutes !== old.slotMinutes && next.manualSplits)
          for (const split of next.manualSplits)
            split.counts =
              config.slotMinutes === 15
                ? split.counts.flatMap((n) =>
                    allocateVolume(
                      n,
                      [1, 1, 1, 1],
                      config.rounding === "integer",
                    ),
                  )
                : Array.from({ length: 24 }, (_, i) =>
                    split.counts
                      .slice(i * 4, i * 4 + 4)
                      .reduce((a, b) => a + b, 0),
                  );
        next.config = config;
        apply(ctx, resplitTemporal(next));
      }
      ctx.project.temporalConfig = config;
      ctx.save();
    }
    error = "";
  } catch (err) {
    error = (err as Error).message;
  }
  ctx.render();
}

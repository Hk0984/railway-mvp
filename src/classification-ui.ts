import {
  classLabels,
  serviceClass,
  classificationCounts,
  trainClassKey,
  referenceClassification,
  applyReferenceClassification,
  capacityOf,
  type ServiceClass,
} from "./classification";
import { operationGroup } from "./operation-numbers";
import { transportCapacity } from "./capacity-model";
import { validateProject } from "./model";
import { trainVisits, clock } from "./analysis";
import {
  renderCapacityEditor,
  capacityEditorClick,
  capacityEditorChange,
} from "./capacity-ui";
import { invalidateRoutingCache } from "./routing-cache";
import { escapeHtml as e, numberText as n, type UIContext } from "./ui-utils";
let filter = "",
  page = 0,
  error = "";
const capacityDraft = new Set<string>();
const select = (attrs: string, value: string, inherit = false) =>
  '<div class="class-checkboxes" role="group">' +
  [
    ...(inherit ? [["inherit", "種別設定を継承"]] : []),
    ...Object.entries(classLabels),
  ]
    .map(
      ([id, label]) =>
        `<label><input type="checkbox" ${attrs.replace(/aria-label="([^"]*)"/, (_, text) => `aria-label="${text}：${label}"`)} value="${id}" ${value === id ? "checked" : ""}>${label}</label>`,
    )
    .join("") +
  "</div>";
export function renderClassification(ctx: UIContext) {
  const p = ctx.project,
    c = classificationCounts(p, ctx.diaId),
    preset = referenceClassification(p),
    dia = p.timetables.find((d) => d.id === ctx.diaId)!;
  const trains = dia.trains.filter((t) =>
    [t.id, t.number, p.types.find((x) => x.id === t.typeId)?.name]
      .join(" ")
      .includes(filter),
  );
  page = Math.min(page, Math.max(0, Math.ceil(trains.length / 60) - 1));
  const start = page * 60;
  return `<div id="classification-page">${renderCapacityEditor(ctx)}<section class="panel"><h2>営業区分を明示して、旅客に利用できる列車だけを選ぶ</h2><p class="muted">各行1つをチェックします。未設定は「要確認」です。非営業と要確認は、旅客検索・需要費用・配分から除外します。元のダイヤ・全列車分析は維持します。</p><div class="metrics">${[
    ["登録列車", c.registered],
    ["営業（運休除外）", c.passenger],
    ["非営業", c.nonPassenger],
    ["要確認", c.review],
  ]
    .map(
      ([label, value]) =>
        `<article class="metric"><span>${label}</span><strong>${n(value as number, 0)}<small>本</small></strong></article>`,
    )
    .join(
      "",
    )}</div>${preset ? `<p class="notice">${e(preset.name)}の参照ファイルとSHA-256が一致します。初期分類では、回送・試運転を非営業、臨時など未確定の種別を要確認とします。旅客種別の設定も確認してから適用してください。</p><button data-class-action="preset" class="primary">参照ファイル用の初期分類を確認して適用</button>` : '<p class="notice">参照ファイル専用の初期分類はありません。種別ごとに区分と設定根拠を入力してください。名称だけで営業と判断しません。</p>'}${error ? `<p role="alert" class="notice">${e(error)}</p>` : ""}<h3>列車種別の営業区分・予備定員</h3><div class="table-wrap"><table><thead><tr><th>種別 / ID</th><th>営業区分</th><th>設定根拠</th><th>種別定員（人）</th></tr></thead><tbody>${p.types
    .map((t) => {
      const v = p.serviceClasses?.types[t.id],
        enabled =
          p.typeCapacities?.[t.id] !== undefined ||
          capacityDraft.has(p.datasetId + ":type:" + t.id);
      return `<tr><td>${e(t.name)}<small class="block">${e(t.id)}</small></td><td>${select(`data-class-type="${e(t.id)}" aria-label="${e(t.name)}の営業区分"`, v?.state ?? "review")}</td><td><input data-class-type-basis="${e(t.id)}" value="${e(v?.basis ?? "")}" placeholder="利用者の確認結果・設定根拠"></td><td><label><input type="checkbox" data-type-capacity-enable="${e(t.id)}" ${enabled ? "checked" : ""}>定員を設定</label><input ${enabled ? "" : "disabled"} type="number" min="1" step="1" data-type-capacity="${e(t.id)}" aria-label="${e(t.name)}の定員" value="${p.typeCapacities?.[t.id] ?? ""}" placeholder="不明"></td></tr>`;
    })
    .join(
      "",
    )}</tbody></table></div><p class="muted">定員は原ファイルにない場合、空欄のまま保持します。運用記号別の設定がない列車には、列車種別の定員を予備設定として継承します。個別指定があれば個別定員を優先します。運休 ${c.cancelled}本は分類にかかわらず旅客利用不可です。</p></section><section class="panel"><h2>個別列車・便の上書き（選択ダイヤ）</h2><label>番号・種別・IDの部分一致<input id="class-filter" value="${e(filter)}" placeholder="例：回送、列車番号、oud-0-Kudari-67"></label><div class="actions"><button data-class-action="previous">← 前の60件</button><span>${Math.min(start + 1, trains.length)}–${Math.min(start + 60, trains.length)} / ${trains.length}件</span><button data-class-action="next">次の60件 →</button></div><div class="table-wrap"><table><thead><tr><th>番号 / ID</th><th>種別・方向・区間</th><th>個別区分</th><th>現在の判定</th><th>個別定員</th></tr></thead><tbody>${trains
    .slice(start, start + 60)
    .map((t) => {
      const visits = trainVisits(t),
        key = trainClassKey(ctx.diaId, t.id),
        override = p.serviceClasses?.trains[key],
        v = serviceClass(p, ctx.diaId, t),
        op = operationGroup(p, t),
        enabled =
          t.capacity !== undefined ||
          capacityDraft.has(p.datasetId + ":" + ctx.diaId + ":train:" + t.id),
        current = transportCapacity(p, ctx.diaId, t.id);
      const name = (id: string | undefined) =>
        p.stations.find((s) => s.id === id)?.name ?? "—";
      return `<tr><td>${e(t.number || "番号なし")}<small class="block">${e(t.id)}</small></td><td>${e(p.types.find((x) => x.id === t.typeId)?.name)} / ${t.direction === "down" ? "下り" : "上り"}<small class="block">${e(name(visits[0]?.stationId))} → ${e(name(visits.at(-1)?.stationId))}</small><small class="block">運用：${e(op.numbers.join(";") || "未記載")} ／ 記号 ${e(op.group ?? "未確定")}</small><input data-train-operation="${e(t.id)}" aria-label="${e(t.id)}の運用番号上書き" value="${e(t.operationNumbers?.join(";") ?? "")}" placeholder="運用番号を手動指定（空欄で原文へ）"><small class="block">${e(op.reason)}</small></td><td>${select(`data-class-train="${e(t.id)}" aria-label="${e(t.id)}の個別営業区分"`, override?.state ?? "inherit", true)}</td><td><span class="tag ${v.state === "passenger" ? "green" : ""}">${classLabels[v.state]}${t.cancelled ? " / 運休" : ""}</span><small class="block">${e(v.basis)}</small></td><td><label><input type="checkbox" data-train-capacity-enable="${e(t.id)}" ${enabled ? "checked" : ""}>個別定員を設定</label><input ${enabled ? "" : "disabled"} type="number" min="1" step="1" data-train-capacity="${e(t.id)}" value="${t.capacity ?? ""}" aria-label="${e(t.id)}の個別定員" placeholder="継承 / 不明"><small class="block">現在 ${current === null ? "不明" : n(current, 0) + "人"}</small></td></tr>`;
    })
    .join("")}</tbody></table></div></section></div>`;
}
export function classClick(button: HTMLElement, ctx: UIContext) {
  if (capacityEditorClick(button, ctx)) return true;
  const action = button.dataset.classAction;
  if (!action) return false;
  try {
    if (action === "preset") {
      applyReferenceClassification(ctx.project);
      invalidateRoutingCache(ctx.project);
      ctx.save();
    } else if (action === "previous") page = Math.max(0, page - 1);
    else if (action === "next") {
      const d = ctx.project.timetables.find((d) => d.id === ctx.diaId)!;
      page = Math.min(
        Math.max(0, Math.ceil(d.trains.length / 60) - 1),
        page + 1,
      );
    }
    error = "";
  } catch (err) {
    error = (err as Error).message;
  }
  ctx.render();
  return true;
}
export function classChange(el: HTMLInputElement, ctx: UIContext) {
  if (capacityEditorChange(el, ctx)) return;
  if (el.closest("#capacity-editor")) return;
  if (el.id === "class-filter") {
    filter = el.value;
    page = 0;
    ctx.render();
    return;
  }
  const p = ctx.project,
    previous = { classes: p.serviceClasses, caps: p.typeCapacities };
  const train = el.dataset.trainCapacity
    ? p.timetables
        .find((d) => d.id === ctx.diaId)!
        .trains.find((t) => t.id === el.dataset.trainCapacity)
    : undefined;
  const oldCapacity = train?.capacity;
  if (el.dataset.trainOperation) {
    const t = p.timetables
      .find((d) => d.id === ctx.diaId)!
      .trains.find((t) => t.id === el.dataset.trainOperation)!;
    const previous = t.operationNumbers;
    try {
      t.operationNumbers = el.value.trim()
        ? el.value.split(/[;,\s]+/).filter(Boolean)
        : undefined;
      validateProject(p);
      invalidateRoutingCache(p);
      ctx.save();
      error = "";
    } catch (err) {
      t.operationNumbers = previous;
      error = (err as Error).message;
    }
    ctx.render();
    return;
  }
  if (el.dataset.typeCapacityEnable || el.dataset.trainCapacityEnable) {
    const id = el.dataset.typeCapacityEnable ?? el.dataset.trainCapacityEnable!,
      kind = el.dataset.typeCapacityEnable ? "type" : "train",
      key =
        p.datasetId +
        ":" +
        (kind === "train" ? ctx.diaId + ":" : "") +
        kind +
        ":" +
        id;
    if (el.checked) capacityDraft.add(key);
    else {
      capacityDraft.delete(key);
      if (kind === "type") {
        p.typeCapacities = { ...p.typeCapacities };
        delete p.typeCapacities[id];
      } else {
        p.timetables
          .find((d) => d.id === ctx.diaId)!
          .trains.find((t) => t.id === id)!.capacity = undefined;
      }
      invalidateRoutingCache(p);
      ctx.save();
    }
    ctx.render();
    return;
  }
  const choice =
    el.type === "checkbox" && !el.checked
      ? el.dataset.classTrain
        ? "inherit"
        : "review"
      : el.value;
  try {
    if (el.type === "number" && el.value !== "" && !el.validity.valid)
      throw new Error("定員は正の整数か空欄で入力してください");
    if (
      el.dataset.classType ||
      el.dataset.classTypeBasis ||
      el.dataset.classTrain
    ) {
      const next = structuredClone(
        p.serviceClasses ?? { types: {}, trains: {} },
      );
      if (el.dataset.classTrain) {
        const key = trainClassKey(ctx.diaId, el.dataset.classTrain);
        if (choice === "inherit") delete next.trains[key];
        else
          next.trains[key] = {
            state: choice as ServiceClass,
            basis: "利用者が個別列車の区分を手動設定",
          };
      } else {
        const id = el.dataset.classType ?? el.dataset.classTypeBasis!;
        const old = next.types[id] ?? {
          state: "review" as const,
          basis: "利用者が種別の区分を手動設定",
        };
        next.types[id] = el.dataset.classType
          ? { ...old, state: choice as ServiceClass }
          : { ...old, basis: el.value };
      }
      p.serviceClasses = next;
    }
    if (el.dataset.typeCapacity) {
      p.typeCapacities = { ...p.typeCapacities };
      if (el.value === "") delete p.typeCapacities[el.dataset.typeCapacity];
      else p.typeCapacities[el.dataset.typeCapacity] = Number(el.value);
    }
    if (train) train.capacity = el.value === "" ? undefined : Number(el.value);
    validateProject(p);
    invalidateRoutingCache(p);
    ctx.save();
    error = "";
  } catch (err) {
    p.serviceClasses = previous.classes;
    p.typeCapacities = previous.caps;
    if (train) train.capacity = oldCapacity;
    error = (err as Error).message;
  }
  ctx.render();
}

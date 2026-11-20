import { escapeHtml as e, type UIContext } from "./ui-utils";
import { operationGroup } from "./operation-numbers";
import { validateProject } from "./model";
import { trainClassKey } from "./classification";
import { invalidateRoutingCache } from "./routing-cache";
const operationDraft = new Set<string>();
function operationEditor(ctx: UIContext) {
  const p = ctx.project,
    groups = new Map<string, { numbers: Set<string>; count: number }>();
  for (const t of p.timetables.flatMap((d) => d.trains)) {
    const op = operationGroup(p, t);
    if (!op.group) continue;
    const g = groups.get(op.group) ?? { numbers: new Set<string>(), count: 0 };
    op.numbers.forEach((n) => g.numbers.add(n));
    g.count++;
    groups.set(op.group, g);
  }
  for (const id of Object.keys(p.capacitySettings?.operationGroups ?? {}))
    if (!groups.has(id)) groups.set(id, { numbers: new Set(), count: 0 });
  return `<h3>運用番号の英字記号ごとの定員</h3><p>例：01C・03CはC、15DはD。チェックを入れて定員を入力します。未記載・複数番号は推測せず、個別列車の欄で確認・上書きしてください。</p><div class="table-wrap"><table><thead><tr><th>英字記号</th><th>明示された運用番号の例</th><th>列車レコード</th><th>設定</th><th>定員（人）</th><th>設定根拠</th></tr></thead><tbody>${
    [...groups]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, g]) => {
        const v = p.capacitySettings?.operationGroups?.[id],
          enabled = !!v || operationDraft.has(p.datasetId + ":" + id);
        return `<tr><td>${e(id)}</td><td>${e([...g.numbers].slice(0, 6).join(" / "))}</td><td>${g.count}</td><td><label><input type="checkbox" data-operation-capacity-enable="${e(id)}" ${enabled ? "checked" : ""}>定員を指定</label>${v?.kind === "seats" ? "（座席のみ）" : ""}</td><td><input type="number" min="1" step="1" data-operation-capacity="${e(id)}" aria-label="運用記号${e(id)}の定員" value="${v?.value ?? ""}" ${enabled ? "" : "disabled"}></td><td>${e(v?.basis ?? "未設定")}</td></tr>`;
      })
      .join("") ||
    '<tr><td colspan="6">一意に読める英字記号がありません。対象「運用番号の英字記号」から手動で設定することもできます。</td></tr>'
  }</tbody></table></div>`;
}
export function capacityEditorChange(el: HTMLInputElement, ctx: UIContext) {
  const id = el.dataset.operationCapacity ?? el.dataset.operationCapacityEnable;
  if (!id) return false;
  const p = ctx.project,
    previous = p.capacitySettings;
  try {
    if (el.type === "checkbox" && el.checked) {
      operationDraft.add(p.datasetId + ":" + id);
      ctx.render();
      return true;
    }
    const next = structuredClone(
      p.capacitySettings ?? { timetables: {}, trains: {}, types: {} },
    );
    next.operationGroups ??= {};
    if (el.type === "checkbox" || !el.value.trim()) {
      delete next.operationGroups[id];
      if (el.type === "checkbox") operationDraft.delete(p.datasetId + ":" + id);
      else operationDraft.add(p.datasetId + ":" + id);
    } else
      next.operationGroups[id] = {
        value: Number(el.value),
        kind: next.operationGroups[id]?.kind ?? "transport",
        basis: "利用者が運用記号 " + id + " の列車定員を設定",
      };
    p.capacitySettings = next;
    validateProject(p);
    invalidateRoutingCache(p);
    ctx.save();
    ctx.message("運用記号の定員設定を更新しました");
  } catch (err) {
    p.capacitySettings = previous;
    ctx.message((err as Error).message);
  }
  ctx.render();
  return true;
}
export function renderCapacityEditor(ctx: UIContext) {
  const p = ctx.project;
  return `<section class="panel" id="capacity-editor"><h2>輸送定員の根拠と標準設定</h2><p class="notice">座席定員は輸送定員として使いません。個別→運用記号→種別→ダイヤ標準の順で継承します。下記の個別メタデータは旧個別定員より優先します。運用記号は例：01C→C。複数番号・途中変更・番号未記載は自動適用しません。</p><div class="route-options"><label>対象<select id="capacity-scope"><option value="timetables">ダイヤ標準</option><option value="trains">個別列車（選択ダイヤ）</option><option value="operationGroups">運用番号の英字記号</option><option value="types">列車種別</option></select></label><label>対象ID<input id="capacity-target" list="capacity-targets" value="${e(ctx.diaId)}"><datalist id="capacity-targets">${[...p.timetables, ...p.types, ...p.timetables.find((d) => d.id === ctx.diaId)!.trains, ...[...new Set(p.timetables.flatMap((d) => d.trains.flatMap((t) => (operationGroup(p, t).group ? [operationGroup(p, t).group!] : []))))].map((id) => ({ id, name: "運用記号 " + id }))].map((x) => `<option value="${e(x.id)}">${e("name" in x ? x.name : x.number)}</option>`).join("")}</datalist></label><label>1編成の定員（人）<input id="capacity-value" type="number" min="1" step="1"></label><label><input id="capacity-kind" type="checkbox" checked>輸送定員として使用（オフは座席定員のみ）</label><label>設定根拠<input id="capacity-basis"></label><label>編成・車両（任意）<input id="capacity-vehicle"></label><label>編成両数（任意）<input id="capacity-cars" type="number" min="1" step="1"></label></div><div class="actions"><button data-capacity-action="apply">定員メタデータを保存</button><button data-capacity-action="remove">設定を削除して継承</button></div><div class="table-wrap"><table><thead><tr><th>対象</th><th>ID</th><th>種類</th><th>人数</th><th>根拠 / 車両</th></tr></thead><tbody>${Object.entries(
    p.capacitySettings ?? {},
  )
    .flatMap(([scope, map]) =>
      Object.entries(
        map as Record<string, import("./capacity-model").CapacitySpec>,
      ).map(
        ([id, v]) =>
          `<tr><td>${e(({ timetables: "ダイヤ標準", trains: "個別列車", types: "列車種別", operationGroups: "運用記号" } as Record<string, string>)[scope] ?? scope)}</td><td>${e(id)}</td><td>${v.kind === "transport" ? "輸送" : "座席"}</td><td>${v.value}</td><td>${e(v.basis)} / ${e(v.vehicle ?? "")}</td></tr>`,
      ),
    )
    .join("")}</tbody></table></div>${operationEditor(ctx)}</section>`;
}
export function capacityEditorClick(button: HTMLElement, ctx: UIContext) {
  if (!button.dataset.capacityAction) return false;
  const value = (id: string) =>
    (document.getElementById(id) as HTMLInputElement).value;
  const p = ctx.project,
    previous = p.capacitySettings;
  try {
    const scope = value("capacity-scope") as
        "timetables" | "trains" | "types" | "operationGroups",
      target =
        scope === "operationGroups"
          ? value("capacity-target").trim().toUpperCase()
          : value("capacity-target"),
      key = scope === "trains" ? trainClassKey(ctx.diaId, target) : target;
    const next = structuredClone(
      p.capacitySettings ?? { timetables: {}, trains: {}, types: {} },
    );
    if (scope === "operationGroups") next.operationGroups ??= {};
    if (button.dataset.capacityAction === "remove") delete next[scope]![key];
    else
      next[scope]![key] = {
        value: Number(value("capacity-value")),
        kind: (document.getElementById("capacity-kind") as HTMLInputElement)
          .checked
          ? "transport"
          : "seats",
        basis: value("capacity-basis"),
        vehicle: value("capacity-vehicle"),
        carCount: value("capacity-cars") ? Number(value("capacity-cars")) : undefined,
      };
    p.capacitySettings = next;
    validateProject(p);
    invalidateRoutingCache(p);
    ctx.save();
    ctx.message("定員メタデータを保存しました");
  } catch (err) {
    p.capacitySettings = previous;
    ctx.message((err as Error).message);
  }
  ctx.render();
  return true;
}

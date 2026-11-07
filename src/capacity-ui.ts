import { escapeHtml as e, type UIContext } from "./ui-utils";
import { validateProject } from "./model";
import { trainClassKey } from "./classification";
import { invalidateRoutingCache } from "./routing-cache";
export function renderCapacityEditor(ctx: UIContext) {
  const p = ctx.project;
  return `<section class="panel" id="capacity-editor"><h2>輸送定員の根拠と標準設定</h2><p class="notice">座席定員は輸送定員として使いません。個別→種別→ダイヤ標準の順で継承します。下記の個別メタデータは旧個別定員より優先します。</p><div class="route-options"><label>対象<select id="capacity-scope"><option value="timetables">ダイヤ標準</option><option value="trains">個別列車（選択ダイヤ）</option><option value="types">種別</option></select></label><label>対象ID<input id="capacity-target" list="capacity-targets" value="${e(ctx.diaId)}"><datalist id="capacity-targets">${[...p.timetables, ...p.types, ...p.timetables.find((d) => d.id === ctx.diaId)!.trains].map((x) => `<option value="${e(x.id)}">${e("name" in x ? x.name : x.number)}</option>`).join("")}</datalist></label><label>定員（人）<input id="capacity-value" type="number" min="1" step="1"></label><label>種類<select id="capacity-kind"><option value="transport">設定輸送定員</option><option value="seats">座席定員のみ</option></select></label><label>設定根拠<input id="capacity-basis"></label><label>編成・車両（任意）<input id="capacity-vehicle"></label></div><div class="actions"><button data-capacity-action="apply">定員メタデータを保存</button><button data-capacity-action="remove">設定を削除して継承</button></div><div class="table-wrap"><table><thead><tr><th>対象</th><th>ID</th><th>種類</th><th>人数</th><th>根拠 / 車両</th></tr></thead><tbody>${Object.entries(
    p.capacitySettings ?? {},
  )
    .flatMap(([scope, map]) =>
      Object.entries(
        map as Record<string, import("./capacity-model").CapacitySpec>,
      ).map(
        ([id, v]) =>
          `<tr><td>${e(scope)}</td><td>${e(id)}</td><td>${v.kind === "transport" ? "輸送" : "座席"}</td><td>${v.value}</td><td>${e(v.basis)} / ${e(v.vehicle ?? "")}</td></tr>`,
      ),
    )
    .join("")}</tbody></table></div></section>`;
}
export function capacityEditorClick(button: HTMLElement, ctx: UIContext) {
  if (!button.dataset.capacityAction) return false;
  const value = (id: string) =>
    (document.getElementById(id) as HTMLInputElement).value;
  const p = ctx.project,
    previous = p.capacitySettings;
  try {
    const scope = value("capacity-scope") as "timetables" | "trains" | "types",
      target = value("capacity-target"),
      key = scope === "trains" ? trainClassKey(ctx.diaId, target) : target;
    const next = structuredClone(
      p.capacitySettings ?? { timetables: {}, trains: {}, types: {} },
    );
    if (button.dataset.capacityAction === "remove") delete next[scope][key];
    else
      next[scope][key] = {
        value: Number(value("capacity-value")),
        kind: value("capacity-kind") as "transport" | "seats",
        basis: value("capacity-basis"),
        vehicle: value("capacity-vehicle"),
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

import { capacitySpec } from "./capacity-model";
import {
  classLabels,
  serviceClass,
  trainClassKey,
  type ServiceClass,
} from "./classification";
import {
  boundaryTrains,
  defaultLineDemand,
  periods,
  type LineDemand,
  type OutsideArea,
} from "./line-demand";
import type { Project, Timetable } from "./model";
import { escapeHtml as e, numberText as n } from "./ui-utils";

export function options(items: { id: string; name: string }[], value: string) {
  return items
    .map(
      ({ id, name }) =>
        `<option value="${e(id)}" ${id === value ? "selected" : ""}>${e(name)}</option>`,
    )
    .join("");
}

const num = (
  name: string,
  value: number | undefined,
  label: string,
  step = "any",
) =>
  `<input name="${name}" aria-label="${e(label)}" type="number" min="0" max="1000000000" step="${step}" value="${value ?? ""}">`;

function shareFields(shares: number[], prefix: string) {
  return `<div class="period-fields">${periods
    .map(
      (period, i) =>
        `<label><span>${period.label}</span><small>${period.note}</small><span class="field-unit">${num(prefix + i, shares[i], period.label + "の割合")}<span>%</span></span></label>`,
    )
    .join("")}</div>`;
}

export function areaCard(
  p: Project,
  dia: Timetable,
  area: OutsideArea,
  i: number,
) {
  const trainOptions = (station: string, flow: "inbound" | "outbound") => {
    const selected = new Set(area.trains[dia.id]?.[flow]);
    return boundaryTrains(dia, station, flow)
      .map(
        (train) =>
          `<option value="${e(train.id)}" ${selected.has(train.id) ? "selected" : ""}>${e(train.number || train.id)} ／ ${train.direction === "down" ? "下り" : "上り"}${serviceClass(p, dia.id, train).state !== "passenger" ? "（営業区分を確認）" : ""}</option>`,
      )
      .join("");
  };
  return `<div class="area-card" data-area="${e(area.id)}">
    <div class="section-heading"><h3>方面 ${i + 1}</h3><button type="button" data-remove-area="${i}" class="quiet">削除</button></div>
    <div class="fields">
      <label>方面名<input name="area-name" value="${e(area.name)}" placeholder="都心方面" required maxlength="100"></label>
      <label>接続駅<select name="area-station">${options(p.stations, area.stationId)}</select></label>
      <label>1日の流入（人）${num("area-in", area.inbound, "1日の流入")}</label>
      <label>1日の流出（人）${num("area-out", area.outbound, "1日の流出")}</label>
      <label>接続方法<select name="area-mode"><option value="transfer">接続駅で乗換</option><option value="through" ${area.mode === "through" ? "selected" : ""}>列車で直通</option></select></label>
    </div>
    <label class="check"><input type="checkbox" name="area-included" ${area.included ? "checked" : ""}> 接続駅の人数に含まれる（流入は乗車数、流出は降車数）</label>
    <div class="fields through-fields" ${area.mode === "transfer" ? "hidden" : ""}>
      <label>流入に使う直通列車<select name="trains-in" multiple size="4">${trainOptions(area.stationId, "inbound")}</select></label>
      <label>流出に使う直通列車<select name="trains-out" multiple size="4">${trainOptions(area.stationId, "outbound")}</select></label>
      <p class="muted">接続駅を路線内の始発・終着とする列車を選びます。複数選択できます。</p>
    </div>
  </div>`;
}

export function settingsBody(p: Project, dia: Timetable, draft?: LineDemand) {
  const d = draft ?? p.lineDemand ?? defaultLineDemand();
  return `
  <section class="surface timetable-settings">
    <div class="section-heading"><div><h2>ダイヤデータ</h2><p class="muted">OuDia2ndの時刻表または保存した設定を開きます。</p></div></div>
    <div class="fields">
      <label>対象ダイヤ<select id="active-dia">${options(p.timetables, dia.id)}</select></label>
      <label>文字コード<select id="encoding"><option value="auto">自動判定</option><option value="utf-8">UTF-8</option><option value="shift_jis">Shift_JIS</option><option value="utf-16le">UTF-16 LE</option><option value="utf-16be">UTF-16 BE</option></select></label>
      <label class="file-pick">ファイルを開く<input type="file" id="open-file" accept=".oud2,.json"></label>
    </div>
    <div class="inline-actions"><button type="button" data-action="export">設定のJSONを保存</button><button type="button" data-action="sample">サンプルを開く</button></div>
    ${p.oud2?.warnings.length ? `<details><summary>取り込み時の注意（${p.oud2.warnings.length}件）</summary><ul>${p.oud2.warnings.map((v) => `<li>${e(v)}</li>`).join("")}</ul></details>` : ""}
  </section>
  <form id="settings-form">
    <section class="surface">
      <div class="section-heading"><div><h2>駅利用者数</h2><p class="muted">1日あたりの人数。行先は到達可能な駅の降車人数に重みを掛けて配分します。</p></div></div>
      <div class="table-scroll"><table><thead><tr><th scope="col">駅</th><th scope="col">乗車（人）</th><th scope="col">降車（人）</th><th scope="col">行先の重み</th></tr></thead>
      <tbody>${p.stations
        .map((s, i) => {
          const c = d.counts[s.id];
          return `<tr><th scope="row">${e(s.name)}</th><td>${num("board" + i, c?.board, s.name + "の乗車人数")}</td><td>${num("alight" + i, c?.alight, s.name + "の降車人数")}</td><td>${num("weight" + i, c?.weight ?? 1, s.name + "の行先の重み")}</td></tr>`;
        })
        .join("")}</tbody></table></div>
    </section>
    <section class="surface">
      <div class="section-heading"><div><h2>時間帯の振り分け</h2><p class="muted">合計100%。時間帯内は一様に駅へ到着すると仮定します。</p></div></div>
      ${shareFields(d.shares.local, "local")}
      <details ${d.shares.inbound || d.shares.outbound ? "open" : ""}><summary>流入・流出だけ別の割合を使う</summary>
        ${(["inbound", "outbound"] as const)
          .map(
            (flow) => `
          <label class="check"><input type="checkbox" name="override-${flow}" ${d.shares[flow] ? "checked" : ""}> ${flow === "inbound" ? "流入" : "流出"}の割合を個別設定</label>
          <div data-override="${flow}" ${d.shares[flow] ? "" : "hidden"}>${shareFields(d.shares[flow] ?? d.shares.local, flow)}</div>`,
          )
          .join("")}
      </details>
    </section>
    <section class="surface">
      <div class="section-heading"><div><h2>路線外方面</h2><p class="muted">対象路線の外から入る人数と、外へ出る人数を設定します。</p></div><button type="button" data-action="add-area">方面を追加</button></div>
      <div id="outside-areas">${d.outside.map((area, i) => areaCard(p, dia, area, i)).join("")}</div>
    </section>
    <section class="surface">
      <div class="section-heading"><div><h2>営業区分・輸送定員</h2><p class="muted">営業列車を検索・配分に使用します。定員は1編成あたりの人数です。</p></div><button type="button" data-action="all-passenger">未確認の種別を営業に設定</button></div>
      <div class="table-scroll"><table><thead><tr><th scope="col">列車種別</th><th scope="col">営業区分</th><th scope="col">輸送定員（人）</th></tr></thead>
      <tbody>${p.types
        .map((t, i) => {
          const state = p.serviceClasses?.types[t.id]?.state ?? "review";
          const capacity = p.capacitySettings?.types[t.id];
          return `<tr><th scope="row">${e(t.name)}</th><td><select name="class${i}" aria-label="${e(t.name)}の営業区分">${options(classOptions, state)}</select></td>
        <td>${num("cap" + i, capacity?.kind === "transport" ? capacity.value : capacity ? undefined : p.typeCapacities?.[t.id], t.name + "の輸送定員", "1")}</td></tr>`;
        })
        .join("")}</tbody></table></div>
      <div class="fields single-field"><label>ダイヤ共通の輸送定員（人、任意）${num("default-cap", p.capacitySettings?.timetables[dia.id]?.kind === "transport" ? p.capacitySettings.timetables[dia.id].value : undefined, "ダイヤ共通の輸送定員", "1")}</label></div>
      <details><summary>列車別の設定（${n(dia.trains.length, 0)}本）</summary>
        <label class="train-filter">列車番号・種別で絞り込む<input type="search" id="train-filter"></label>
        <div class="table-scroll train-config"><table><thead><tr><th scope="col">列車</th><th scope="col">営業区分</th><th scope="col">輸送定員（人）</th><th scope="col">編成両数</th></tr></thead>
        <tbody>${dia.trains
          .map((t, i) => {
            const key = trainClassKey(dia.id, t.id);
            const own = p.capacitySettings?.trains[key];
            const resolved = capacitySpec(p, dia.id, t.id);
            const name = t.number || t.id;
            const type = p.types.find(({ id }) => id === t.typeId)?.name ?? "";
            return `<tr data-train-row="${e(name + " " + type)}"><th scope="row">${e(name)} <small>${e(type)}・${t.direction === "down" ? "下り" : "上り"}</small></th>
          <td><select name="train-class${i}" aria-label="${e(name)}の営業区分">${options([{ id: "", name: "種別に従う" }, ...classOptions], p.serviceClasses?.trains[key]?.state ?? "")}</select></td>
          <td>${num("train-cap" + i, own?.kind === "transport" ? own.value : own ? undefined : t.capacity, name + "の輸送定員", "1")}${!own && resolved?.kind === "transport" && t.capacity === undefined ? `<small class="muted">継承値 ${n(resolved.value, 0)} 人</small>` : ""}</td>
          <td>${num("cars" + i, own?.carCount, name + "の編成両数", "1")}</td></tr>`;
          })
          .join("")}</tbody></table></div>
      </details>
    </section>
    <div class="save-bar"><button type="submit" class="primary">設定を保存</button><span id="form-state" class="muted" aria-live="polite"></span></div>
  </form>`;
}

const classOptions = Object.entries(classLabels).map(([id, name]) => ({
  id,
  name,
}));

export function readDemand(
  form: HTMLFormElement,
  p: Project,
  dia: Timetable,
): LineDemand {
  const fields = new FormData(form);
  const str = (key: string) => String(fields.get(key) ?? "");
  const shares: LineDemand["shares"] = {
    local: periods.map((_, i) => Number(str("local" + i))),
  };
  for (const flow of ["inbound", "outbound"] as const)
    if (fields.has("override-" + flow))
      shares[flow] = periods.map((_, i) => Number(str(flow + i)));
  const base = p.lineDemand ?? defaultLineDemand();
  const outside = Array.from(
    form.querySelectorAll<HTMLElement>("[data-area]"),
  ).map((el): OutsideArea => {
    const field = (name: string) =>
      el.querySelector<HTMLInputElement | HTMLSelectElement>(
        `[name="${name}"]`,
      )!;
    const id = el.dataset.area!;
    const old = base.outside.find((a) => a.id === id);
    const stationId = field("area-station").value;
    const mode = field("area-mode").value as OutsideArea["mode"];
    const trains =
      mode === "through" && old && old.stationId === stationId
        ? { ...old.trains }
        : {};
    const selected = (name: string) =>
      Array.from((field(name) as HTMLSelectElement).selectedOptions).map(
        (v) => v.value,
      );
    if (mode === "through")
      trains[dia.id] = {
        inbound: selected("trains-in"),
        outbound: selected("trains-out"),
      };
    return {
      id,
      stationId,
      mode,
      name: field("area-name").value.trim(),
      inbound: Number(field("area-in").value),
      outbound: Number(field("area-out").value),
      included: (field("area-included") as HTMLInputElement).checked,
      trains,
    };
  });
  const counts = Object.fromEntries(
    p.stations.flatMap((s, i) =>
      str("board" + i) || str("alight" + i)
        ? [
            [
              s.id,
              {
                board: Number(str("board" + i)),
                alight: Number(str("alight" + i)),
                weight: Number(str("weight" + i) || 1),
              },
            ],
          ]
        : [],
    ),
  );
  return { counts, shares, outside };
}

export function applyTrainSettings(
  form: HTMLFormElement,
  p: Project,
  dia: Timetable,
) {
  const fields = new FormData(form);
  const picked = (key: string) => String(fields.get(key) ?? "");
  const classes = (p.serviceClasses ??= { types: {}, trains: {} });
  const caps = (p.capacitySettings ??= {
    timetables: {},
    trains: {},
    types: {},
  });
  const basis = "データ設定で登録";
  const writeClass = (
    target: typeof classes.types,
    id: string,
    value: string,
  ) => {
    if (!value) delete target[id];
    else if (target[id]?.state !== value)
      Object.defineProperty(target, id, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: { state: value as ServiceClass, basis },
      });
  };
  const writeCap = (
    target: typeof caps.types,
    id: string,
    field: string,
    cars?: number,
  ) => {
    const value = Number(picked(field));
    const current = Object.hasOwn(target, id) ? target[id] : undefined;
    if (value > 0) {
      if (
        current?.kind === "transport" &&
        current.value === value &&
        current.carCount === cars
      )
        return;
      Object.defineProperty(target, id, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: {
          kind: "transport",
          value,
          basis,
          ...(cars && { carCount: cars }),
        },
      });
    } else if (current?.kind === "transport") delete target[id];
  };
  p.types.forEach((t, i) => {
    writeClass(classes.types, t.id, picked("class" + i));
    if (!picked("cap" + i) && p.typeCapacities) delete p.typeCapacities[t.id];
    writeCap(caps.types, t.id, "cap" + i);
  });
  writeCap(caps.timetables, dia.id, "default-cap");
  dia.trains.forEach((t, i) => {
    const key = trainClassKey(dia.id, t.id);
    const cars = Number(picked("cars" + i)) || undefined;
    if (cars && !Number(picked("train-cap" + i)))
      throw new Error(
        `列車 ${t.number || t.id} の編成両数を登録するには、その列車の輸送定員も入力してください`,
      );
    writeClass(classes.trains, key, picked("train-class" + i));
    if (!picked("train-cap" + i)) delete t.capacity;
    writeCap(caps.trains, key, "train-cap" + i, cars);
  });
}

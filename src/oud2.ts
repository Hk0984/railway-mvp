import {
  defaultParameters,
  projectSchemaVersion,
  validateProject,
  type Project,
  type RoutePosition,
  type Train,
  type Stop,
  type StationOperation,
} from "./model";
import { parseOudText, parseOudTime, type OudNode } from "./oud2-text";

export interface Oud2Options {
  /** Explicit analysis convention. 'file' uses KitenJikoku; without it 00:00 is used. */
  serviceDayStart?: "file" | number;
}
const children = (n: OudNode, name: string) =>
  n.children.filter((c) => c.name === name);
const index = (raw: string, max: number, label: string) => {
  if (!/^\d+$/.test(raw) || Number(raw) >= max)
    throw new Error(`${label}: 添え字範囲外 ${raw}`);
  return Number(raw);
};

function parseOudColor(value: string | undefined) {
  // OuDia2nd serializes Windows COLORREF as 00BBGGRR. CSS uses #RRGGBB.
  const match = /^[0-9a-f]{2}([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(
    value ?? "",
  );
  if (!match) return null;
  const [, blue, green, red] = match;
  return `#${red}${green}${blue}`.toLowerCase();
}

export function parseOud2(
  text: string,
  options: Oud2Options = {},
): { project: Project; warnings: string[] } {
  const root = parseOudText(text),
    version = root.values.FileType;
  if (!["OuDiaSecond.1.07", "OuDiaSecond.1.17"].includes(version))
    throw new Error(
      `未対応FileType: ${version ?? "なし"}。対応版は1.07 / 1.17です`,
    );
  const rosens = children(root, "Rosen");
  if (rosens.length !== 1) throw new Error("路線ブロックは1つ必要です");
  const rosen = rosens[0];
  const warnings = new Set<string>();
  const unused = new Map<string, number>();
  const known: Record<string, string[]> = {
    root: ["FileType", "AppComment", "FileTypeAppComment"],
    Rosen: [
      "Rosenmei",
      "KitenJikoku",
      "KudariDiaAlias",
      "NoboriDiaAlias",
      "EnableOperation",
    ],
    Eki: ["Ekimei", "BrunchCoreEkiIndex", "DownMain", "UpMain"],
    EkiTrack2Cont: [],
    EkiTrack2: ["TrackName", "TrackRyakusyou", "TrackNoboriRyakusyou"],
    OuterTerminal: [
      "OuterTerminalEkimei",
      "OuterTerminalJikokuRyaku",
      "OuterTerminalDiaRyaku",
    ],
    Ressyasyubetsu: [
      "Syubetsumei",
      "Ryakusyou",
      "Hidden",
      "DiagramSenColor",
      "JikokuhyouMojiColor",
    ],
    Dia: ["DiaName"],
    Kudari: [],
    Nobori: [],
    Ressya: [
      "Houkou",
      "Syubetsu",
      "Ressyabangou",
      "Ressyamei",
      "Gousuu",
      "EkiJikoku",
      "Bikou",
      "Canceled",
    ],
  };
  const inspect = (n: OudNode) => {
    if (!Object.hasOwn(known, n.name))
      unused.set(
        `ブロック ${n.name}`,
        (unused.get(`ブロック ${n.name}`) ?? 0) + 1,
      );
    for (const k of Object.keys(n.values)) {
      if (k === "LoopOriginEkiIndex")
        throw new Error("環状線設定 LoopOriginEkiIndex は未対応です");
      if (
        n.name === "Ressya" &&
        !known.Ressya.includes(k) &&
        !/^Operation\d+[BA]$/.test(k)
      )
        throw new Error(
          `列車の未対応項目 ${k}（${n.line}行の列車）。増解結・未知の運行条件は推測しません`,
        );
      if (
        !(known[n.name] ?? []).includes(k) &&
        !(n.name === "Ressya" && /^Operation\d+[BA]$/.test(k))
      ) {
        const label = `${n.name}.${k}`;
        unused.set(label, (unused.get(label) ?? 0) + 1);
      }
    }
    n.children.forEach(inspect);
  };
  inspect(root);
  const requested = options.serviceDayStart ?? "file";
  const serviceDayStart =
    requested === "file"
      ? (parseOudTime(rosen.values.KitenJikoku) ?? 0)
      : requested;
  if (
    !Number.isFinite(serviceDayStart) ||
    serviceDayStart < 0 ||
    serviceDayStart >= 86400
  )
    throw new Error("解析運行日の起点は0〜24時未満が必要です");
  if (serviceDayStart > 0)
    warnings.add(
      `解析運行日起点は${Math.floor(serviceDayStart / 3600)}:${String((serviceDayStart % 3600) / 60).padStart(2, "0")}。起点未満の明示時刻は翌日（+24時間）として解析します。${requested === "file" ? "ファイルのKitenJikokuを解析規約として採用しています。" : "利用者指定の解析規約です。"}`,
    );
  const eki = children(rosen, "Eki");
  if (eki.length < 2) throw new Error("駅は2つ以上必要です");
  const resolveCore = (i: number, seen = new Set<number>()): number => {
    if (seen.has(i)) throw new Error("分岐駅参照に循環があります");
    seen.add(i);
    const raw = eki[i].values.BrunchCoreEkiIndex;
    return raw === undefined
      ? i
      : resolveCore(index(raw, eki.length, "分岐駅"), seen);
  };
  const coreIndices = eki.map((_, i) => resolveCore(i));
  const stations = eki.flatMap((n, i) => {
    if (!n.values.Ekimei) throw new Error(`駅${i}: 駅名がありません`);
    if (coreIndices[i] !== i) return [];
    return [
      {
        id: `oud-s${i}`,
        name: n.values.Ekimei,
        lineId: "oud-line",
        section: rosen.values.Rosenmei ?? "",
        population: 0,
        employment: 0,
        students: 0,
        attraction: 0,
        railShare: 0,
        transfers: [],
      },
    ];
  });
  const externalTerminals: NonNullable<Project["oud2"]>["externalTerminals"] =
    [];
  for (const [i, n] of eki.entries()) {
    if (coreIndices[i] !== i && children(n, "OuterTerminal").length)
      throw new Error(
        "派生駅に独立した路線外駅定義があります。共有関係が曖昧なため停止しました",
      );
    if (coreIndices[i] === i)
      for (const [j, t] of children(n, "OuterTerminal").entries()) {
        if (!t.values.OuterTerminalEkimei)
          throw new Error("路線外発着駅名がありません");
        externalTerminals.push({
          id: `oud-out-${i}-${j}`,
          boundaryStationId: `oud-s${i}`,
          name: t.values.OuterTerminalEkimei,
        });
      }
  }
  const positions: RoutePosition[] = eki.map((n, i) => {
    const core = coreIndices[i];
    const coreNode = eki[core];
    const cont = children(coreNode, "EkiTrack2Cont")[0];
    return {
      id: `oud-p${i}`,
      stationId: `oud-s${core}`,
      name: n.values.Ekimei,
      branchCorePositionId: core !== i ? `oud-p${core}` : undefined,
      tracks: cont
        ? children(cont, "EkiTrack2").map((t) => t.values.TrackName ?? "")
        : [],
      outerTerminalIds: externalTerminals
        .filter((t) => t.boundaryStationId === `oud-s${core}`)
        .map((t) => t.id),
    };
  });
  // A derived row before its core ends a branch; after its core it starts a branch.
  const links: NonNullable<Project["oud2"]>["links"] = [];
  for (let i = 0; i < positions.length - 1; i++) {
    if (coreIndices[i] > i || coreIndices[i + 1] < i + 1) continue;
    const from = positions[i].stationId,
      to = positions[i + 1].stationId;
    if (from !== to && !links.some((l) => l.from === from && l.to === to))
      links.push({ from, to });
  }
  const branchCount = positions.filter((x) => x.branchCorePositionId).length;
  if (branchCount)
    warnings.add(
      `分岐の派生行${branchCount}件を基幹駅IDへ統合しました。時刻表行と原時刻は別途保持し、同名だけでは駅を統合しません。乗換経路検索は未対応です`,
    );
  const types = children(rosen, "Ressyasyubetsu").map((n, i) => {
    if (!n.values.Syubetsumei) throw new Error("種別名がありません");
    if (n.values.Hidden === "1")
      warnings.add(
        "隠し種別も登録列車として保持します。旅客営業の可否は種別名から推測しません",
      );
    const diagramColor = parseOudColor(n.values.DiagramSenColor);
    const timetableColor = parseOudColor(n.values.JikokuhyouMojiColor);
    if (
      (n.values.DiagramSenColor !== undefined && !diagramColor) ||
      (n.values.JikokuhyouMojiColor !== undefined && !timetableColor)
    )
      warnings.add(
        `種別「${n.values.Syubetsumei}」の色に未対応の書式があります`,
      );
    return {
      id: String(i),
      name: n.values.Syubetsumei,
      diagramColor,
      timetableColor,
    };
  });
  let emptyColumns = 0,
    overnightTimes = 0;
  const operationCodes = new Set<number>();
  const timetables = children(rosen, "Dia").map((d, di) => ({
    id: `oud-dia${di}`,
    name: d.values.DiaName ?? `ダイヤ${di + 1}`,
    trains: d.children.flatMap((dir) => {
      if (!["Kudari", "Nobori"].includes(dir.name)) {
        warnings.add(`Dia配下の未対応ブロック ${dir.name}`);
        return [];
      }
      const order =
        dir.name === "Kudari" ? positions : [...positions].reverse();
      return children(dir, "Ressya").flatMap((n, ti) => {
        const v = n.values;
        if (!Object.keys(v).length && !n.children.length) {
          emptyColumns++;
          return [];
        }
        if (n.children.length)
          throw new Error("列車内の子ブロックは未対応です");
        const context = `${d.values.DiaName ?? di} / ${dir.name} / 列${ti + 1}（${n.line}行）`;
        const fail = (s: string): never => {
          throw new Error(`${context}: ${s}`);
        };
        if (v.Houkou && v.Houkou !== dir.name)
          fail("方向ブロックとHoukouが不一致");
        if (!types.some((t) => t.id === v.Syubetsu)) fail("列車種別の参照不正");
        if (v.EkiJikoku === undefined) fail("EkiJikokuがありません");
        const chunks = v.EkiJikoku.split(",");
        if (chunks.length === positions.length + 1 && chunks.at(-1) === "")
          chunks.pop();
        if (chunks.length > positions.length) fail("駅数を超える時刻データ");
        const time = (raw: string | undefined) => {
          const t = parseOudTime(raw, serviceDayStart);
          if (t !== undefined && parseOudTime(raw)! < serviceDayStart)
            overnightTimes++;
          return t;
        };
        let last = -1;
        const stops: Stop[] = order.map((position, i) => {
          const chunk = chunks[i] ?? "";
          if (!chunk || chunk === "0")
            return {
              stationId: position.stationId,
              positionId: position.id,
              status: "none",
            };
          const m = /^([012])(?:;([^$]*))?(?:\$(\d+))?$/.exec(chunk);
          if (!m) fail(`時刻構文未対応: ${chunk}`);
          const status =
              m![1] === "1" ? "stop" : m![1] === "2" ? "pass" : "none",
            pair = (m![2] ?? "").split("/");
          if (pair.length > 2) fail("着発時刻の区切り不正");
          const arrival = pair.length === 2 ? time(pair[0]) : undefined,
            departure = time(pair.length === 2 ? pair[1] : pair[0]);
          for (const t of [arrival, departure])
            if (t !== undefined) {
              if (t < last)
                fail(
                  "時刻逆転。解析運行日の起点と原ファイルを確認してください。時刻を推測して修正しません",
                );
              last = t;
            }
          return {
            stationId: position.stationId,
            positionId: position.id,
            status,
            arrival,
            departure,
            track: m![3],
          };
        });
        if (
          !stops.some(
            (s) => s.arrival !== undefined || s.departure !== undefined,
          )
        )
          fail("解析可能な時刻のない非空列車");
        if (v.Canceled !== undefined && !["0", "1"].includes(v.Canceled))
          fail("Canceledは0/1が必要です");
        const train: Train = {
          id: `oud-${di}-${dir.name}-${ti}`,
          number: v.Ressyabangou ?? "",
          typeId: v.Syubetsu,
          direction: dir.name === "Kudari" ? "down" : "up",
          stops,
          cancelled: v.Canceled === "1",
          operations: [],
          sourceEkiJikoku: v.EkiJikoku,
        };
        for (const [key, value] of Object.entries(v)) {
          const match = /^Operation(\d+)([BA])$/.exec(key);
          if (!match) continue;
          const position = order[index(match[1], order.length, "駅作業")],
            before = match[2] === "B";
          for (const raw of value.split(",")) {
            const code = Number(raw.split("/")[0]);
            if (!/^[03456]\//.test(raw))
              fail(`未対応駅作業: ${key}=${raw}（増解結は未対応）`);
            operationCodes.add(code);
            if (code === 0 && !/^0\/\d+\$[^$]*\$0$/.test(raw))
              fail(`入換作業の時刻適用設定は未対応: ${raw}`);
            train.operations!.push({
              positionId: position.id,
              phase: before ? "before" : "after",
              code: code as StationOperation["code"],
              raw,
            });
            if (code !== 4) continue;
            const parts = raw.split("$");
            const terminalIndex = index(
              parts[0].slice(2),
              position.outerTerminalIds.length,
              "路線外発着駅",
            );
            if (parts.length < 2 || parts.length > 4)
              fail(`路線外発着の構文不正: ${raw}`);
            const pair = parts[1].split("/");
            if (pair.length !== 2) fail(`路線外発着の時刻対が不正: ${raw}`);
            const first = time(pair[0]),
              second = time(pair[1]);
            if (first !== undefined && second !== undefined && first > second)
              fail("路線外発着時刻の逆転");
            const relevant = stops.filter((s) => s.status !== "none");
            const boundary = before ? relevant[0] : relevant.at(-1);
            if (boundary?.stationId !== position.stationId)
              fail("路線外作業が列車の境界駅にありません");
            const endpoint = {
              terminalId: position.outerTerminalIds[terminalIndex],
              boundaryStationId: position.stationId,
              positionId: position.id,
              externalTime: before ? first : second,
              boundaryTime: before ? second : first,
              raw,
            };
            const local = stops.find((s) => s.positionId === position.id);
            const explicit = before ? local?.arrival : local?.departure;
            if (
              explicit !== undefined &&
              endpoint.boundaryTime !== undefined &&
              explicit !== endpoint.boundaryTime
            )
              warnings.add(
                `${context}: 路線外作業とEkiJikokuの境界時刻が不一致。両値を保持し、路線内解析にはEkiJikokuのみ使用します（${explicit}秒 / ${endpoint.boundaryTime}秒）`,
              );
            if (before) {
              if (train.externalOrigin) fail("路線外始発作業の重複");
              train.externalOrigin = endpoint;
            } else {
              if (train.externalDestination) fail("路線外終着作業の重複");
              train.externalDestination = endpoint;
            }
          }
        }
        return [train];
      });
    }),
  }));
  if (!timetables.length || !timetables.some((d) => d.trains.length))
    throw new Error("ダイヤ・列車を抽出できませんでした");
  if (emptyColumns)
    warnings.add(`空の時刻表列${emptyColumns}件を列車数から除外しました`);
  if (overnightTimes)
    warnings.add(
      `運行日起点より前の明示時刻${overnightTimes}項目を翌日として正規化しました。原EkiJikokuは保持しています`,
    );
  if (externalTerminals.length)
    warnings.add(
      `路線外発着駅の定義${externalTerminals.length}件を境界駅別に保持しました。路線外駅は都市・OD対象に加えず、外部区間の時刻を路線内所要時間に含めません`,
    );
  if (operationCodes.size)
    warnings.add(
      `駅作業（コード${[...operationCodes].sort().join("/")}）の原文を保持。路線外発着以外の入換・入出区・列車接続・運用番号は運用シミュレーションや旅客直通の連結に使用しません`,
    );
  warnings.add(
    "人口等の都市属性は原ファイルにないため初期値0。回送・試運転等の営業可否は推測しません。集計対象の種別を確認してください",
  );
  warnings.add(
    "単独時刻は発時刻として保持し、着時刻を補完しません。分岐で同一駅の連続する着・発が別行の場合は、明示時刻を同一駅の訪問として分析します",
  );
  for (const [label, count] of unused)
    warnings.add(
      `未解析設定 ${label}（${count}件）：描画・表示等の設定は解析に利用しません`,
    );
  const project: Project = {
    schemaVersion: projectSchemaVersion,
    name: rosen.values.Rosenmei ?? "名称なし路線",
    stations,
    types,
    timetables,
    costs: {},
    parameters: { ...defaultParameters },
    demands: [],
    oud2: {
      fileType: version,
      serviceDayStart,
      positions,
      links,
      externalTerminals,
      emptyColumns,
      warnings: [...warnings],
    },
  };
  validateProject(project);
  return { project, warnings: project.oud2!.warnings };
}

import type { Project } from "./model";
export function csv(rows: (string | number)[][]) {
  return (
    "\uFEFF" +
    rows
      .map((row) =>
        row.map((x) => '"' + String(x).replace(/"/g, '""') + '"').join(","),
      )
      .join("\r\n")
  );
}
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [],
    cell = "",
    quoted = false,
    closed = false;
  const t = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === '"') {
      if (quoted && t[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (!quoted && (cell !== "" || closed))
        throw new Error("CSVの引用符が不正です");
      else {
        closed = quoted;
        quoted = !quoted;
      }
    } else if (c === "," && !quoted) {
      row.push(cell);
      cell = "";
      closed = false;
    } else if ((c === "\n" || c === "\r") && !quoted) {
      if (c === "\r" && t[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      closed = false;
    } else {
      if (closed) throw new Error("CSVの閉じ引用符の後に不正な文字があります");
      cell += c;
    }
  }
  if (quoted) throw new Error("CSVの引用符が閉じていません");
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}
export const stationColumns = [
  "id",
  "name",
  "lineId",
  "section",
  "population",
  "employment",
  "students",
  "attraction",
  "railShare",
  "transfers",
] as const;
export function stationCsv(p: Project) {
  return csv([
    [...stationColumns],
    ...p.stations.map((s) =>
      stationColumns.map((k) =>
        k === "transfers" ? JSON.stringify(s[k]) : s[k],
      ),
    ),
  ]);
}
export function importStationCsv(p: Project, text: string): Project {
  const [header, ...rows] = parseCsv(text);
  if (header?.join("|") !== stationColumns.join("|"))
    throw new Error(
      "駅CSVヘッダーが不正です。出力CSVをテンプレートにしてください",
    );
  const next = structuredClone(p);
  next.stations = rows
    .filter((r) => r.some(Boolean))
    .map((r) => {
      if (r.length !== 10) throw new Error("駅CSVの列数が不正");
      const num = (i: number) => {
        if (r[i].trim() === "") throw new Error("数値セルが空欄です");
        return Number(r[i]);
      };
      return {
        id: r[0],
        name: r[1],
        lineId: r[2],
        section: r[3],
        population: num(4),
        employment: num(5),
        students: num(6),
        attraction: num(7),
        railShare: num(8),
        transfers: JSON.parse(r[9]),
      };
    });
  return next;
}
export function demandCsv(p: Project) {
  return csv([
    ["origin", "destination", "purpose", "period", "passengers", "source"],
    ...p.demands.map((d) => [
      d.origin,
      d.destination,
      d.purpose,
      d.period,
      d.passengers,
      d.source,
    ]),
  ]);
}
export function importDemandCsv(p: Project, text: string): Project {
  const [h, ...rows] = parseCsv(text);
  if (h?.join(",") !== "origin,destination,purpose,period,passengers,source")
    throw new Error("OD CSVヘッダーが不正");
  const next = structuredClone(p);
  next.demands = rows
    .filter((r) => r.some(Boolean))
    .map((r) => {
      if (r.length !== 6 || !r[4].trim())
        throw new Error("OD CSVの列数・人数が不正");
      return {
        origin: r[0],
        destination: r[1],
        purpose: r[2] as Project["demands"][number]["purpose"],
        period: r[3],
        passengers: Number(r[4]),
        source: r[5] as Project["demands"][number]["source"],
      };
    });
  return next;
}
export function download(name: string, text: string, mime = "text/plain") {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

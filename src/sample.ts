import { defaultParameters, type Project } from "./model";
export function sampleProject(): Project {
  const stations = [
    ["緑丘ニュータウン", 42000, 2200, 600, 900],
    ["桜川", 26000, 4500, 1000, 2000],
    ["中央市", 18000, 38000, 1400, 21000],
    ["港ビジネス街", 9000, 46000, 400, 5000],
    ["東雲学園", 15000, 5000, 17000, 3000],
  ].map((s, i) => ({
    id: `s${i}`,
    name: s[0] as string,
    lineId: "line-1",
    section: "みらい線",
    population: s[1] as number,
    employment: s[2] as number,
    students: s[3] as number,
    attraction: s[4] as number,
    railShare: 0.6,
    transfers: [],
  }));
  const trains: Project["timetables"][number]["trains"] = [];
  for (const direction of ["down", "up"] as const)
    for (let n = 0; n < 36; n++) {
      const express = n % 3 === 1;
      const start = (6 * 60 + n * 20 + (direction === "up" ? 7 : 0)) * 60;
      const order = direction === "down" ? [0, 1, 2, 3, 4] : [4, 3, 2, 1, 0];
      trains.push({
        id: `${direction}-${n}`,
        number: `${direction === "down" ? "1" : "2"}${n.toString().padStart(2, "0")}`,
        typeId: express ? "rapid" : "local",
        direction,
        capacity: 600,
        stops: order.map((i, j) => ({
          stationId: `s${i}`,
          status: express && i === 1 ? "pass" : "stop",
          arrival: j === 0 ? undefined : start + j * (express ? 300 : 420),
          departure:
            j === 4
              ? undefined
              : start + j * (express ? 300 : 420) + (j === 0 ? 0 : 30),
        })),
      });
    }
  const costs: Project["costs"] = {};
  for (let i = 0; i < 5; i++) {
    costs[`s${i}`] = {};
    for (let j = 0; j < 5; j++) costs[`s${i}`][`s${j}`] = Math.abs(i - j) * 7;
  }
  return {
    schemaVersion: 1,
    datasetId: "sample-mirai",
    name: "みらい都市鉄道",
    stations,
    types: [
      { id: "local", name: "普通" },
      { id: "rapid", name: "快速" },
    ],
    timetables: [{ id: "weekday", name: "平日・サンプル", trains }],
    costs,
    parameters: { ...defaultParameters },
    demands: [],
  };
}

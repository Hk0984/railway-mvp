import { it, expect } from "vitest";
import { benchmarkData } from "./benchmark-data";
import { assignDemand } from "../src/assignment";
import { assignDemand as before } from "./helpers/assignment-v04";
import { buildRoutingIndex, searchJourneys } from "../src/routing";
import {
  buildRoutingIndex as beforeIndex,
  searchJourneys as beforeSearch,
} from "./helpers/routing-v04";
import { sampleProject } from "../src/sample";
import type { RouteQuery } from "../src/routing-model";
it("matches saved 0.4 on distinct sparse OD at 5, 40 and 110 stations", () => {
  for (const stations of [5, 40, 110]) {
    const s = benchmarkData(stations, 12, stations === 5 ? 30 : 120, "sparse"),
      select = [
        {
          datasetId: s.project.datasetId!,
          project: s.project,
          timetableId: "weekday",
        },
      ],
      a = before(beforeIndex(select), s.demands, s.config),
      b = assignDemand(buildRoutingIndex(select), s.demands, s.config);
    expect(b.allocations).toEqual(a.allocations);
    expect(b.journeys).toEqual(a.journeys);
    expect(b.loads).toEqual(a.loads);
    expect(b.totals).toEqual(a.totals);
    expect(b.diagnostics.profiles).toBeLessThan(s.demands.length);
  }
}, 30000);
it("shares first-round origin profiles without changing destinations, time modes or sort criteria", () => {
  const p = sampleProject(),
    selection = [
      { datasetId: p.datasetId!, project: p, timetableId: "weekday" },
    ],
    a = beforeIndex(selection),
    b = buildRoutingIndex(selection);
  for (const mode of ["depart", "arrive"] as const)
    for (const sort of ["arrival", "riding", "transfers"] as const)
      for (const dest of ["s2", "s3", "s4"]) {
        const q: RouteQuery = {
          origin: { datasetId: p.datasetId!, stationId: "s0" },
          destination: { datasetId: p.datasetId!, stationId: dest },
          mode,
          time: mode === "depart" ? 25200 : 32400,
          maxTransfers: 0,
          minimumTransferSeconds: 120,
          directOnly: true,
          sort,
          limit: 20,
        };
        const x = beforeSearch(a, q),
          y = searchJourneys(b, q);
        expect(y.journeys).toEqual(x.journeys);
        expect(y.candidateCount).toBe(x.candidateCount);
      }
});

import { it, expect } from "vitest";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { parseOud2 } from "../src/oud2";
import {
  buildRoutingIndex as oldBuild,
  searchJourneys as oldSearch,
} from "./helpers/routing-v02";
import { buildRoutingIndex, searchJourneys } from "../src/routing";
import type { RouteQuery } from "../src/routing-model";
const base = new URL("./fixtures/real/", import.meta.url);
it.skipIf(
  !existsSync(new URL("琴町線.oud2", base)) ||
    !existsSync(new URL("堀電バス［は01］［は02］［は03］［北11］.oud2", base)),
)(
  "compares reference 0.2 and current results and records local timing/memory",
  () => {
    const records = [];
    for (const [file, o, d, sort] of [
      ["琴町線.oud2", "oud-s23", "oud-s31", "arrival"],
      ["琴町線.oud2", "oud-s23", "oud-s31", "riding"],
      [
        "堀電バス［は01］［は02］［は03］［北11］.oud2",
        "oud-s0",
        "oud-s20",
        "arrival",
      ],
    ] as const) {
      const p = parseOud2(readFileSync(new URL(file, base), "utf8")).project;
      const selections = [
        {
          datasetId: "benchmark",
          project: p,
          timetableId: p.timetables[0].id,
          passengerOnly: false,
        },
      ];
      const q: RouteQuery = {
        origin: { datasetId: "benchmark", stationId: o },
        destination: { datasetId: "benchmark", stationId: d },
        time: 25200,
        mode: "depart",
        maxTransfers: 2,
        minimumTransferSeconds: 120,
        directOnly: false,
        sort,
        limit: 6,
      };
      const heap0 = process.memoryUsage().heapUsed,
        t0 = performance.now(),
        beforeIndex = oldBuild(selections),
        t1 = performance.now(),
        before = oldSearch(beforeIndex, q),
        t2 = performance.now(),
        heap1 = process.memoryUsage().heapUsed;
      const afterIndex = buildRoutingIndex(selections),
        t3 = performance.now(),
        after = searchJourneys(afterIndex, q),
        t4 = performance.now(),
        heap2 = process.memoryUsage().heapUsed;
      expect(after.journeys).toEqual(before.journeys);
      expect(after.candidateCount).toBe(before.candidateCount);
      records.push({
        file,
        sort,
        before: {
          buildMs: t1 - t0,
          searchMs: t2 - t1,
          heapDelta: heap1 - heap0,
        },
        after: {
          buildMs: t3 - t2,
          searchMs: t4 - t3,
          heapDelta: heap2 - heap1,
        },
        sameResults: true,
      });
    }
    mkdirSync("artifacts", { recursive: true });
    const report = {
      node: process.version,
      note: "Single local run; heap deltas include garbage collection and are not peak memory.",
      records,
    };
    writeFileSync(
      "artifacts/performance-comparison.json",
      JSON.stringify(report, null, 2),
    );
    console.log(
      JSON.stringify(
        records.map((r) => ({
          file: r.file,
          sort: r.sort,
          beforeMs: Math.round(r.before.searchMs),
          afterMs: Math.round(r.after.searchMs),
        })),
      ),
    );
  },
  120000,
);

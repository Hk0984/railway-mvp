import { expect, it } from "vitest";
import { parseOud2 } from "../src/oud2";
import {
  buildRoutingIndex,
  searchJourneys,
  validateJourney,
} from "../src/routing";
import type { RouteQuery } from "../src/routing-model";

const feeder = `Ressya.
Syubetsu=0
Ressyabangou=101
EkiJikoku=1;700$1,1;703/$1
Operation1A=5/$2
.
`;
const detached = `Ressya.
Syubetsu=0
Ressyabangou=103
EkiJikoku=,,1;712$1,1;715/$1
Operation2B=5/$
.
`;

function fixture(portion = detached) {
  const { project } = parseOud2(`FileType=OuDiaSecond.1.17
Rosen.
Rosenmei=編成直通の検証
${["甲", "乙", "丙", "丁", "戊"].map((name) => `Eki.\nEkimei=${name}\n.\n`).join("")}Ressyasyubetsu.
Syubetsumei=普通
.
Dia.
DiaName=平日
Kudari.
${feeder}Ressya.
Syubetsu=0
Ressyabangou=102
EkiJikoku=,1;705$1,1;710/711$1,2,1;720/$1
Operation1B=1/1$704
Operation1B.0B=5/$
Operation2B=2/0$1/71030
Operation2B.0A=5/$2
.
${portion}Ressya.
Syubetsu=0
Ressyabangou=104
EkiJikoku=,,,1;717$2,1;719/$1
.
.
.
.
`);
  const ref = (i: number) => ({ datasetId: "rail", stationId: `oud-s${i}` });
  const query: RouteQuery = {
    origin: ref(0),
    destination: ref(3),
    stationPath: [0, 1, 2, 3].map(ref),
    mode: "depart",
    time: 7 * 3600,
    maxTransfers: 0,
    minimumTransferSeconds: 600,
    directOnly: true,
    sort: "arrival",
    formationContinuations: true,
  };
  project.serviceClasses = {
    trains: {},
    types: { "0": { state: "passenger", basis: "検証" } },
  };
  return {
    project,
    ref,
    query,
    index: buildRoutingIndex([
      { project, datasetId: "rail", timetableId: "oud-dia0" },
    ]),
  };
}

it("keeps a passenger aboard through coupling and uncoupling in a direct search", () => {
  const { index, query } = fixture();
  expect(
    searchJourneys(index, { ...query, formationContinuations: false }).journeys,
  ).toEqual([]);
  const {
    journeys: [journey],
  } = searchJourneys(index, query);
  expect(
    journey.legs.map((leg) => [leg.trainNumber, leg.continuation]),
  ).toEqual([
    ["101", undefined],
    ["102", "couple"],
    ["103", "split"],
  ]);
  expect(journey.transferCount).toBe(0);
  expect(journey.ridingSeconds).toBe(900);
  expect(journey.transfers).toEqual([]);
  expect(validateJourney(index, query, journey)).toEqual([]);
  expect(
    searchJourneys(index, {
      ...query,
      mode: "arrive",
      time: 7 * 3600 + 15 * 60,
    }).journeys[0],
  ).toEqual(journey);
  expect(
    validateJourney(
      index,
      { ...query, formationContinuations: false },
      journey,
    ),
  ).not.toEqual([]);
});

it("counts and times a real transfer after through travel", () => {
  const { index, query, ref } = fixture();
  const withTransfer = {
    ...query,
    directOnly: false,
    maxTransfers: 1,
    minimumTransferSeconds: 90,
    destination: ref(4),
    stationPath: [0, 1, 2, 3, 4].map(ref),
  };
  const {
    journeys: [journey, staying],
  } = searchJourneys(index, withTransfer);
  expect(journey.legs.map((leg) => leg.trainNumber)).toEqual([
    "101",
    "102",
    "103",
    "104",
  ]);
  expect(journey.transferCount).toBe(1);
  expect(journey.transferWaitSeconds).toBe(120);
  expect(validateJourney(index, withTransfer, journey)).toEqual([]);
  expect(staying.legs.map((leg) => leg.trainNumber)).toEqual(["101", "102"]);
  expect(staying.transferCount).toBe(0);
});

it.each([
  ["a different platform", detached.replace("712$1", "712$2")],
  ["two otherwise matching trains", detached + detached.replace("103", "105")],
  ["a missing boundary operation", detached.replace("Operation2B=5/$\n", "")],
])("avoids inferring a through service with %s", (_name, portion) => {
  const { index, query } = fixture(portion);
  expect(searchJourneys(index, query).journeys).toEqual([]);
});

it("does not continue into a non-passenger portion", () => {
  const { project, query } = fixture();
  project.serviceClasses!.trains['["oud-dia0","oud-0-Kudari-2"]'] = {
    state: "nonPassenger",
    basis: "検証",
  };
  const index = buildRoutingIndex([
    { project, datasetId: "rail", timetableId: "oud-dia0" },
  ]);
  expect(searchJourneys(index, query).journeys).toEqual([]);
});

import { expect, it } from "vitest";
import { trainVisits } from "../src/analysis";
import { defaultAssignmentConfig } from "../src/assignment-model";
import { trainClassKey } from "../src/classification";
import { assignRailwayDiagram } from "../src/diagram-capacity";
import { diagramTrains } from "../src/diagram-model";
import { validateProject } from "../src/model";
import { parseOud2 } from "../src/oud2";
import { buildRoutingIndex } from "../src/routing";
import { formationProfile } from "../src/train-formation";

function fixture() {
  const { project } = parseOud2(`FileType=OuDiaSecond.1.17
Rosen.
Rosenmei=検証線
Eki.
Ekimei=甲
.
Eki.
Ekimei=乙
.
Eki.
Ekimei=丙
.
Eki.
Ekimei=丁
.
Ressyasyubetsu.
Syubetsumei=普通
.
Dia.
DiaName=平日
Kudari.
Ressya.
Syubetsu=0
EkiJikoku=1;700$0,1;709/711$0,1;719/721$0,1;730/$0
Operation0B=3/659$/01K
Operation1A=1/0$710
Operation1A.0B=3/708$/02R
Operation2B=2/0$1/720
Operation2B.0A=3/722$
.
.
.
.
`);
  project.datasetId = "formation";
  project.serviceClasses = {
    types: { "0": { state: "passenger", basis: "検証" } },
    trains: {},
  };
  project.capacitySettings = {
    formationSource: "operation",
    operationGroups: {
      "**K": { value: 600, carCount: 4, kind: "transport", basis: "検証" },
      "**R": { value: 300, carCount: 2, kind: "transport", basis: "検証" },
    },
    timetables: {},
    trains: {},
    types: {},
  };
  const [dia] = project.timetables;
  const [train] = dia.trains;
  return { project, dia, train };
}

it("uses component settings through coupling and uncoupling, and preserves nested station operations", () => {
  const { project, dia, train } = fixture();
  expect(
    train.operations?.find((work) => work.code === 1)?.children?.[0].raw,
  ).toBe("3/708$/02R");
  expect(
    train.operations?.find((work) => work.code === 2)?.children?.[0].raw,
  ).toBe("3/722$");
  expect(formationProfile(project, dia.id, train, trainVisits(train))).toEqual([
    { capacity: 600, carCount: 4 },
    { capacity: 900, carCount: 6 },
    { capacity: 600, carCount: 4 },
  ]);
  validateProject(JSON.parse(JSON.stringify(project)));
});

it("uses each section's capacity in the haze and reserves space through the uncoupling stop", () => {
  const { project, dia, train } = fixture();
  project.capacitySettings!.formationSections = {
    [trainClassKey(dia.id, train.id)]: {
      "oud-p2": { capacity: 120, carCount: 2 },
    },
  };
  const index = buildRoutingIndex([
    { project, datasetId: "formation", timetableId: dia.id },
  ]);
  const result = assignRailwayDiagram(
    index,
    [
      {
        datasetId: "formation",
        origin: "oud-s0",
        destination: "oud-s3",
        purpose: "commute",
        kind: "outbound",
        source: "manual",
        passengers: 400,
        start: 24900,
        end: 25140,
      },
    ],
    { ...defaultAssignmentConfig(), start: 24900, end: 25140 },
    100,
  );
  expect(result.loads[0].segmentCapacities).toEqual([600, 900, 120]);
  expect(result.loads[0].segmentLoads).toEqual([120, 120, 120]);
  expect(
    diagramTrains(project, dia.id, result)[0]
      .segments.filter((segment) => segment.kind === "run")
      .map((segment) => segment.percent),
  ).toEqual([20, (120 / 900) * 100, 100]);
});

it("leaves the section after an unidentified uncoupling unset until configured", () => {
  const { project, dia, train } = fixture();
  train.operations!.find((op) => op.code === 2)!.raw = "2/2$1/720";
  const visits = trainVisits(train);
  expect(formationProfile(project, dia.id, train, visits)?.[2]).toEqual({
    capacity: undefined,
    carCount: undefined,
  });

  project.capacitySettings!.formationSections = {
    [trainClassKey(dia.id, train.id)]: {
      "oud-p2": { capacity: 300, carCount: 2 },
    },
  };
  expect(formationProfile(project, dia.id, train, visits)?.[2]).toEqual({
    capacity: 300,
    carCount: 2,
  });
});

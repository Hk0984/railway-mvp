import { describe, expect, it } from "vitest";
import { trainClassKey } from "../src/classification";
import { defaultLineDemand } from "../src/line-demand";
import { validateProject } from "../src/model";
import { sampleProject } from "../src/sample";
import {
  sameStationOrder,
  transferTimetableSettings,
} from "../src/timetable-settings-transfer";

describe("timetable settings transfer", () => {
  it("uses current services and maps settings by type, timetable and train identity", () => {
    const old = sampleProject();
    const [local, rapid, unnumbered] = old.timetables[0].trains;
    unnumbered.number = "";
    old.timetables[0].trains = [local, rapid, unnumbered];
    const oldRapid = trainClassKey("weekday", rapid.id);
    const oldUnnumbered = trainClassKey("weekday", unnumbered.id);
    old.lineDemand = defaultLineDemand(true);
    old.lineDemand.outside = [
      {
        id: "outside",
        name: "路線外",
        stationId: "s0",
        inbound: 650,
        outbound: 0,
        mode: "through",
        included: false,
        trains: {
          weekday: { inbound: [rapid.id, unnumbered.id], outbound: [] },
        },
      },
    ];
    old.lineDemandByDay = { holiday: defaultLineDemand(true) };
    old.demandSelection = { day: "holiday", timetableId: "weekday" };
    old.serviceClasses!.trains = {
      [oldRapid]: { state: "passenger", basis: "列車別指定" },
      [oldUnnumbered]: { state: "nonPassenger", basis: "列車別指定" },
    };
    const capacity = {
      value: 550,
      kind: "transport",
      basis: "編成定員",
    } as const;
    old.types[1].carCount = 8;
    old.capacitySettings = {
      trains: { [oldRapid]: capacity },
      timetables: {},
      types: { rapid: capacity },
    };

    const current = sampleProject();
    current.serviceClasses = undefined;
    current.types[1].id = "new-rapid";
    current.types[1].diagramColor = "#cc0000";
    current.timetables = [
      {
        ...old.timetables[0],
        id: "revised",
        trains: [
          { ...local, id: rapid.id },
          {
            ...rapid,
            id: "revised-rapid",
            typeId: "new-rapid",
            stops: rapid.stops.map((stop) => ({
              ...stop,
              arrival:
                stop.arrival === undefined ? undefined : stop.arrival + 120,
              departure:
                stop.departure === undefined ? undefined : stop.departure + 120,
            })),
          },
        ],
      },
    ];
    validateProject(current);
    validateProject(old);
    const { project, skipped } = transferTimetableSettings(current, old);

    const newRapid = trainClassKey("revised", "revised-rapid");
    expect(sameStationOrder(current, old)).toBe(true);
    expect(project.timetables).toEqual(current.timetables);
    expect(project.demandSelection).toEqual({
      day: "holiday",
      timetableId: "revised",
    });
    expect(project.lineDemandByDay).toEqual(old.lineDemandByDay);
    expect(project.lineDemand!.outside[0].trains.revised.inbound).toEqual([
      "revised-rapid",
    ]);
    expect(project.serviceClasses!.trains).toEqual({
      [newRapid]: old.serviceClasses!.trains[oldRapid],
    });
    expect(project.capacitySettings!.trains).toEqual({ [newRapid]: capacity });
    expect(project.capacitySettings!.types).toEqual({ "new-rapid": capacity });
    expect(project.types[1]).toMatchObject({
      diagramColor: "#cc0000",
      carCount: 8,
    });
    expect(skipped).toBe(3);
    expect(() => validateProject(project)).not.toThrow();
  });

  it("requires the same stations in the same order", () => {
    const old = sampleProject();
    const reordered = { ...old, stations: [...old.stations].reverse() };
    expect(sameStationOrder(old, reordered)).toBe(false);
  });
});

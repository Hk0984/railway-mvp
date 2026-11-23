import { describe, it, expect } from "vitest";
import { parseOud2 } from "../src/oud2";
import { parseOudTime, decodeOud2 } from "../src/oud2-text";
import { directTrains, stationDepartures, trainVisits } from "../src/analysis";
import { timetableCosts } from "../src/demand";
import { validateProject } from "../src/model";
import { trainTypeColors } from "../src/train-type-colors";

function fixture({
  up = false,
  canceled = false,
  operation = "4/0$730/800$/N1",
  eki = "1;800/805$0,1;825/$0",
  branch = false,
} = {}) {
  return `FileType=OuDiaSecond.1.17\nRosen.\nRosenmei=検証線\nEki.\nEkimei=甲\nOuterTerminal.\nOuterTerminalEkimei=路線外A\n.\n.\nEki.\nEkimei=乙\n${branch ? "BrunchCoreEkiIndex=0\n" : ""}OuterTerminal.\nOuterTerminalEkimei=路線外B\n.\n.\nRessyasyubetsu.\nSyubetsumei=普通\n.\nDia.\nDiaName=試験\n${up ? "Nobori" : "Kudari"}.\nRessya.\nSyubetsu=0\n${canceled ? "Canceled=1\n" : ""}EkiJikoku=${eki}\nOperation0B=${operation}\n.\nRessya.\n.\n.\n.\nKitenJikoku=400\n.\nDispProp.\nJikokuhyouFont=A\nJikokuhyouFont=B\n.\n`;
}
describe("実ファイルで確認した書式の回帰", () => {
  it("round-trips separate OuDia2nd diagram and timetable colors", () => {
    const { project, warnings } = parseOud2(
      fixture().replace(
        "Syubetsumei=普通",
        "Syubetsumei=普通\nDiagramSenColor=0012CDef\nJikokuhyouMojiColor=00FE6100",
      ),
    );
    const copy = JSON.parse(JSON.stringify(project));
    expect(() => validateProject(copy)).not.toThrow();
    expect(trainTypeColors(copy.types).get("0")).toEqual({
      diagram: "#12cdef",
      timetable: "#fe6100",
    });
    expect(warnings.join("\n")).not.toMatch(
      /DiagramSenColor|JikokuhyouMojiColor/,
    );
    copy.types[0].diagramColor = "red;display:none";
    expect(() => validateProject(copy)).toThrow("種別色");
  });

  it("retains legacy files and uses the available color when only one is set", () => {
    const { project, warnings } = parseOud2(
      fixture().replace(
        "Syubetsumei=普通",
        "Syubetsumei=普通\nDiagramSenColor=invalid\nJikokuhyouMojiColor=00000000",
      ),
    );
    expect(warnings.join("\n")).toContain("色に未対応の書式");
    expect(trainTypeColors(project.types).get("0")).toEqual({
      diagram: "#000000",
      timetable: "#000000",
    });
    expect(parseOud2(fixture()).project.types[0]).toEqual({
      id: "0",
      name: "普通",
    });
  });

  it("keeps scoped external origins without adding OD stations", () => {
    const p = parseOud2(fixture()).project;
    const t = p.timetables[0].trains[0];
    expect(t.externalOrigin!.terminalId).toBe("oud-out-0-0");
    expect(t.externalOrigin!.externalTime).toBe(27000);
    expect(p.stations).toHaveLength(2);
    expect(p.oud2!.emptyColumns).toBe(1);
    expect(directTrains(p.timetables[0], "oud-s0", "oud-s1")[0].departure).toBe(
      29100,
    );
  });
  it("uses direction-order operation index for up trains", () => {
    const p = parseOud2(fixture({ up: true })).project;
    const t = p.timetables[0].trains[0];
    expect(t.externalOrigin!.terminalId).toBe("oud-out-1-0");
    expect(t.externalOrigin!.boundaryStationId).toBe("oud-s1");
  });
  it("records canceled trains but excludes them from all service metrics", () => {
    const p = parseOud2(fixture({ canceled: true })).project;
    expect(p.timetables[0].trains).toHaveLength(1);
    expect(p.timetables[0].trains[0].cancelled).toBe(true);
    expect(directTrains(p.timetables[0], "oud-s0", "oud-s1")).toEqual([]);
    expect(stationDepartures(p.timetables[0], "oud-s0", "", "")).toEqual([]);
    expect(timetableCosts(p, "oud-dia0")["oud-s0"]["oud-s1"]).toBeUndefined();
  });
  it("normalizes explicit times by a declared analysis start without editing source", () => {
    const p = parseOud2(
      fixture({ eki: "1;2358$0,1;005/$0", operation: "4/0$2330/2358$/N1" }),
    ).project;
    expect(p.timetables[0].trains[0].stops[1].arrival).toBe(86700);
    expect(p.timetables[0].trains[0].sourceEkiJikoku).toBe("1;2358$0,1;005/$0");
    expect(() =>
      parseOud2(fixture({ eki: "1;2358$0,1;005/$0" }), { serviceDayStart: 0 }),
    ).toThrow("時刻逆転");
    expect(parseOudTime("00130", 14400)).toBe(86490);
  });
  it("warns on conflicting explicit boundary times without correcting either", () => {
    const { project: p, warnings } = parseOud2(
      fixture({ operation: "4/0$730/801$/N1" }),
    );
    expect(warnings.some((w) => w.includes("不一致"))).toBe(true);
    expect(p.timetables[0].trains[0].externalOrigin!.boundaryTime).toBe(28860);
    expect(p.timetables[0].trains[0].stops[0].arrival).toBe(28800);
  });
  it("rejects foreign terminal references, nested operations, unknown fields and nonempty malformed columns", () => {
    for (const text of [
      fixture({ operation: "4/9$730/800$/N1" }),
      fixture().replace("Operation0B=", "Operation0B.0A="),
      fixture().replace("Syubetsu=0", "Syubetsu=0\nMysteryServiceRule=1"),
      fixture().replace("Ressya.\n.", "Ressya.\nHoukou=Kudari\n."),
      fixture({ operation: "1/0$755" }),
    ])
      expect(() => parseOud2(text)).toThrow();
  });
  it("preserves external metadata and rejects corrupt JSON endpoint IDs", () => {
    const p = parseOud2(fixture()).project;
    const copy = JSON.parse(JSON.stringify(p));
    expect(() => validateProject(copy)).not.toThrow();
    copy.timetables[0].trains[0].externalOrigin.terminalId = "absent";
    expect(() => validateProject(copy)).toThrow();
  });
  it("detects UTF-8 and rejects undecodable bytes and semantic duplicate keys", () => {
    expect(decodeOud2(new TextEncoder().encode(fixture())).encoding).toBe(
      "utf-8",
    );
    expect(() => decodeOud2(Uint8Array.of(0xff), "utf-8")).toThrow();
    expect(() =>
      parseOud2(fixture().replace("Syubetsu=0", "Syubetsu=0\nSyubetsu=1")),
    ).toThrow("重複");
  });
  it("keeps duplicate equal train options effective", () => {
    const p = parseOud2(fixture()).project;
    const t = structuredClone(p.timetables[0].trains[0]);
    t.id = "equal";
    p.timetables[0].trains.push(t);
    expect(
      directTrains(p.timetables[0], "oud-s0", "oud-s1").map((r) => r.effective),
    ).toEqual([true, true]);
    expect(trainVisits(t)).toHaveLength(2);
  });
});

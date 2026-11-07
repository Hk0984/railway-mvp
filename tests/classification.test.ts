import { describe, it, expect } from "vitest";
import { sampleProject } from "../src/sample";
import { validateProject } from "../src/model";
import {
  serviceClass,
  isPassengerTrain,
  trainClassKey,
  classificationCounts,
} from "../src/classification";
import {
  cachedRoutingIndex,
  invalidateRoutingCache,
} from "../src/routing-cache";
import { buildRoutingIndex } from "../src/routing";
describe("営業区分・キャッシュ互換性", () => {
  it("treats legacy missing classifications as review without guessing from names", () => {
    const p = sampleProject();
    delete p.serviceClasses;
    p.types[0].name = "普通";
    expect(() => validateProject(p)).not.toThrow();
    expect(classificationCounts(p, "weekday").review).toBe(72);
    expect(
      buildRoutingIndex([
        { datasetId: "x", project: p, timetableId: "weekday" },
      ]).trips.size,
    ).toBe(0);
  });
  it("preserves decisions after type renaming and supports timetable-scoped overrides", () => {
    const p = sampleProject();
    p.serviceClasses!.types.local = {
      state: "nonPassenger",
      basis: "手動設定",
    };
    p.types[0].name = "旅客列車に見える名称";
    const t = p.timetables[0].trains[0];
    expect(isPassengerTrain(p, "weekday", t)).toBe(false);
    p.serviceClasses!.trains[trainClassKey("weekday", t.id)] = {
      state: "passenger",
      basis: "個別に営業と確認",
    };
    expect(isPassengerTrain(p, "weekday", t)).toBe(true);
    expect(serviceClass(p, "other-dia", t).state).toBe("nonPassenger");
    expect(() => validateProject(JSON.parse(JSON.stringify(p)))).not.toThrow();
  });
  it("reuses indexes and invalidates eligibility after policy changes", () => {
    const p = sampleProject(),
      s = [{ datasetId: "x", project: p, timetableId: "weekday" }];
    const a = cachedRoutingIndex(s);
    expect(cachedRoutingIndex(s)).toBe(a);
    p.serviceClasses!.types.local = {
      state: "nonPassenger",
      basis: "確認結果を更新",
    };
    const b = cachedRoutingIndex(s);
    expect(b).not.toBe(a);
    expect(b.trips.size).toBeLessThan(a.trips.size);
    invalidateRoutingCache(p);
    expect(cachedRoutingIndex(s)).not.toBe(b);
  });
  it("refuses corrupt classification IDs, missing reasons and invalid type capacities", () => {
    const p = sampleProject();
    p.serviceClasses!.types.absent = { state: "passenger", basis: "不正参照" };
    expect(() => validateProject(p)).toThrow();
    delete p.serviceClasses!.types.absent;
    p.typeCapacities = { local: -10 };
    expect(() => validateProject(p)).toThrow();
  });
});

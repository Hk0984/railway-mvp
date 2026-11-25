import type { Project, Train } from "./model";
import { previousOperationTrain } from "./operation-connections";

/** Extract the numbers explicitly recorded on this train. */
export function operationNumbers(p: Project, t: Train): string[] {
  if (t.operationNumbers !== undefined) return [...new Set(t.operationNumbers)];
  return [
    ...new Set(
      (t.operations ?? []).flatMap((op) => stationOperationNumbers(p, op)),
    ),
  ];
}

export function stationOperationNumbers(
  p: Project,
  op: NonNullable<Train["operations"]>[number],
) {
  const legacy = p.oud2?.fileType === "OuDiaSecond.1.07";
  const fields = op.raw.split("$");
  let value = "";
  if ((op.code === 3 || op.code === 4) && op.phase === "before") {
    const raw = fields[op.code === 3 ? 1 : 2] ?? "";
    value = legacy
      ? raw
      : raw.includes("/")
        ? raw.slice(raw.indexOf("/") + 1)
        : "";
  } else if (op.code === 5 && op.phase === "before") {
    const raw = fields[1] ?? "";
    value = legacy && /^[01]\//.test(raw) ? raw.slice(2) : raw;
  } else if (op.code === 6) value = op.raw.slice(2);
  return value
    .split(";")
    .map((v) => v.trim())
    .filter(Boolean);
}
export function operationPattern(number: string) {
  const mask = number
    .trim()
    .replace(/([\\*])/g, "\\$1")
    .replace(/\p{Nd}+/gu, "**")
    .replace(/[a-z]/g, (letter) => letter.toUpperCase());
  return isOperationPattern(mask) ? mask : null;
}

export function isOperationPattern(mask: string) {
  return (
    mask.includes("**") &&
    mask !== "**" &&
    /^(?:\*\*|\\[\\*]|[^\p{Nd}\p{C}\s\\*])+$/u.test(mask)
  );
}

export function operationGroup(p: Project, t: Train, legacy = false) {
  let numbers = operationNumbers(p, t);
  let inheritedFrom: Train | undefined;
  if (
    numbers.length === 0 &&
    t.operationNumbers === undefined &&
    t.operations?.some(({ phase, code }) => phase === "before" && code === 5)
  ) {
    const seen = new Set([t]);
    let current = t;
    while (!current.operations?.some(({ code }) => code === 6)) {
      const previous = previousOperationTrain(p, current);
      if (!previous || seen.has(previous)) break;
      seen.add(previous);
      numbers = operationNumbers(p, previous);
      if (numbers.length > 0 || previous.operationNumbers !== undefined) {
        if (numbers.length === 1) inheritedFrom = previousOperationTrain(p, t);
        else numbers = [];
        break;
      }
      current = previous;
    }
  }
  if (numbers.length !== 1)
    return {
      numbers,
      group: null,
      inheritedFrom,
      reason: numbers.length
        ? "複数の運用番号・変更があります。記号定員の自動適用なし"
        : "運用番号未確定",
    };
  const letters = legacy ? numbers[0].match(/[A-Za-z]+/g) : undefined;
  const group = legacy
    ? letters?.length === 1
      ? letters[0].toUpperCase()
      : null
    : operationPattern(numbers[0]);
  return {
    numbers,
    group,
    inheritedFrom,
    reason: group
      ? inheritedFrom
        ? "前列車から運用番号を継承"
        : "明示運用番号から分類"
      : "運用番号のグループを特定できません",
  };
}

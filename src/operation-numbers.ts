import type { Project, Train } from "./model";
/** Only explicit values in this record. No train-number or cross-record inference. */
export function operationNumbers(p: Project, t: Train): string[] {
  if (t.operationNumbers !== undefined) return [...new Set(t.operationNumbers)];
  const legacy = p.oud2?.fileType === "OuDiaSecond.1.07",
    values: string[] = [];
  for (const op of t.operations ?? []) {
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
    values.push(
      ...value
        .split(";")
        .map((v) => v.trim())
        .filter(Boolean),
    );
  }
  return [...new Set(values)];
}
export function operationGroup(p: Project, t: Train) {
  const numbers = operationNumbers(p, t);
  if (numbers.length !== 1)
    return {
      numbers,
      group: null,
      reason: numbers.length
        ? "複数の運用番号・変更があります。記号定員の自動適用なし"
        : "明示運用番号なし（別列車からは推測しません）",
    };
  const letters = numbers[0].match(/[A-Za-z]+/g);
  return {
    numbers,
    group: letters?.length === 1 ? letters[0].toUpperCase() : null,
    reason:
      letters?.length === 1
        ? "明示運用番号の英字記号"
        : "英字記号を一意に特定できません",
  };
}

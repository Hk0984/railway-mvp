export interface OudNode {
  name: string;
  values: Record<string, string>;
  children: OudNode[];
  line: number;
}
/** Repeated display arrays are legal. Repeated semantic fields are never silently overwritten. */
const repeatedDisplay = new Set([
  "JikokuhyouFont",
  "DiaBackColor",
  "JikokuhyouBackColor",
]);
export function parseOudText(text: string): OudNode {
  const root: OudNode = { name: "root", values: {}, children: [], line: 0 };
  const stack = [root];
  for (const [i, raw] of text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .entries()) {
    const line = raw.trim();
    if (!line) continue;
    if (line === ".") {
      if (stack.length === 1) throw new Error(`${i + 1}行: 余分なブロック終端`);
      stack.pop();
      continue;
    }
    const parent = stack.at(-1)!;
    const eq = line.indexOf("=");
    if (eq >= 0) {
      const key = line.slice(0, eq);
      if (
        Object.hasOwn(parent.values, key) &&
        !(parent.name === "DispProp" && repeatedDisplay.has(key))
      )
        throw new Error(`${i + 1}行: 重複項目 ${key}`);
      parent.values[key] = line.slice(eq + 1);
      continue;
    }
    if (!/^[A-Za-z][A-Za-z0-9]*\.$/.test(line))
      throw new Error(`${i + 1}行: 不明な構文`);
    const node: OudNode = {
      name: line.slice(0, -1),
      values: {},
      children: [],
      line: i + 1,
    };
    parent.children.push(node);
    stack.push(node);
  }
  if (stack.length !== 1) throw new Error("未閉鎖のブロックがあります");
  return root;
}
export function decodeOud2(bytes: Uint8Array, encoding = "auto") {
  const candidates = encoding === "auto" ? ["utf-8", "shift_jis"] : [encoding];
  for (const candidate of candidates) {
    try {
      return {
        text: new TextDecoder(candidate, { fatal: true }).decode(bytes),
        encoding: candidate,
      };
    } catch {}
  }
  throw new Error(`${encoding}: ファイルを文字コードに従って復号できません`);
}
export function parseOudTime(
  raw: string | undefined,
  serviceDayStart = 0,
): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (!/^\d{3,6}$/.test(raw))
    throw new Error(`時刻はHMM・HHMM・HMMSS・HHMMSSが必要: ${raw}`);
  const s =
    raw.length <= 4 ? raw.padStart(4, "0") + "00" : raw.padStart(6, "0");
  const h = Number(s.slice(0, 2)),
    m = Number(s.slice(2, 4)),
    sec = Number(s.slice(4));
  if (h > 47 || m > 59 || sec > 59) throw new Error(`時刻範囲外: ${raw}`);
  const t = h * 3600 + m * 60 + sec;
  return t < serviceDayStart ? t + 86400 : t;
}

// Read-only inventory of local reference files. Treat every file value as data.
import { readFileSync, readdirSync } from "node:fs";
const directory = new URL("../tests/fixtures/real/", import.meta.url);
for (const file of readdirSync(directory).filter((f) => f.endsWith(".oud2"))) {
  const bytes = readFileSync(new URL(file, directory));
  let text, encoding;
  for (const candidate of ["utf-8", "shift_jis"]) {
    try {
      text = new TextDecoder(candidate, { fatal: true }).decode(bytes);
      encoding = candidate;
      break;
    } catch {}
  }
  if (text === undefined)
    throw new Error(`${file}: UTF-8 / Shift_JISとして復号できません`);
  const stack = [];
  const blocks = {},
    fields = {};
  const samples = {};
  const stations = [];
  const dias = [];
  const operations = [];
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line) continue;
    if (line === ".") {
      stack.pop();
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) {
      if (line.endsWith(".")) {
        const name = line.slice(0, -1);
        stack.push(name);
        blocks[name] = (blocks[name] ?? 0) + 1;
      }
      continue;
    }
    const key = line.slice(0, eq),
      value = line.slice(eq + 1),
      parent = stack.at(-1) ?? "root";
    const path = `${parent}.${key}`;
    fields[path] = (fields[path] ?? 0) + 1;
    (samples[path] ??= new Set()).add(value);
    if (key === "Ekimei") stations.push(value);
    if (key === "DiaName") dias.push(value);
    if (/^Operation/.test(key) && parent === "Ressya")
      operations.push({ line: i + 1, key, value });
  }
  console.log(
    JSON.stringify(
      {
        file,
        encoding,
        bytes: bytes.length,
        blocks,
        stations,
        dias,
        fields,
        samples: Object.fromEntries(
          Object.entries(samples)
            .filter(([k]) => !k.endsWith("EkiJikoku"))
            .map(([k, v]) => [k, [...v].slice(0, 6)]),
        ),
        operations: operations.slice(0, 18),
        operationTypes: [
          ...new Set(
            operations.flatMap((o) =>
              o.value.split(",").map((v) => v.split("/")[0]),
            ),
          ),
        ],
      },
      null,
      2,
    ),
  );
}

export const escapeHtml = (v: unknown) =>
  String(v).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export const numberText = (n: number | null | undefined, d = 1) =>
  n == null
    ? "—"
    : (Math.abs(n) < 0.5 * 10 ** -d ? 0 : n).toLocaleString("ja-JP", {
        maximumFractionDigits: d,
      });
export function parseClock(s: string) {
  if (!/^\d{1,3}:[0-5]\d(?::[0-5]\d)?$/.test(s))
    throw new Error("時刻はHH:MM（24時以降も可）で入力してください");
  const [h, m, sec = 0] = s.split(":").map(Number);
  return h * 3600 + m * 60 + sec;
}
export interface UIContext {
  project: import("./model").Project;
  diaId: string;
  projects: import("./model").Project[];
  links: import("./routing-model").TransferLink[];
  save: () => void;
  render: () => void;
  activate: (id: string) => void;
  message: (s: string) => void;
}

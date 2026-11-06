import { validateProject, type Project } from "./model";
import { validateWorkspace, type Workspace } from "./workspace";
const revisions = new Map<string, number>();
async function saveValue(key: string, value: unknown) {
  const revision = (revisions.get(key) ?? 0) + 1;
  revisions.set(key, revision);
  const text = JSON.stringify(value);
  if (text.length < 100000) {
    localStorage.setItem(key, text);
    return;
  }
  const stream = new Blob([text])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 16384)
    binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
  if (revisions.get(key) === revision)
    localStorage.setItem(
      key,
      JSON.stringify({ codec: "gzip-base64", data: btoa(binary) }),
    );
}
async function loadValue(key: string) {
  const stored = localStorage.getItem(key);
  if (!stored) return null;
  let value = JSON.parse(stored);
  if (value?.codec === "gzip-base64") {
    const bytes = Uint8Array.from(atob(value.data), (c) => c.charCodeAt(0));
    const stream = new Blob([bytes])
      .stream()
      .pipeThrough(new DecompressionStream("gzip"));
    value = JSON.parse(await new Response(stream).text());
  }
  return value;
}
export const saveProject = (p: Project) => saveValue("railway-lab-v1", p);
export const saveWorkspace = (w: Workspace) =>
  saveValue("railway-workspace-v1", w);
export async function loadProject(): Promise<Project | null> {
  const p = await loadValue("railway-lab-v1");
  if (p) validateProject(p);
  return p;
}
export async function loadWorkspace(): Promise<Workspace | null> {
  const w = await loadValue("railway-workspace-v1");
  if (w) validateWorkspace(w);
  return w;
}

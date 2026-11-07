import { validateProject, type Project } from "./model";
import type { TransferLink } from "./routing-model";
import { validateTransferLinks } from "./routing";
import { validateIntegration, type IntegrationState } from "./network-model";
export interface Workspace {
  integration?: IntegrationState;
  schemaVersion: 1;
  projects: Project[];
  activeDatasetId: string;
  transferLinks: TransferLink[];
}
export const workspace: Workspace = {
  schemaVersion: 1,
  projects: [],
  activeDatasetId: "",
  transferLinks: [],
};
export function registerProject(p: Project) {
  p.datasetId ??= crypto.randomUUID();
  validateProject(p);
  const i = workspace.projects.findIndex((x) => x.datasetId === p.datasetId);
  if (i >= 0) workspace.projects[i] = p;
  else workspace.projects.push(p);
  workspace.activeDatasetId = p.datasetId;
}
export function validateWorkspace(w: Workspace) {
  if (
    !w ||
    w.schemaVersion !== 1 ||
    !Array.isArray(w.projects) ||
    !w.projects.length ||
    !Array.isArray(w.transferLinks) ||
    typeof w.activeDatasetId !== "string"
  )
    throw new Error("ワークスペースの保存形式が不正です");
  w.projects.forEach(validateProject);
  if (
    w.projects.some((p) => !p.datasetId) ||
    new Set(w.projects.map((p) => p.datasetId)).size !== w.projects.length ||
    !w.projects.some((p) => p.datasetId === w.activeDatasetId)
  )
    throw new Error("ワークスペースのデータセットID不正");
  validateTransferLinks(
    w.transferLinks,
    w.projects.map((project) => ({ project, datasetId: project.datasetId! })),
  );
  if (w.integration) validateIntegration(w.integration, w.projects);
}

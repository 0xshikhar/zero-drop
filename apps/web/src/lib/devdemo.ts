/**
 * DEV ONLY. Loads a local demo identity from .local/demo-members.<deployment>.json (gitignored; written by
 * scripts/seed-group.ts). This module is only ever reached through a dynamic import behind
 * `import.meta.env.DEV`, so a production build contains neither this code nor the file contents.
 */
import { deserializeIdentity } from "@zerodrop/core";

const files = import.meta.glob<{ groupId?: string; members?: string[] }>("../../../../.local/demo-members.*.json", {
  eager: true,
  import: "default",
});

export function loadDemoIdentity(deploymentId: string, index = 0) {
  const entry = Object.entries(files).find(([path]) => path.endsWith(`demo-members.${deploymentId}.json`));
  if (!entry) throw new Error(`No .local/demo-members.${deploymentId}.json found. Run scripts/seed-group.ts for this deployment.`);
  const member = entry[1].members?.[index];
  if (!member) throw new Error(`Demo file has no member at index ${index}.`);
  return deserializeIdentity(member);
}

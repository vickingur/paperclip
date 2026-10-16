import { readFile } from "node:fs/promises";
import type { RunnerApi } from "./api.js";
import { PLAN_SKILLS, planHash, type PlanVariant } from "./plan-task-cases.js";

type SkillApi = Pick<RunnerApi, "get" | "post">;
export type PlanSkillSource = {
  originalKey: string; key: string; id: string; sourcePath: string;
  versionId: string; sha256: string; bytes: number; words: number; selected: boolean;
};

/** Bundled/catalog files are read-only and core inventory is automatically
 * restored. Editable company copies preserve the source bytes and names;
 * selection, rather than deletion, implements the unassigned control. */
export async function preparePlanSkills(api: SkillApi, companyId: string, variant: PlanVariant) {
  const company = `/api/companies/${companyId}`;
  const skills: PlanSkillSource[] = [];
  for (const skill of PLAN_SKILLS) {
    const relative = variant === "current" ? skill.current : skill.short;
    const content = await readFile(new URL(`../../${relative}`, import.meta.url), "utf8");
    const name = skill.key.split("/").at(-1)!;
    const created = await api.post<{ id: string; key: string; sourceType: string }>(`${company}/skills`, {
      name, slug: `eval-${name}`, markdown: content, sharingScope: "company",
    });
    if (created.sourceType !== "local_path") throw new Error("Planning fixture did not create an editable company skill");
    const served = await api.get<{ content: string; editable: boolean }>(`${company}/skills/${created.id}/files?path=SKILL.md`);
    if (!served.editable || planHash(served.content) !== planHash(content)) throw new Error(`Served skill differs from editable source ${relative}`);
    const version = await api.get<{ currentVersionId: string | null }>(`${company}/skills/${created.id}`);
    if (!version.currentVersionId) throw new Error("Planning guidance has no frozen version");
    skills.push({ versionId: version.currentVersionId, originalKey: skill.key, key: created.key, id: created.id, sourcePath: relative,
      sha256: planHash(content), bytes: Buffer.byteLength(content), words: content.split(/\s+/).filter(Boolean).length,
      selected: variant !== "disabled" });
  }
  return skills;
}

export async function selectPlanSkills(api: SkillApi & Pick<RunnerApi, "patch">, companyId: string, agentId: string, sources: PlanSkillSource[]) {
  // The live flow and API calibration must select the same immutable bytes.
  const selected = sources.filter(s => s.selected).map(s => ({ key: s.key, versionId: s.versionId }));
  if (selected.length) {
    await api.patch("/api/instance/settings/experimental", { enableBetaSkills: true });
  }
  await api.post(`/api/agents/${agentId}/skills/sync?companyId=${companyId}`, { desiredSkills: selected, mode: "replace" });
  return verifyPlanSelection(api, companyId, agentId, sources);
}

export async function verifyPlanSelection(api: Pick<RunnerApi, "get">, companyId: string, agentId: string, sources: PlanSkillSource[]) {
  const selected = sources.filter(s => s.selected).map(s => s.key);
  const snapshot = await api.get<{ desiredSkills: string[]; desiredSkillEntries: { key: string; versionId: string | null }[] }>(`/api/agents/${agentId}/skills?companyId=${companyId}`);
  if (JSON.stringify([...(snapshot.desiredSkills ?? [])].sort()) !== JSON.stringify([...selected].sort())) {
    throw new Error("Planning skill selection differs from selected variant; comparison is uncomparable");
  }
  const pins = new Map((snapshot.desiredSkillEntries ?? []).map(s => [s.key, s.versionId]));
  if (pins.size !== selected.length || sources.filter(s => s.selected).some(s => pins.get(s.key) !== s.versionId)) {
    throw new Error("Planning skill version selection differs from frozen guidance; comparison is uncomparable");
  }
  return snapshot;
}

export async function verifyPlanSkills(api: Pick<RunnerApi, "get">, companyId: string, sources: PlanSkillSource[]) {
  for (const skill of sources) {
    const served = await api.get<{ content: string }>(`/api/companies/${companyId}/skills/${skill.id}/files?path=SKILL.md`);
    if (planHash(served.content) !== skill.sha256) throw new Error("Planning guidance changed during execution; comparison is uncomparable");
  }
}

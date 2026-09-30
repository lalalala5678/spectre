/**
 * Skill layer on pi's OFFICIAL skill system:
 *   storage  — host directory tree, agentskills.io format (SKILL.md with
 *              frontmatter name/description, or root .md with frontmatter)
 *   loading  — official loadSkills(env, dirs): per-agentKey directory is
 *              the mount unit ("only YOUR skills, no pollution")
 *   indexing — official formatSkillsForSystemPrompt(): the model sees a
 *              compact index (name/description/location) and reads the
 *              full file ON DEMAND via the official read tool — the
 *              dynamic-load pattern, not prompt-dumping.
 *
 * Sync into the sandbox: skills are bind-mounted (/opt/skills) so the
 * official read tool resolves skill file paths inside the same env the
 * bash tool runs in. For the local driver the host path IS the path.
 */
import { loadSkills } from '@earendil-works/pi-agent-core';

import { HOST, CONTAINER, containerPathToHost, makeExecutionEnv }
  from './exec-env.mjs';

/** Mounted-skills registry: agentKey → Skill[] (official Skill objects).
 *  Rebuilt on config change; sessions snapshot at creation time. */
let mounted = new Map();

/** Rebuild the per-agent skill mount cache from the host tree.
 *  Layout: HOST.skills/<agentKey>/<skill-name>/SKILL.md (or .md files). */
export async function refreshSkillMounts(agentKeys, sandboxCfg) {
  const env = makeExecutionEnv(sandboxCfg ?? { driver: 'local' }, '_');
  const next = new Map();
  for (const key of agentKeys) {
    const dir = `${CONTAINER.skills}/${key}`;
    const hostDir = containerPathToHost(dir);
    const { skills } = await loadSkills(env, [dir]);
    // P1-A(五审): frontmatter 损坏的 SKILL.md 此前被官方 loader 静默
    // 丢弃(exploit 5 技能只挂 1)——对账目录文件数, 丢弃即告警。
    try {
      const files = await (await import('node:fs/promises'))
        .readdir(hostDir, { withFileTypes: true });
      const dirs = files.filter(d => d.isDirectory());
      const dropped = dirs.length - skills.length;
      if (dropped > 0) {
        console.warn(`[skills] ${key}: ${dropped} 个技能目录未被挂载`
          + '(frontmatter 解析失败? 检查 SKILL.md 头部 --- 块)');
      }
    } catch { /* 目录不存在=该智能体无技能, 正常 */ }
    next.set(key, skills);
  }
  mounted = next;
  return next;
}

/** Skills mounted for one agent (snapshot for session creation). */
export function skillsFor(agentKey) {
  return mounted.get(agentKey) ?? [];
}

/** Persist a skill (create/overwrite) in an agent's directory. */
export async function saveSkill(agentKey, { name, description, content }) {
  // R22-F1: name 遍历守卫下沉到唯一入口——routes 侧有此校验(注释
  // 自证 crafted name 曾达 rm -rf), 工具面(configure_skill/delete_skill,
  // LLM 可控输入)漏防; ../../.. 即逃逸 HOST.skills。
  if (!/^[\w-]+$/.test(String(name)) || String(name).length > 60) {
    throw new Error(`name 非法: [a-zA-Z0-9_-]{1,60}(收到 ${JSON.stringify(String(name).slice(0, 40))})`);
  }
  const dir = `${HOST.skills}/${agentKey}/${name}`;
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(dir, { recursive: true });
  // R5-F4: description 含换行/--- 可伪造第二 frontmatter 块污染解析
  // ——JSON 字符串是合法 YAML 双引号标量, 换行/引号/冒号全转义。
  // P3-A(五审): content 自带 frontmatter(粘贴导入标准 SKILL.md 是常态)
  // 时不重复生成——双 --- 块会让官方解析器静默丢弃整个技能。
  const contentHasFm = String(content).trimStart().startsWith('---');
  const fm = contentHasFm ? '' : `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(String(description).replace(/\s*[\r\n]+\s*/g, ' '))}\n---\n\n`;
  await writeFile(`${dir}/SKILL.md`, fm + content, 'utf8');
  return `${CONTAINER.skills}/${agentKey}/${name}/SKILL.md`;
}

/** Remove a skill directory. */
export async function deleteSkill(agentKey, name) {
  // R22-F1: 同 saveSkill——删除面是 rm -rf recursive+force。
  if (!/^[\w-]+$/.test(String(name)) || String(name).length > 60) {
    throw new Error(`name 非法: [a-zA-Z0-9_-]{1,60}`);
  }
  const { rm } = await import('node:fs/promises');
  await rm(`${HOST.skills}/${agentKey}/${name}`,
    { recursive: true, force: true });
}

/** List the raw host tree (management UI). */
export async function listSkillsTree(agentKeys) {
  const { readdir } = await import('node:fs/promises');
  const out = [];
  for (const key of agentKeys) {
    const base = `${HOST.skills}/${key}`;
    let names = [];
    try {
      names = await readdir(base);
    } catch { continue; }
    for (const n of names) {
      const skills = (mounted.get(key) ?? [])
        .filter(s => s.name === n);
      out.push({
        agentKey: key, name: n,
        description: skills[0]?.description ?? '',
        filePath: `${CONTAINER.skills}/${key}/${n}/SKILL.md`,
      });
    }
  }
  return out;
}

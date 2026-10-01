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
import { mkdir, writeFile, rm, readdir, readFile } from 'node:fs/promises';
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
      const files = await readdir(hostDir, { withFileTypes: true });
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

/**
 * Skill-name traversal guard (CS1-R16: save/delete 两处同款收敛)。
 * R22-F1: crafted name 曾达 rm -rf——../../.. 即逃逸 HOST.skills。
 * @param {string} name
 */
function assertSkillName(name) {
  if (!/^[\w-]+$/.test(String(name)) || String(name).length > 60) {
    throw new Error(`name 非法: [a-zA-Z0-9_-]{1,60}(收到 ${JSON.stringify(String(name).slice(0, 40))})`);
  }
}

/** Persist a skill (create/overwrite) in an agent's directory. */
export async function saveSkill(agentKey, { name, description, content }) {
  // R22-F1: name 遍历守卫(assertSkillName 唯一入口)——routes 侧有此
  // 校验(注释自证 crafted name 曾达 rm -rf), 工具面(configure_skill/
  // delete_skill, LLM 可控输入)漏防; ../../.. 即逃逸 HOST.skills。
  assertSkillName(name);
  const dir = `${HOST.skills}/${agentKey}/${name}`;
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
/** R32D44-feature: 读技能正文(控制台 agent 配置面板点开技能看内容)。
 * agentKey/name 已在 routes 层白名单校验(isAgentKey + [\w-]+), 此处
 * 只处理存在性; 不存在返回 null(404 语义)。 */
export async function readSkillContent(agentKey, name) {
  try {
    return await readFile(`${HOST.skills}/${agentKey}/${name}/SKILL.md`, 'utf8');
  } catch {
    return null;
  }
}

export async function deleteSkill(agentKey, name) {
  // R22-F1: 同 saveSkill——删除面是 rm -rf recursive+force。
  assertSkillName(name);
  await rm(`${HOST.skills}/${agentKey}/${name}`,
    { recursive: true, force: true });
}

/** List the raw host tree (management UI). */
export async function listSkillsTree(agentKeys) {
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

/**
 * CS17-4/R32D46-NEW-2: 凭据谓词前端单源镜像。
 *
 * 单源在 backend/src/agent-settings.mjs hasSourceCredential——凭据型字段
 * = key/token/secret/password(+组特例 smtp.user); id/cx 是参数型字段不算。
 * 改谓词两侧同步。此前 AgentConfigTab 徽标用「任一字段非空」第 7 处
 * 分歧口径: censys 只存 id 时该处亮「已配置」而设置页/verify 均未配置。
 */
export function hasCred(
  cfg: Record<string, string> | undefined,
  sid: string,
): boolean {
  return Boolean(cfg && (cfg.key || cfg.token || cfg.secret || cfg.password
    || (sid === 'smtp' && cfg.user)));
}

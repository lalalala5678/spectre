/**
 * CS17-4/R32D46-NEW-2/CS39-3: 凭据谓词前端单源镜像。
 *
 * 单源在 backend/src/agent-settings.mjs isSecretLeaf(CRED_FIELD 集合
 * key/token/secret/password + 组特例 smtp.user)——本函数逐键镜像其词源;
 * id/cx 是参数型字段不算。改谓词两侧同步(此注释为同步契约)。
 */
export function hasCred(
  cfg: Record<string, string> | undefined,
  sid: string,
): boolean {
  if (!cfg) return false;
  const CRED = new Set(['key', 'token', 'secret', 'password']);
  return Object.entries(cfg).some(([k, v]) =>
    Boolean(v) && (CRED.has(k) || (sid === 'smtp' && k === 'user')));
}

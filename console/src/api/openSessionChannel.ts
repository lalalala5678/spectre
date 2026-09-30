/**
 * R32D29-N2: 应用内"打开会话"通道(全局搜索点击 → 目标会话)。
 *
 * 二十九轮审计实锤: 走 URL hash 参数(#agent?s=id)做应用内点击时,
 * 旧页面的深链消费 effect 会在路由切换提交前 replaceState 洗掉 ?s=,
 * 新页挂载时读不到参数 → ≈50% 非确定性丢目标(fiber 实测 drill 从未
 * 被设置), 且洞穿 R27-N2 保护产生 0-msg 空会话。
 *
 * 通道语义: pendingOpen 是模块级一次性令牌(带序号)。Topbar 点击时
 * setPendingOpen(key, id) + go(key); 目标 agent 页挂载或已在位时
 * takePendingOpen(liveKey) 取走——key 不匹配的页面取不走也不会清
 * 洗, 杜绝旧页抢先消费。URL ?s= 深链保留, 仅服务冷加载/直达。
 */

let pending: { key: string; id: string; n: number } | null = null;
export const OPEN_SESSION_EVENT = 'spectre:open-session';

export function setPendingOpen(key: string, id: string): void {
  pending = { key, id, n: (pending?.n ?? 0) + 1 };
  window.dispatchEvent(new CustomEvent(OPEN_SESSION_EVENT, { detail: pending.n }));
}

/** 仅当 key 匹配才取走(一次性); 不匹配返回 null 且不清洗。 */
export function takePendingOpen(key: string): string | null {
  if (pending && pending.key === key) {
    const id = pending.id;
    pending = null;
    return id;
  }
  return null;
}

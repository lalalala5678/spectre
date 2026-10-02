/** 主题管理(§4.1): 默认跟随 prefers-color-scheme, 手动切换后 localStorage 覆盖;
 * <html data-theme> 挂载, index.html 内联脚本已保证首 paint 前生效。 */
export type Theme = 'light' | 'dark';

const KEY = 'spectre-theme';

export function getTheme(): Theme {
  const saved = localStorage.getItem(KEY);
  if (saved === 'light' || saved === 'dark') return saved;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function setTheme(t: Theme) {
  localStorage.setItem(KEY, t);
  document.documentElement.dataset.theme = t;
}

/** App 挂载时断言(与防闪烁脚本一致); 无手工偏好时跟随系统实时切换(§7-13)。
 * 返回清理函数供 useEffect 直接使用。 */
export function initTheme(): () => void {
  document.documentElement.dataset.theme = getTheme();
  const mq = matchMedia('(prefers-color-scheme: dark)');
  const onChange = (e: MediaQueryListEvent) => {
    const saved = localStorage.getItem(KEY);
    if (saved === 'light' || saved === 'dark') return;
    document.documentElement.dataset.theme = e.matches ? 'dark' : 'light';
  };
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}

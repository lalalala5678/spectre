import { useEffect } from 'react';

/** FEVERIFY-N3/axe document-title: SPA 逐路由标题。用法: usePageTitle('设置') */
export function usePageTitle(page: string) {
  useEffect(() => {
    document.title = `SPECTRE · ${page}`;
    return () => { document.title = 'SPECTRE · 多智能体渗透测试平台'; };
  }, [page]);
}

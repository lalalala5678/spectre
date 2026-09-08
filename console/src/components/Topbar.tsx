import { Bell, Search } from 'lucide-react';
import { fmtTime } from '../mock/data';

export function Topbar() {
  return (
    <header className="flex h-11 shrink-0 items-center gap-3 border-b border-void-700 bg-void-900 px-3.5">
      {/* 全局搜索 */}
      <div className="relative w-80">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-600" />
        <input
          placeholder="搜索会话 / 资产 / 发现 / CVE…  (⌘K)"
          className="w-full rounded-sm border border-void-600 bg-void-800 py-1.5 pl-8 pr-3 text-xs text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-void-500"
        />
      </div>

      <div className="font-mono text-[11px] text-zinc-600">{fmtTime} GMT+8</div>

      <div className="flex-1" />

      <button className="relative rounded-sm p-1.5 text-zinc-500 hover:bg-void-800 hover:text-zinc-300" title="通知">
        <Bell className="h-4 w-4" />
        <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-orange-500" />
      </button>
    </header>
  );
}

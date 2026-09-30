/**
 * phish campaign 漏斗聚合(CS3-#10 从 routes.mjs 抽离的 ~50 行业务块)。
 *
 * 扫描追踪目录下 *.json, 按'有无 events 数组'判别 campaign(R15-F1:
 * 同目录的 smtp.json 凭据配置自免疫), 聚合 per-uid 漏斗与转化率。
 * R15-F5: 分母=有 sent 事件的 uid——此前分母=已互动 uid, 打开率结构性
 * 虚高(实测 100%); 存量旧库无 sent 时回退互动分母以免面板清空。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path_mod from 'node:path';
import { CONFIG } from './config.mjs';

// CS4-M4: 跟随 SPECTRE_DATA_DIR(同 config/keyfiles 单源)——硬编码曾使
// 隔离实例的漏斗读生产库、自身永远为空。
const TRACK_DIR = path_mod.join(CONFIG.dataDir, 'tools/phish');

/** 聚合全部 campaign 的漏斗/比率/时间线。 */
export function phishCampaignFunnel() {
  const dbFiles = [];
  if (existsSync(TRACK_DIR)) {
    for (const fn of readdirSync(TRACK_DIR)) {
      if (fn.endsWith('.json')) dbFiles.push(fn.replace('.json', ''));
    }
  }
  const campaigns = [];
  for (const name of dbFiles) {
    try {
      const parsed = JSON.parse(readFileSync(`${TRACK_DIR}/${name}.json`, 'utf8'));
      if (!parsed || !Array.isArray(parsed.events)) continue;  // R15-F1
      const ev = parsed.events;
      const byUid = {};
      for (const e of ev) {
        byUid[e.uid] ??= { open: 0, click: 0, submit: 0, session: 0, sent: 0 };
        if (e.kind === 'open') byUid[e.uid].open++;
        if (e.kind === 'click') byUid[e.uid].click++;
        if (e.kind === 'submit') byUid[e.uid].submit++;
        if (e.kind === 'session-captured') byUid[e.uid].session++;
        if (e.kind === 'sent') byUid[e.uid].sent++;  // R15-F5
      }
      const sentTargets = Object.values(byUid).filter(v => v.sent > 0).length;
      const targets = sentTargets || Object.keys(byUid).length;
      const opens = Object.values(byUid).filter(v => v.open > 0).length;
      const clicks = Object.values(byUid).filter(v => v.click > 0).length;
      const submits = Object.values(byUid).filter(v => v.submit > 0).length;
      const sessions = Object.values(byUid).filter(v => v.session > 0).length;
      campaigns.push({
        name, events: ev.length, targets,
        funnel: { opens, clicks, submits, sessions },
        rates: {
          open: targets ? Math.round(opens * 100 / targets) : 0,
          click: targets ? Math.round(clicks * 100 / targets) : 0,
          submit: targets ? Math.round(submits * 100 / targets) : 0,
          session: targets ? Math.round(sessions * 100 / targets) : 0,
        },
        timeline: ev.slice(-50).map(e => ({ ts: e.ts, kind: e.kind, uid: e.uid })),
      });
    } catch { /* skip corrupt */ }
  }
  return { campaigns };
}

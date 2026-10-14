// 配置面: 网关地址 + API Key(chrome.storage.local)。
// 测试 = GET /spectre/api/projects 带 X-Spectre-Key——200 即密钥与链路双通。
'use strict';
const $ = (id) => document.getElementById(id);

document.addEventListener('DOMContentLoaded', () => {
  chrome.storage.local.get(['gateway', 'apikey'], (c) => {
    $('gateway').value = c.gateway ?? '';
    $('apikey').value = c.apikey ?? '';
  });
  $('save').addEventListener('click', () => {
    chrome.storage.local.set({
      gateway: $('gateway').value.trim().replace(/\/+$/, ''),
      apikey: $('apikey').value.trim(),
    }, () => { $('test-out').textContent = '已保存'; });
  });
  $('test').addEventListener('click', async () => {
    const gw = $('gateway').value.trim().replace(/\/+$/, '');
    const key = $('apikey').value.trim();
    if (!gw || !key) { $('test-out').textContent = '先填两项'; return; }
    $('test-out').textContent = '测试中…';
    try {
      const r = await fetch(`${gw}/spectre/api/projects`, { headers: { 'X-Spectre-Key': key } });
      if (r.status === 401) { $('test-out').textContent = '密钥无效(401)——重新生成并更新'; $('test-out').className = 'bad'; return; }
      if (r.redirected) { $('test-out').textContent = '地址不对(被重定向到登录页)——检查网关地址'; $('test-out').className = 'bad'; return; }
      if (!r.ok) { $('test-out').textContent = `HTTP ${r.status}`; $('test-out').className = 'bad'; return; }
      const projects = await r.json();
      $('test-out').textContent = `✓ 连通(项目 ${Array.isArray(projects) ? projects.length : '?'} 个)`;
      $('test-out').className = 'ok';
    } catch (e) {
      $('test-out').textContent = `不可达: ${e.message}`;
      $('test-out').className = 'bad';
    }
  });
});

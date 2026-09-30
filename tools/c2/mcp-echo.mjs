import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  // R25-F1: 守卫 JSON.parse(镜像 recon 先例)——畸形行此前崩溃整进程
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id === undefined) return;
  let result;
  if (m.method === 'initialize') {
    result = { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'echo' } };
  } else if (m.method === 'tools/list') {
    result = { tools: [{ name: 'ping', description: 'ping 工具', inputSchema: { type: 'object' } }] };
  } else if (m.method === 'tools/call') {
    result = { content: [{ type: 'text', text: 'pong:' + JSON.stringify(m.params?.arguments) }] };
  } else {
    // JSON-RPC 2.0 -32601(此前 result:undefined 被 stringify 丢弃,
    // 响应既无 result 又无 error = 畸形 JSON-RPC)
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id,
      error: { code: -32601, message: 'Method not found' } }) + '\n');
    return;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\n');
});

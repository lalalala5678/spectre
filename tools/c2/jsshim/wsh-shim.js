#!/usr/bin/env node
/* WSH 宿主 shim:在 node 里等价验证 JScript 载荷(含计算成员改写变体)。
 * 通过 runInThisContext 使顶层 this === globalThis(与 WSH 全局语义一致),
 * 从而 `new ActiveXObject(...)` 与 `new this["ActiveX"+"Object"](...)` 同源。
 * 输出约定:载荷自身 echo 照常打印;末行 SHIM-PROGIDS: ["ProgID",...]
 * 退出码:0=执行成功;1=抛异常。
 */
const fs = require('fs'), vm = require('vm');
const file = process.argv[2];
if (!file) { console.error('usage: wsh-shim.js <file.js>'); process.exit(2); }
const constructed = [];
globalThis.ActiveXObject = function ActiveXObject(progId) {
    constructed.push(String(progId));
    return { ProgID: String(progId) };
};
globalThis.WScript = {
    Echo: function () { console.log(Array.from(arguments).join(' ')); },
    CreateObject: function (p) { constructed.push(String(p)); return { ProgID: String(p) }; },
    ScriptName: 'shim.js',
};
let rc = 0;
try {
    vm.runInThisContext(fs.readFileSync(file, 'utf8'), { filename: file });
} catch (e) {
    console.log('SHIM-ERROR: ' + e.message);
    rc = 1;
}
console.log('SHIM-PROGIDS: ' + JSON.stringify(constructed));
process.exit(rc);

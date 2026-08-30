// 将 pnpm 严格模式（node-linker 未生效）下藏在 node_modules/.pnpm 内的传递依赖，
// junction 到顶层 node_modules，供 electron-builder 打包时能跟随 require 解析。
//
// 背景：本项目 .npmrc 设了 node-linker=hoisted，但当前环境的 pnpm 版本未真正据此重建
// node_modules，导致 ssh2 / ssh2-sftp-client 等的传递依赖（safer-buffer、concat-stream 等）
// 留在 node_modules/.pnpm/<pkg>@x/node_modules/<pkg>，electron-builder 只打包顶层 node_modules，
// 运行时报 "cannot find module XXX"。本脚本把这些缺失项以 junction 形式补到顶层，幂等可重复。
//
// 用法：在 build / package 脚本前自动执行一次（package.json 已接入）。
const fs = require('fs');
const path = require('path');

const nm = path.join(process.cwd(), 'node_modules');
const pnpmRoot = path.join(nm, '.pnpm');

if (!fs.existsSync(pnpmRoot)) {
  console.log('[link-pnpm-deps] 无 node_modules/.pnpm，跳过');
  process.exit(0);
}

let linked = 0;
let skipped = 0;
let failed = 0;

for (const dir of fs.readdirSync(pnpmRoot)) {
  const inner = path.join(pnpmRoot, dir, 'node_modules');
  if (!fs.existsSync(inner)) continue;
  for (const pkg of fs.readdirSync(inner)) {
    if (pkg === '.bin' || pkg === '.package-lock.json') continue;
    const top = path.join(nm, pkg);
    if (fs.existsSync(top)) { skipped++; continue; }
    const src = path.join(inner, pkg);
    try {
      fs.symlinkSync(src, top, 'junction');
      linked++;
    } catch (e) {
      failed++;
      console.error('[link-pnpm-deps] FAIL', pkg, e.message);
    }
  }
}
console.log(`[link-pnpm-deps] linked=${linked} skipped=${skipped} failed=${failed}`);

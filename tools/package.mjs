#!/usr/bin/env node
/* 打包扩展为可安装的 zip：dist/Vodka-Arena-Model-<version>[-Buster].zip（文件平铺在根，解开即可「加载已解压的扩展程序」）。

   为什么要有这个脚本（而不是手敲 zip 命令）：
   **运行时依赖必须自动发现，不能手写清单**。旧包（2.9.25）就是手写的，漏了
   `price-channel.js` / `pricing-channel.js` / `usage-channel.js` /
   `arena-cost-table.json` / `arena-pricing-table.json` 五个文件 ——
   装进浏览器后不是立刻报错，而是等到「用价格反推」那条路径才炸。
   本脚本从 manifest + 静态 import + `chrome.runtime.getURL()` + `new URL('./x', import.meta.url)`
   反推闭包，任何一个依赖文件缺失都直接报错退出。

   用法：
     node tools/package.mjs                # 打包
     node tools/package.mjs --check-only   # 只做依赖完整性检查，不写文件
     node tools/package.mjs --out dist     # 指定输出目录 */

import {readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync} from 'node:fs';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {resolve, sep} from 'node:path';
import {deflateRawSync} from 'node:zlib';
import {createHash} from 'node:crypto';

const ROOT = new URL('..', import.meta.url);
const abs = name => new URL(name, ROOT);
const read = name => readFileSync(abs(name), 'utf8');
const exists = name => existsSync(abs(name));

const args = process.argv.slice(2);
const CHECK_ONLY = args.includes('--check-only');
const outIndex = args.indexOf('--out');
const OUT_DIR = outIndex >= 0 && args[outIndex + 1] ? args[outIndex + 1] : 'dist';

const manifest = JSON.parse(read('manifest.json'));
const VERSION = manifest.version;

/* ---------- 1. 自动发现运行时依赖 ---------- */

const files = new Set();
const add = value => { const name = String(value || '').replace(/^\/+/, ''); if (name && !files.has(name)) { files.add(name); return true; } return false; };

/* 1a. manifest 直接引用 */
add('manifest.json');
add(manifest.background?.service_worker);
for (const cs of manifest.content_scripts || []) for (const js of cs.js || []) add(js);
const popupHtml = manifest.action?.default_popup;
if (popupHtml) {
  add(popupHtml);
  /* popup.html 里的 <script src> / <link href> 也是运行时依赖。 */
  for (const m of read(popupHtml).matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)) add(m[1]);
}

/* Buster has dynamic model/WASM assets and a separate options page. */
const embedsBuster = (manifest.content_scripts || []).some(cs => (cs.js || []).includes('buster/src/base/script.js'));
const busterCatalog = embedsBuster ? JSON.parse(read('buster/runtime-files.json')) : null;
if (busterCatalog) {
  add('buster/runtime-files.json');
  add(manifest.options_ui?.page);
  for (const name of busterCatalog.runtimeFiles || []) {
    if (!/^(?:buster|_locales)\//.test(name) || name.split('/').includes('..')) throw Error('Invalid Buster runtime asset: ' + name);
    add(name);
  }
}

/* 1b. 传递闭包：静态 import + getURL + new URL(relative, import.meta.url) */
const queue = [...files];
while (queue.length) {
  const name = queue.pop();
  if (!name.endsWith('.js') || !exists(name)) continue;
  const source = read(name);
  for (const m of source.matchAll(/from '\.\/([^']+)'/g)) if (add(m[1])) queue.push(m[1]);
  for (const m of source.matchAll(/getURL\('([^']+)'\)/g)) if (add(m[1])) queue.push(m[1]);
  for (const m of source.matchAll(/new URL\('\.\/([^']+)'/g)) if (add(m[1])) queue.push(m[1]);
}

/* 1c. 第三方许可 —— `modeltrace-bank.json` / `modeltrace-core.js` 是 MIT 第三方文件
   （见 THIRD_PARTY_NOTICES.md），分发时必须随附许可原文。 */
const LICENSE_FILES = ['THIRD_PARTY_NOTICES.md', 'LICENSE-ModelTrace', 'LICENSE-LMFPD', 'LICENSE-fzstd', 'LICENSE', 'README_BUSTER.md'];
if (busterCatalog) for (const name of busterCatalog.correspondingSource || []) {
  if (!(name.startsWith('vendor/buster/') || name === 'tools/integrate-buster.mjs') || name.split('/').includes('..')) throw Error('Invalid Buster source asset: ' + name);
  add(name);
}
for (const name of LICENSE_FILES) if (exists(name)) add(name);

/* ---------- 2. 完整性校验 ---------- */

const ordered = [...files].sort((a, b) => a.localeCompare(b, 'en'));
const missing = ordered.filter(name => !exists(name));
if (missing.length) {
  console.error(`❌ 缺少 ${missing.length} 个运行时依赖文件：`);
  for (const name of missing) console.error(`   ${name}`);
  process.exit(1);
}

/* 反向提示：根目录里有 .js 文件没被引用到？只提示不报错 ——
   可能是开发期的探针脚本，也可能是我漏接了依赖，值得看一眼。 */
const unreferenced = readdirSync(new URL('.', ROOT))
  .filter(name => name.endsWith('.js') && !files.has(name));
if (unreferenced.length) {
  console.log(`\nℹ️  根目录有 ${unreferenced.length} 个 .js 未被任何运行时入口引用（确认是刻意不打进包）：`);
  for (const name of unreferenced) console.log(`   ${name}`);
}

let totalRaw = 0;
console.log(`${manifest.name} ${VERSION}${embedsBuster ? ' + Buster' : ''} — 运行时依赖 ${ordered.length} 个文件`);
for (const name of ordered) {
  const size = statSync(abs(name)).size;
  totalRaw += size;
  console.log(`   ${String(size).padStart(8)}  ${name}`);
}
console.log(`   ${'—'.repeat(8)}  原始合计 ${(totalRaw / 1024).toFixed(1)} KB`);

if (CHECK_ONLY) {
  console.log('\n✅ 依赖完整（--check-only，未写文件）');
  process.exit(0);
}

/* ---------- 3. 写 zip（纯 Node，零依赖） ---------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const time = ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)) & 0xffff;
  const day = (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff;
  return {time, day};
}

function buildZip(entries, date) {
  const {time, day} = dosDateTime(date);
  const local = [];
  const central = [];
  let offset = 0;
  for (const {name, data} of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = deflateRawSync(data, {level: 9});
    const useDeflate = deflated.length < data.length;
    const payload = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(data);

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);        // version needed
    header.writeUInt16LE(0, 6);         // flags
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(day, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(payload.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(0, 28);        // extra length
    local.push(header, nameBuf, payload);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);            // version made by
    cd.writeUInt16LE(20, 6);            // version needed
    cd.writeUInt16LE(0, 8);             // flags
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(day, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(payload.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);            // extra
    cd.writeUInt16LE(0, 32);            // comment
    cd.writeUInt16LE(0, 34);            // disk start
    cd.writeUInt16LE(0, 36);            // internal attrs
    cd.writeUInt32LE(0, 38);            // external attrs
    cd.writeUInt32LE(offset, 42);       // local header offset
    central.push(cd, nameBuf);

    offset += header.length + nameBuf.length + payload.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...local, centralBuf, eocd]);
}

const entries = ordered.map(name => ({name, data: readFileSync(abs(name))}));
/* 可复现构建：设 SOURCE_DATE_EPOCH（Unix 秒）则用它作为全部条目的时间戳。
   时间戳会写进 zip 头，所以不固定时每次构建的 SHA-256 都不同 —— 想核对校验和就固定它。 */
const buildDate = process.env.SOURCE_DATE_EPOCH
  ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000)
  : new Date();
if (Number.isNaN(buildDate.getTime())) throw new Error('SOURCE_DATE_EPOCH 不是合法的时间戳');
const zip = buildZip(entries, buildDate);

/* OUT_DIR 相对项目根解析；绝对路径也接受（交给 path.resolve 处理 Windows 盘符/分隔符）。 */
const OUT_DIR_URL = pathToFileURL(resolve(fileURLToPath(ROOT), OUT_DIR) + sep);
mkdirSync(OUT_DIR_URL, {recursive: true});
const zipName = `Vodka-Arena-Model-${VERSION}${embedsBuster ? '-Buster' : ''}.zip`;
const zipUrl = new URL(zipName, OUT_DIR_URL);
writeFileSync(zipUrl, zip);

const sha = createHash('sha256').update(zip).digest('hex');
console.log(`\n✅ 已写出 ${fileURLToPath(zipUrl)}`);
console.log(`   ${(zip.length / 1024).toFixed(1)} KB（压缩率 ${(100 - zip.length / totalRaw * 100).toFixed(1)}%）`);
console.log(`   SHA-256 ${sha}`);

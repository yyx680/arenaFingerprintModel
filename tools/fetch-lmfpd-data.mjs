#!/usr/bin/env node
/* 拉取 lm.ikale.io（Fingerpoint Detector / lmfpd）的参考库数据，写入 lmfpd-data/。

   数据源与 lmfpd-sdk 的 DEFAULT_DATA_URLS 一致：
     1. https://lm.ikale.io/data/
     2. https://cdn.jsdmirror.com/npm/lmfpd-data@latest/ （国内镜像兜底）

   bundle.json 只是清单（模型列表 + 文件 sha256 + 分片名）；真正的检测参数在
   chunks/*.zst 分片里，zstd 解压后是 shared_detector.bin（约 4.8MB，自定义 $f32 Float32 编码，
   运行时由 lmfpd-channel.js 的 decodeDetector 还原）。

   用法：node tools/fetch-lmfpd-data.mjs [--check]   # --check 只校验远端 sha256，不写文件
   需要 Node >= 22.15（node:zlib 的 zstdDecompressSync）。 */

import {mkdirSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {zstdDecompressSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'lmfpd-data');
const DETECTOR = 'shared_detector.bin';
const SOURCES = [
  'https://lm.ikale.io/data/',
  'https://cdn.jsdmirror.com/npm/lmfpd-data@latest/',
];
const CHECK_ONLY = process.argv.includes('--check');

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function download(url, timeoutMs = 120000) {
  const response = await fetch(url, {signal: AbortSignal.timeout(timeoutMs)});
  if (!response.ok) throw new Error(`HTTP ${response.status} (${url})`);
  return new Uint8Array(await response.arrayBuffer());
}

async function fetchFrom(source) {
  const bundleBytes = await download(`${source}bundle.json`, 15000);
  const bundle = JSON.parse(new TextDecoder().decode(bundleBytes));
  if (bundle.schema !== 'lmfpd-data-v1' || bundle.detector_schema !== 'shared-detector-v2') {
    throw new Error(`data schema ${bundle.schema}/${bundle.detector_schema} unsupported`);
  }
  const file = bundle.files?.[DETECTOR];
  if (!file?.parts?.length || !file.sha256) throw new Error('bundle.json missing detector file entry');
  const parts = [];
  for (const part of file.parts) parts.push(await download(`${source}chunks/${part}`));
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const packed = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { packed.set(part, offset); offset += part.length; }
  const detector = zstdDecompressSync(packed);
  const digest = sha256(detector);
  if (digest !== file.sha256) throw new Error(`sha256 mismatch: ${digest} != ${file.sha256}`);
  return {bundleBytes, detector, bundle};
}

const failures = [];
let data = null;
for (const source of SOURCES) {
  try { data = await fetchFrom(source); break; }
  catch (error) { failures.push(`${source} (${error?.message || error})`); }
}
if (!data) {
  console.error(`拉取失败：\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
if (failures.length) console.log(`主源失败，已用镜像：${failures[0]}`);

const {bundleBytes, detector, bundle} = data;
console.log(`built_at: ${bundle.built_at}`);
console.log(`models: ${bundle.models.length}`);
console.log(`unified_bank.json: ${bundleBytes.length} bytes`);
console.log(`${DETECTOR}: ${detector.length} bytes (sha256 ${sha256(detector).slice(0, 16)}…)`);

if (CHECK_ONLY) process.exit(0);
mkdirSync(OUT_DIR, {recursive: true});
writeFileSync(join(OUT_DIR, 'unified_bank.json'), bundleBytes);
writeFileSync(join(OUT_DIR, DETECTOR), detector);
console.log(`written → ${OUT_DIR}`);

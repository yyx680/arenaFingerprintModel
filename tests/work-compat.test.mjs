import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const read = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');
/* ★ 本沙箱是极简的：background.js 的 import 全被剥掉，所以**顶层**引用到的任何导入符号
   都必须在这里补一份，否则整个脚本在求值阶段就 ReferenceError（本测试只想测 isAgentUrl/cleanOutputs）。
   v2.19.5 起顶层多引用了 CONSISTENT_RATIO（价格指纹窗口的 z 刻度除数）。 */
const bg = vm.createContext({URL, CONSISTENT_RATIO: 1.6, registerRecaptchaAnchor: () => {}, createBalanceReader: () => ({}), chrome: {runtime: {getURL: (p) => p, onMessage: {addListener() {}}, onConnect: {addListener() {}}}, tabs: {onRemoved: {addListener() {}}}, storage: {local: {remove: () => Promise.resolve(), get: () => Promise.resolve({}), set: () => Promise.resolve()}}}});
vm.runInContext(read('background.js').replace(/^import .*;\r?\n/gm, '') + '\nglobalThis.api={isAgentUrl,cleanOutputs};', bg);
const {isAgentUrl,cleanOutputs}=bg.api;
test('background accepts Work and legacy Agent, rejects other origins and path prefixes',()=>{
 for(const path of ['/work','/work/abc-123','/agent','/agent/abc-123']) assert.equal(isAgentUrl('https://arena.ai'+path),true);
 // v2.15.0：canary 预发布域与生产同权（登录态/新功能常先在 canary）。
 for(const path of ['/work','/agent/abc-123']) assert.equal(isAgentUrl('https://canary.arena.ai'+path),true);
 // 只按 **origin** 判定，不再限制路径前缀（见 background.js 注释）；异源一律拒绝。
 for(const url of ['https://evil.test/work','https://arena.ai.evil.test/work','http://arena.ai/work','https://canary.arena.ai.evil.test/agent']) assert.equal(isAgentUrl(url),false);
});
test('quick scoring supports any single probe and preserves its identity',()=>{
 [297,315,331].forEach((expected_count,i)=>{
 const result=cleanOutputs([{expected_count,text:'1,2,3',challenge_id:`plain-${i+1}`}]);
 assert.equal(result[0].challenge_id,`plain-${i+1}`);
 });
 assert.equal(cleanOutputs([{expected_count:331,text:'1,2'},{expected_count:315,text:'3,4'}])[0].challenge_id,'plain-3');
});
test('scoring rejects duplicates, unknown counts, mismatched IDs and non-numeric text',()=>{
 for(const input of [[{expected_count:315,text:'1'},{expected_count:315,text:'2'}],[{expected_count:3,text:'1,2,3'}],[{expected_count:331,text:'1',challenge_id:'plain-1'}],[{expected_count:297,text:'hello'}],[]])assert.throws(()=>cleanOutputs(input));
});
const content=read('content.js');
const declarations=['session','ARENA_ORIGIN_RE','agentPage','agentPath','isWorkMode','isNewChatPath'].map(name=>content.split('\n').find(line=>line.trim().startsWith(`const ${name}=`))).join('\n');
const ctx=vm.createContext({location:{origin:'https://arena.ai',pathname:'/work/test-123'}});
vm.runInContext(declarations+'\nglobalThis.api={session,agentPage,agentPath,isWorkMode,isNewChatPath};',ctx);
test('controller supports both routes and both mode labels',()=>{
 assert.equal(ctx.api.session(),'test-123');assert.equal(ctx.api.agentPage(),true);
 for(const pathname of ['/agent/test-123','/work/test-123']){ctx.location.pathname=pathname;assert.equal(ctx.api.session(),'test-123');}
 for(const textContent of ['Work','Agent','Work Mode','Agent Mode'])assert.equal(ctx.api.isWorkMode({textContent}),true);
 for(const textContent of ['Chat','Workflow','Agentic'])assert.equal(ctx.api.isWorkMode({textContent}),false);
 for(const path of ['/work','/work/','/agent'])assert.equal(ctx.api.isNewChatPath(path),true);
 for(const path of ['/work/id','/agent/id','/workflow'])assert.equal(ctx.api.isNewChatPath(path),false);
 assert.ok(content.includes('isNewChatPath(url.pathname)'));
 assert.ok(content.includes('isNewChatPath(agentPath())'));
});
test('rename helper recognizes both session paths',()=>{
 const context=vm.createContext({});vm.runInContext(read('conversation-rename.js'),context);
 for(const path of ['/work/abc-123','/agent/abc-123'])assert.equal(context.ArenaProbeRename.sessionFromPath(path),'abc-123');
 assert.equal(context.ArenaProbeRename.sessionFromPath('/work'),null);
});
test('manifest injects into both route families; popup accepts both',()=>{
 const m=JSON.parse(read('manifest.json'));
 // v2.15.0：manifest 用整站通配（不再枚举 /work*、/agent*），且必须同时覆盖 canary 预发布域（排除 Buster 的 recaptcha content_scripts）。
 const arenaScripts=m.content_scripts.filter(cs=>!(cs.matches||[]).some(u=>/recaptcha/i.test(u)));
 assert.ok(arenaScripts.length>=2);
 for(const cs of arenaScripts){
  assert.ok(cs.matches.includes('https://arena.ai/*'));
  assert.ok(cs.matches.includes('https://canary.arena.ai/*'));
 }
 assert.ok(m.host_permissions.includes('https://canary.arena.ai/*'));
 assert.ok(m.host_permissions.includes('https://lm.ikale.io/*'));
 assert.ok(m.host_permissions.includes('https://cdn.jsdmirror.com/*'));
 const src=read('popup.js').split('\n');
 const originLine=src.find(x=>x.startsWith('const ARENA_ORIGIN_RE='));
 const line=src.find(x=>x.startsWith('function agentUrl('));
 const context=vm.createContext({URL});vm.runInContext(originLine+'\n'+line,context);
 assert.equal(context.agentUrl('https://arena.ai/work/test'),true);
 assert.equal(context.agentUrl('https://arena.ai/agent/test'),true);
 assert.equal(context.agentUrl('https://canary.arena.ai/agent/test'),true);
 assert.equal(context.agentUrl('https://arena.ai/workshop'),false);
});

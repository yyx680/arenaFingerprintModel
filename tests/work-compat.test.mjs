import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const read = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const bg = vm.createContext({URL, createBalanceReader: () => ({}), chrome: {runtime: {onMessage: {addListener() {}}, onConnect: {addListener() {}}}, tabs: {onRemoved: {addListener() {}}}, storage: {local: {remove: () => Promise.resolve(), get: () => Promise.resolve({}), set: () => Promise.resolve()}}}});
vm.runInContext(read('background.js').replace(/^import .*;\r?\n/gm, '') + '\nglobalThis.api={isAgentUrl,cleanOutputs};', bg);
const {isAgentUrl,cleanOutputs}=bg.api;
test('background accepts Work and legacy Agent, rejects other origins and path prefixes',()=>{
 for(const path of ['/work','/work/abc-123','/agent','/agent/abc-123']) assert.equal(isAgentUrl('https://arena.ai'+path),true);
 for(const url of ['https://evil.test/work','https://arena.ai/workshop','https://arena.ai/agents','http://arena.ai/work']) assert.equal(isAgentUrl(url),false);
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
const declarations=['session','agentPage','agentPath','isWorkMode','isNewChatPath'].map(name=>content.split('\n').find(line=>line.trim().startsWith(`const ${name}=`))).join('\n');
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
 assert.ok(m.content_scripts[0].matches.includes('https://arena.ai/work*'));
 assert.ok(m.content_scripts[0].matches.includes('https://arena.ai/agent*'));
 const line=read('popup.js').split('\n').find(x=>x.startsWith('function agentUrl('));
 const context=vm.createContext({URL});vm.runInContext(line,context);
 assert.equal(context.agentUrl('https://arena.ai/work/test'),true);
 assert.equal(context.agentUrl('https://arena.ai/agent/test'),true);
 assert.equal(context.agentUrl('https://arena.ai/workshop'),false);
});

// SPDX-License-Identifier: GPL-3.0-only
// Reproducible embedding adapter for dessant/buster 3.4.0, not a general captcha bypass.
import {readFileSync,writeFileSync,readdirSync,mkdirSync,existsSync,copyFileSync,statSync} from 'node:fs';
import {resolve,join,relative,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
const ISOLATED="// SPDX-License-Identifier: GPL-3.0-only\n// Vodka embedding adapter: never clear or migrate the host extension's storage.\nconst PREFIX = 'amp.buster.v1.';\nconst wrapKeys = keys => typeof keys === 'string' ? PREFIX + keys : keys.map(key => PREFIX + key);\nfunction areaAdapter(name) {\n  const raw = () => { const area=browser.storage?.[name]; if(!area)throw Error('Storage API unavailable in this context'); return area; };\n  return {\n    async get(keys = null) {\n      let query = keys;\n      if (typeof keys === 'string' || Array.isArray(keys)) query = wrapKeys(keys);\n      else if (keys && typeof keys === 'object') query = Object.fromEntries(Object.entries(keys).map(([k,v]) => [PREFIX+k,v]));\n      const data = await raw().get(query);\n      return Object.fromEntries(Object.entries(data).filter(([key]) => key.startsWith(PREFIX)).map(([key,value]) => [key.slice(PREFIX.length),value]));\n    },\n    set(data) { return raw().set(Object.fromEntries(Object.entries(data).map(([k,v]) => [PREFIX+k,v]))); },\n    remove(keys) { return raw().remove(wrapKeys(keys)); },\n    async clear() { const own = Object.keys(await raw().get(null)).filter(key => key.startsWith(PREFIX)); if (own.length) await raw().remove(own); },\n    async getBytesInUse(keys = null) { const own = keys === null ? Object.keys(await raw().get(null)).filter(key => key.startsWith(PREFIX)) : wrapKeys(keys); return raw().getBytesInUse(own); }\n  };\n}\nconst callbacks = new Map();\nconst onChanged = {\n  addListener(callback) {\n    if (callbacks.has(callback)) return;\n    const wrapped = (changes,area) => {\n      const own = Object.fromEntries(Object.entries(changes).filter(([key]) => key.startsWith(PREFIX)).map(([key,value]) => [key.slice(PREFIX.length),value]));\n      if (Object.keys(own).length) callback(own,area);\n    };\n    callbacks.set(callback,wrapped); browser.storage.onChanged.addListener(wrapped);\n  },\n  removeListener(callback) { const wrapped = callbacks.get(callback); if (wrapped) { browser.storage.onChanged.removeListener(wrapped); callbacks.delete(callback); } },\n  hasListener(callback) { return callbacks.has(callback); }\n};\nexport const busterStorage = {local:areaAdapter('local'),session:areaAdapter('session'),sync:areaAdapter('sync'),onChanged};\n";
const INIT="// SPDX-License-Identifier: GPL-3.0-only\n// Fresh namespaced storage, without upstream legacy migrations or global clear().\nimport {busterStorage} from './isolated';\nimport {storageRevisions,appVersion} from 'utils/config';\nasync function initStorage({area='local',data=null}={}) {\n  const defaults = area === 'local' ? {\n    speechService:'managed',autoCaptchaEnabled:false,googleSpeechApiKey:'',ibmSpeechApiUrl:'',ibmSpeechApiKey:'',\n    microsoftSpeechApiLoc:'eastus',microsoftSpeechApiKey:'',witSpeechApiKeys:{},\n    installTime:Date.now(),useCount:0,tryEnglishSpeechModel:true,loadEnglishChallenge:false,\n    simulateUserInput:false,autoUpdateClientApp:false,navigateWithKeyboard:false,\n    appTheme:'auto',showContribPage:false,contribPageLastOpen:0,contribPageLastAutoOpen:0,\n    appVersion,enableManagedLocalServices:true,enableManagedRemoteServices:false\n  } : {platformInfo:null,autoAttemptClaims:{}};\n  const current = await busterStorage[area].get(null);\n  const missing = Object.fromEntries(Object.entries(defaults).filter(([key]) => current[key] === undefined));\n  await busterStorage[area].set({...missing,...(data||{}),storageVersion:storageRevisions[area]});\n}\nexport {initStorage};\n";
const OPTIONS_HTML="<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Vodka · Buster 人机辅助</title><link rel=\"stylesheet\" href=\"style.css\"></head><body><main><small>VODKA · OPTIONAL ONE-SHOT ASSISTANCE</small><h1>Buster 人机辅助</h1><p>内嵌 Buster 的 reCAPTCHA 音频辅助。默认手动点击；也可显式开启一次自动音频辅助。不会后台连续尝试，不处理 Cloudflare / hCaptcha。</p><section><h2>本地识别</h2><p>建议先准备 Whisper Tiny 模型，再返回验证码点击 Buster。首次会从 Hugging Face 下载模型并缓存在浏览器，可能需要较长时间与磁盘空间。音频由本地模型处理，不发送至云端识别服务。</p><button id=\"prepare\">下载 / 准备本地模型</button><p id=\"model-status\" role=\"status\"></p></section><section><h2>自动音频辅助（默认关闭）</h2><label class=\"toggle\"><input id=\"auto-once\" type=\"checkbox\"> 检测到可见的 Arena reCAPTCHA 时，自动尝试一次</label><p>只使用已经准备的本地模型；当前验证码框的本次页面生命周期最多一次识别/填入/提交。无音频、模型缺失或失败即交回手动，不重试、不自动下载模型、不自动续跑探测/抽卡。云服务仍需手动点击。</p><p>勾选后点击下面的「保存设置」。服务工作线程重启不会重复本框的尝试；每次浏览器会话最多 64 个框。</p></section><section><h2>语音识别服务</h2><p>默认使用本地识别。也可自行配置云服务；选择云服务后，验证码音频会发送给该服务，可能产生费用。集成版不包含 Buster 官方托管密钥，也不包含原生模拟输入客户端。</p><label>服务<select id=\"service\"><option value=\"managed\">本地识别（默认）</option><option value=\"googleSpeechApi\">Google Speech API（自己的密钥）</option><option value=\"microsoftSpeechApi\">Microsoft Azure Speech（自己的密钥）</option><option value=\"ibmSpeechApi\">IBM Speech（自己的密钥）</option><option value=\"witSpeechApi\">Wit.ai（自己的密钥）</option></select></label><div data-provider=\"googleSpeechApi\"><label>Google API key<input id=\"google-key\" type=\"password\" autocomplete=\"off\"></label></div><div data-provider=\"microsoftSpeechApi\"><label>Azure 区域<input id=\"azure-region\" placeholder=\"eastus\"></label><label>Azure API key<input id=\"azure-key\" type=\"password\" autocomplete=\"off\"></label></div><div data-provider=\"ibmSpeechApi\"><label>IBM API URL<input id=\"ibm-url\" type=\"url\" placeholder=\"https://…speech-to-text.watson.cloud.ibm.com/instances/…\"></label><label>IBM API key<input id=\"ibm-key\" type=\"password\" autocomplete=\"off\"></label></div><div data-provider=\"witSpeechApi\"><label>Wit.ai English token<input id=\"wit-key\" type=\"password\" autocomplete=\"off\"></label></div><button id=\"save\">保存设置</button><p id=\"status\" role=\"status\"></p></section><footer>上游 Buster：Armin Sebastian · GPL-3.0-only。对应上游源码及集成补丁位于 vendor/buster 与 tools/integrate-buster.mjs。完成验证后，请手动重新开始模型识别；这不是通用验证绕过工具。</footer></main><script src=\"options.js\"></script></body></html>\n";
const OPTIONS_CSS="body{margin:0;background:#0e1421;color:#dbe5f8;font:15px/1.65 system-ui,sans-serif}main{max-width:780px;margin:48px auto;padding:0 24px}small{color:#72c5ed;letter-spacing:2px}h1{font-size:30px}h2{font-size:19px;margin:0 0 12px}section{background:#172139;border:1px solid #31465f;border-radius:14px;margin:22px 0;padding:24px}p,footer{color:#b5c0d5}label{display:block;margin:12px 0}input,select{box-sizing:border-box;width:100%;padding:10px;border-radius:7px;border:1px solid #48617a;background:#0e172b;color:#eaf2ff}button{padding:11px 20px;background:#275f88;color:#fff;border:1px solid #75bbe5;border-radius:8px;cursor:pointer}button:disabled{opacity:.5;cursor:wait}footer{font-size:12px;margin:24px 0 50px}.toggle{display:flex;align-items:center;gap:10px}input[type=checkbox]{width:auto;accent-color:#72c5ed} [hidden]{display:none!important}\n";
const OPTIONS_JS="// SPDX-License-Identifier: GPL-3.0-only\nconst PREFIX='amp.buster.v1.', $=id=>document.getElementById(id);\nconst fields={'google-key':'googleSpeechApiKey','azure-region':'microsoftSpeechApiLoc','azure-key':'microsoftSpeechApiKey','ibm-url':'ibmSpeechApiUrl','ibm-key':'ibmSpeechApiKey'};\nfunction providers(){document.querySelectorAll('[data-provider]').forEach(node=>{node.hidden=node.dataset.provider!==$('service').value;});}\nasync function load(){const names=['autoCaptchaEnabled','speechService','witSpeechApiKeys',...Object.values(fields)];const values=await chrome.storage.local.get(names.map(name=>PREFIX+name));$('service').value=values[PREFIX+'speechService']||'managed';$('auto-once').checked=values[PREFIX+'autoCaptchaEnabled']===true;for(const [id,key]of Object.entries(fields))$(id).value=values[PREFIX+key]||'';$('wit-key').value=values[PREFIX+'witSpeechApiKeys']?.english||'';providers();}\n$('service').addEventListener('change',providers);\n$('save').addEventListener('click',async()=>{try{const data={autoCaptchaEnabled:$('auto-once').checked,speechService:$('service').value,enableManagedLocalServices:true,enableManagedRemoteServices:false,simulateUserInput:false,autoUpdateClientApp:false};if(data.autoCaptchaEnabled&&data.speechService!=='managed')throw Error('单次自动仅支持已准备的本地识别；云服务请关闭自动开关。');for(const [id,key]of Object.entries(fields))data[key]=$(id).value.trim();data.witSpeechApiKeys={english:$('wit-key').value.trim()};if(data.speechService==='ibmSpeechApi'){const u=new URL(data.ibmSpeechApiUrl);if(u.protocol!=='https:'||!u.hostname.endsWith('.speech-to-text.watson.cloud.ibm.com')||u.username||u.password)throw Error('IBM URL 必须是无用户信息的官方 HTTPS 服务地址');}await chrome.storage.local.set(Object.fromEntries(Object.entries(data).map(([key,value])=>[PREFIX+key,value])));$('status').textContent='设置已保存。密钥仅保存在本机扩展存储，不会写入项目或 Git。';}catch(error){$('status').textContent=error.message;}});\n$('prepare').addEventListener('click',async()=>{$('prepare').disabled=true;$('model-status').textContent='正在准备本地模型，请保持此页面打开；首次下载可能耗时数分钟…';try{const result=await chrome.runtime.sendMessage({id:'busterPrepareModel'});if(!result?.ready)throw Error(result?.error||result?.message||'模型准备失败，请检查网络与浏览器控制台');$('model-status').textContent='本地模型已准备好。可手动点击 Buster；如需单次自动辅助，请开启开关并保存设置。';}catch(error){$('model-status').textContent=error.message||String(error);}finally{$('prepare').disabled=false;}});\nload().catch(error=>{$('status').textContent=error.message;});\n";
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const AUTO_WORKER="let embeddedAutoClaiming=false;\nfunction autoDocumentKey(sender){return String(sender.tab.id)+':'+(sender.documentId||String(sender.frameId)+':'+sender.url);}\nasync function autoFrameVisible(sender){\n  try{const state=await browser.tabs.sendMessage(sender.tab.id,{type:'AMP_BUSTER_VISIBLE',challengeUrl:sender.url},{frameId:0});return state?.visible===true;}catch{return false;}\n}\nasync function processAutoControl(request,sender){\n  const preferences=await storage.get(['autoCaptchaEnabled','speechService']);\n  if(preferences.autoCaptchaEnabled!==true)return {allowed:false,reason:'disabled'};\n  if(preferences.speechService!=='managed')return {allowed:false,reason:'自动模式仅使用已准备的本地识别；云服务请手动点击'};\n  if(!await autoFrameVisible(sender))return {allowed:false,reason:'notVisible'};\n  const key=autoDocumentKey(sender);\n  if(request.id==='busterAutoValidate'){\n    const {autoAttemptClaims={}}=await storage.get('autoAttemptClaims',{area:'session'});\n    const entry=autoAttemptClaims[key];\n    return {allowed:!!entry&&entry.token===request.autoClaim,reason:'invalidClaim'};\n  }\n  if(embeddedAutoClaiming||embeddedAudioBusy)return {allowed:false,reason:'已有语音任务运行，本框不自动排队或重试'};\n  embeddedAutoClaiming=true;\n  try{\n    const {autoAttemptClaims={}}=await storage.get('autoAttemptClaims',{area:'session'});\n    if(autoAttemptClaims[key])return {allowed:false,reason:'alreadyAttempted'};\n    if(Object.keys(autoAttemptClaims).length>=64)return {allowed:false,reason:'本次浏览器会话自动次数已达安全上限，请手动处理'};\n    if(await getTransformersApiStatus()!=='available')return {allowed:false,reason:'本地模型尚未准备，请到扩展选项手动准备；本框不自动重试'};\n    const token=crypto.randomUUID();\n    autoAttemptClaims[key]={token,used:false};\n    await storage.set({autoAttemptClaims},{area:'session'});\n    return {allowed:true,autoClaim:token};\n  }finally{embeddedAutoClaiming=false;}\n}\nasync function consumeAutoClaim(request,sender){\n  if(embeddedAutoClaiming)throw Error('自动辅助许可正在处理，本框不自动重试');\n  embeddedAutoClaiming=true;\n  try{\n  const {autoCaptchaEnabled,speechService}=await storage.get(['autoCaptchaEnabled','speechService']);\n  if(!autoCaptchaEnabled||speechService!=='managed'||!await autoFrameVisible(sender))throw Error('自动辅助已关闭或挑战框不再可见');\n  const key=autoDocumentKey(sender);\n  const {autoAttemptClaims={}}=await storage.get('autoAttemptClaims',{area:'session'});\n  const entry=autoAttemptClaims[key];\n  if(!entry||entry.used||entry.token!==request.autoClaim)throw Error('本框的单次自动识别许可无效或已使用');\n  entry.used=true;\n  await storage.set({autoAttemptClaims},{area:'session'});\n  }finally{embeddedAutoClaiming=false;}\n}\n";
const AUTO_BASE="  let autoEnabled=false,autoAttempted=false,autoPending=false,autoViewportVisible=false;\n  let autoTimer=null,autoObserver=null;\n  const autoNotice=message=>browser.runtime.sendMessage({id:'notification',message:'Buster 自动辅助：'+message}).catch(()=>{});\n  function stopAutoWatch(){if(autoTimer!==null){window.clearInterval(autoTimer);autoTimer=null;}autoObserver?.disconnect();autoObserver=null;}\n  function localAutoVisible(){\n    if(document.visibilityState!=='visible'||!autoViewportVisible)return false;\n    return Array.from(document.querySelectorAll('#recaptcha-audio-button,#audio-response,#rc-imageselect,.rc-doscaptcha-body')).some(node=>{const rect=node.getBoundingClientRect(),style=getComputedStyle(node);return rect.width>0&&rect.height>0&&style.visibility!=='hidden'&&style.display!=='none';});\n  }\n  async function validateAutomatic(automatic){\n    if(!automatic)return;\n    if(document.visibilityState!=='visible'||!autoViewportVisible||isBlocked())throw Error('挑战框已隐藏或受限，停止本次自动辅助');\n    const state=await browser.runtime.sendMessage({id:'busterAutoValidate',autoClaim:automatic.autoClaim});\n    if(!state?.allowed)throw Error('自动辅助已关闭或挑战状态变化，请手动处理');\n  }\n  async function checkAutomatic(){\n    if(!autoEnabled||autoAttempted||autoPending||solverWorking||!localAutoVisible())return;\n    autoPending=true;\n    let ownsSolver=false;\n    try{\n      if(isBlocked()||document.querySelector('#audio-response')?.value.trim()){autoAttempted=true;stopAutoWatch();return;}\n      const state=await browser.runtime.sendMessage({id:'busterAutoClaim'});\n      if(!state?.allowed){\n        if(state?.reason==='notVisible'||state?.reason==='disabled')return;\n        autoAttempted=true;stopAutoWatch();\n        if(state?.reason!=='alreadyAttempted')void autoNotice(state?.reason||'无法取得单次许可，请刷新 Arena 或手动处理');\n        return;\n      }\n      autoAttempted=true;\n      if(autoTimer!==null){window.clearInterval(autoTimer);autoTimer=null;}\n      if(solverWorking){stopAutoWatch();return;}\n      ownsSolver=true;\n      setSolverState({working:true});\n      const result=await solve(false,null,state);\n      void autoNotice(result===true?'已完成一次识别和提交，请查看验证结果；探测需手动重启':'本框自动尝试已结束，未完成提交，请手动处理');\n    }catch(error){autoAttempted=true;stopAutoWatch();void autoNotice(String(error?.message||error));}\n    finally{autoPending=false;if(ownsSolver){stopAutoWatch();setSolverState({working:false});}}\n  }\n  function configureAutomatic(){\n    if(!autoEnabled||autoAttempted){stopAutoWatch();return;}\n    if(!autoObserver){\n      const changed=entries=>{const entry=entries[entries.length-1];autoViewportVisible=!!entry?.isIntersecting&&entry.intersectionRatio>0&&entry.isVisible!==false;void checkAutomatic();};\n      try{autoObserver=new IntersectionObserver(changed,{threshold:0.01,trackVisibility:true,delay:200});}\n      catch{autoObserver=new IntersectionObserver(changed,{threshold:0.01});}\n      autoObserver.observe(document.documentElement);\n    }\n    if(autoTimer===null)autoTimer=window.setInterval(()=>void checkAutomatic(),1000);\n  }\n  function startAutomatic(){\n    storage.get('autoCaptchaEnabled').then(data=>{autoEnabled=data.autoCaptchaEnabled===true;configureAutomatic();}).catch(()=>{});\n    busterStorage.onChanged.addListener((changes,area)=>{if(area==='local'&&changes.autoCaptchaEnabled){autoEnabled=changes.autoCaptchaEnabled.newValue===true;configureAutomatic();}});\n    document.addEventListener('visibilitychange',()=>void checkAutomatic());\n    window.addEventListener('pagehide',stopAutoWatch,{once:true});\n  }\n";
const PIN='4f6fa9f26321fd645401e2f96e00cea4f8532e1a';
const source=resolve(process.argv[2]||'');
const stage=process.argv[3]||'prepare';
if(!process.argv[2])throw Error('Usage: node tools/integrate-buster.mjs <upstream clone> prepare|import');
const pending=new Map();
const read=p=>pending.has(p)?pending.get(p):readFileSync(join(source,p),'utf8').replace(/\r\n/g,'\n');
const write=(p,text)=>pending.set(p,text);
function replaceOnce(text,old,value,label){if(text.split(old).length!==2)throw Error('Upstream context mismatch: '+label);return text.replace(old,value);}
function replaceBlock(text,first,last,value,label){const a=text.indexOf(first),b=text.indexOf(last,a+first.length);if(a<0||b<0)throw Error('Upstream block missing: '+label);return text.slice(0,a)+value+text.slice(b);}
function walk(dir){return readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(join(dir,e.name)):[join(dir,e.name)]);}
function cpSync(from,to){if(statSync(from).isDirectory()){mkdirSync(to,{recursive:true});for(const name of readdirSync(from))cpSync(join(from,name),join(to,name));}else{mkdirSync(dirname(to),{recursive:true});copyFileSync(from,to);}}
const ARENA_RX='^https:\\/\\/(?:canary\\.)?arena\\.ai(?:\\/|$)';
if(stage==='prepare'){
  const head=execFileSync('git',['-C',source,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
  if(head!==PIN)throw Error('Only the pinned Buster source is supported: '+PIN);
  if(existsSync(join(source,'vodka-prepared.json'))||existsSync(join(source,'src/storage/isolated.js')))throw Error('Source is already prepared; do not patch twice');
  // Prefix only this fork's storage accesses; leave the raw API in our adapter untouched.
  for(const file of walk(join(source,'src'))){
    if(!/\.(js|html|css|vue)$/.test(file))continue;
    let text=readFileSync(file,'utf8').replace(/\r\n/g,'\n').replaceAll('/src/','/buster/src/').replaceAll("getURL('src/", "getURL('buster/src/");
    if(file.endsWith('.js')&&text.includes('browser.storage')){
      text="import {busterStorage} from 'storage/isolated';\n"+text.replaceAll('browser.storage','busterStorage');
    }
    pending.set(relative(source,file).replaceAll('\\','/'),text);
  }
  write('src/storage/isolated.js',ISOLATED);
  write('src/storage/init.js',INIT);
  let worker=read('src/background/main.js');
  worker=replaceOnce(worker,"const status = await getPromptApiStatus({init: true});","const status = 'unavailable'; // Embedded default: explicit Whisper preload, no implicit browser-model download.",'local model default');
  // Forks do not ship the official managed-cloud credentials. Custom owner-provided API services remain optional.
  worker=worker.replaceAll('enableManagedRemoteServices && !solution','false && !solution').replaceAll('(enableManagedRemoteServices && !solution)','false');
  worker=replaceOnce(worker,"enableManagedRemoteServices)\n", "false)\n",'managed failure path');
  worker=replaceOnce(worker,"const audioBuffer = await (\n    await fetch(audioUrl, {credentials: 'omit'})\n  ).arrayBuffer();",`const audioLocation = new URL(audioUrl);
  if(audioLocation.protocol !== 'https:' || !['google.com','www.google.com','recaptcha.net','www.recaptcha.net'].includes(audioLocation.hostname) || !/^\\/recaptcha\\/(api2|enterprise)\\/payload$/.test(audioLocation.pathname) || audioLocation.username || audioLocation.password) throw Error('Unsupported reCAPTCHA audio URL');
  const audioResponse = await fetch(audioUrl,{credentials:'omit',redirect:'error'});
  if(!audioResponse.ok)throw Error('reCAPTCHA audio HTTP '+audioResponse.status);
  const audioBuffer = await audioResponse.arrayBuffer();
  if(audioBuffer.byteLength>3*1024*1024)throw Error('reCAPTCHA audio is unexpectedly large');`,'audio request boundary');
  worker=replaceOnce(worker,"await processAppUse();","return {handled:true}; // No contribution prompts or unrelated tabs in the host extension.",'donation behavior');
  const listener=`let embeddedAudioBusy=false;
const embeddedIds=new Set(['notification','captchaSolved','transcribeAudio','resetCaptcha','getPlatform','getBrowser','openOptions','busterPrepareModel','busterAutoClaim','busterAutoValidate']);
${AUTO_WORKER}
function onMessage(request,sender,sendResponse){
  if(!request || !embeddedIds.has(request.id))return false;
  const own=!!sender.url&&sender.url.startsWith(browser.runtime.getURL('/'));
  const arena=!!sender.tab?.url&&/^https:\\/\\/(?:canary\\.)?arena\\.ai(?:\\/|$)/.test(sender.tab.url);
  const challenge=!!sender.url&&/^https:\\/\\/(?:www\\.)?(?:google\\.com|recaptcha\\.net)\\/recaptcha\\/(?:api2|enterprise)\\/bframe(?:[?#]|$)/.test(sender.url);
  const response=(async()=>{
    if(!own&&!(arena&&challenge))throw Error('Embedded Buster is restricted to Arena reCAPTCHA frames');
    if(request.id==='busterPrepareModel'&&!own)throw Error('Model preparation requires the extension settings page');
    await setup();
    const autoControl=request.id==='busterAutoClaim'||request.id==='busterAutoValidate';
    const automaticAudio=request.id==='transcribeAudio'&&request.automatic===true;
    if(autoControl||automaticAudio){
      if(!arena||!challenge||!Number.isInteger(sender.tab?.id)||sender.frameId<=0)throw Error('Automatic assistance requires an Arena challenge frame');
      if(autoControl)return await processAutoControl(request,sender);
      await consumeAutoClaim(request,sender);
    }
    const audio=request.id==='transcribeAudio'||request.id==='busterPrepareModel';
    if(audio&&embeddedAudioBusy)throw Error('已有语音任务运行，请稍后再手动点击');
    if(audio)embeddedAudioBusy=true;
    try{
      if(request.id==='busterPrepareModel'){
        await setupOffscreenDocument({url:'/buster/src/offscreen/index.html',reasons:['USER_MEDIA'],justification:'User-requested local speech model preparation'});
        try{return await sendOffscreenMessage({id:'prepareModel'});}finally{await browser.offscreen.closeDocument();}
      }
      return await processMessage(request,sender);
    }finally{if(audio)embeddedAudioBusy=false;}
  })();
  const answer=request.id==='busterPrepareModel'?response.catch(error=>({ready:false,error:String(error?.message||error)})):response;
  return processMessageResponse(answer,sendResponse);
}

`;
  worker=replaceBlock(worker,'function onMessage(request, sender, sendResponse) {','async function onClientAppInstall()',listener,'message isolation');
  worker=replaceBlock(worker,"async function setup({event = ''} = {}) {",'function init() {',`let embeddedSetup;
function setup(){
  if(!embeddedSetup)embeddedSetup=(async()=>{await initStorage();await initStorage({area:'session'});})().catch(error=>{embeddedSetup=null;throw error;});
  return embeddedSetup;
}

`,'host-safe setup');
  worker=replaceOnce(worker,'  addActionListener();\n  addMessageListener();\n  addInstallListener();\n  addStartupListener();\n\n  setup();',"  addMessageListener();\n  addStartupListener();\n  setup().catch(error=>console.error('Embedded Buster setup:',error));",'no action takeover');
  worker=replaceOnce(worker,"async function transcribeAudio(audioUrl, lang) {","async function transcribeAudio(audioUrl, lang, {automatic=false} = {}) {","single automatic local transcription");
  worker=replaceOnce(worker,"    speechService,\n    tryEnglishSpeechModel,","    speechService:configuredSpeechService,\n    tryEnglishSpeechModel,","single automatic local transcription");
  worker=replaceOnce(worker,"  if (speechService === 'managed' && enableManagedLocalServices) {","  const speechService=automatic?'managed':configuredSpeechService; // Never route automatic audio to an owner-key cloud service.\n  if (speechService === 'managed' && enableManagedLocalServices) {","single automatic local transcription");
  worker=replaceOnce(worker,"return await transcribeAudio(request.audioUrl, request.lang);","return await transcribeAudio(request.audioUrl, request.lang, {automatic:request.automatic===true});","single automatic local transcription");
  write('src/background/main.js',"import 'utils/public-path';\n"+worker);
  let base=read('src/base/main.js');
  base=replaceOnce(base,'function main() {',`function main() {
  const parents=Array.from(self.location.ancestorOrigins||[]);
  if(!parents.some(origin=>/^https:\\/\\/(?:canary\\.)?arena\\.ai$/.test(origin)))return;`,'Arena frame scope');
  base=replaceBlock(base,'  async function runSolver(ev) {','  function init() {',`  async function runSolver(ev) {
    await solve(false,ev); // Preserve the upstream trusted user click; no native simulation client.
  }

`,'manual-only solver');
  base=replaceOnce(base,"messageId: 'error_internalError'","message: 'Buster: '+String(err?.message||err)",'visible module errors');
  base=replaceOnce(base,"import storage from 'storage/storage';","import storage from 'storage/storage';\nimport {busterStorage} from 'storage/isolated';","optional automatic once");
  base=replaceOnce(base,"  async function solve(simulateUserInput, clickEvent) {","  async function solve(simulateUserInput, clickEvent, automatic=null) {\n    await validateAutomatic(automatic);","optional automatic once");
  base=replaceOnce(base,"      const audioButton = document.querySelector('#recaptcha-audio-button');","      const audioButton = document.querySelector('#recaptcha-audio-button');\n      if(automatic&&(!audioButton||audioButton.disabled))throw Error('当前挑战没有可用音频，请手动处理');\n      await validateAutomatic(automatic);","optional automatic once");
  base=replaceOnce(base,"    const audioUrl = audioEl.src;","    if(automatic&&(!audioEl||!audioEl.src))throw Error('未取得挑战音频，本框不自动重试');\n    await validateAutomatic(automatic);\n    const audioUrl = audioEl.src;","optional automatic once");
  base=replaceOnce(base,"      audioUrl,\n      lang\n","      audioUrl,\n      lang,\n      ...(automatic?{automatic:true,autoClaim:automatic.autoClaim}:{})\n","optional automatic once");
  base=replaceOnce(base,"    const input = document.querySelector('#audio-response');","    await validateAutomatic(automatic);\n    if(automatic&&document.querySelector(audioElSelector)?.src!==audioUrl)throw Error('挑战音频已更新，停止本次自动辅助');\n    const input = document.querySelector('#audio-response');\n    if(automatic&&(!input||input.value.trim()))throw Error('没有可用空输入框，自动辅助不覆盖手动内容');","optional automatic once");
  base=replaceOnce(base,"    browser.runtime.sendMessage({id: 'captchaSolved'});","    browser.runtime.sendMessage({id: 'captchaSolved'});\n    return true; // Submission only, not proof that verification succeeded.","optional automatic once");
  base=replaceOnce(base,"  function solveChallenge(ev) {",AUTO_BASE+"\n  function solveChallenge(ev) {","optional automatic once");
  base=replaceOnce(base,"    syncUI();\n  }\n\n  init();","    syncUI();\n    startAutomatic();\n  }\n\n  init();","optional automatic once");
  write('src/base/main.js',base);
  let common=read('src/utils/common.js');
  common=replaceBlock(common,'function isBackgroundPageContext() {','function getExtensionDomain() {',"function isBackgroundPageContext() { return typeof document === 'undefined'; }\n\n",'host worker context');
  common=replaceBlock(common,'function sendOffscreenMessage(message) {','function getStore(name, {content = null} = {}) {',"function sendOffscreenMessage(message) {\n  return new Promise((resolve,reject)=>{\n    let finished=false,port;\n    const finish=(error,response)=>{\n      if(finished)return;\n      finished=true;\n      self.clearTimeout(timeoutId);\n      try{port?.disconnect();}catch{}\n      if(error)reject(error);else resolve(response);\n    };\n    const timeoutId=self.setTimeout(()=>finish(new Error('音频处理超时，请检查网络并手动重试')),message.id==='prepareModel'?600000:120000);\n    try{\n      port=browser.runtime.connect({name:'offscreen'});\n      port.onDisconnect.addListener(()=>{\n        const error=browser.runtime.lastError?.message;\n        finish(new Error('音频处理页面未连接或已退出：'+(error||'请重新加载扩展并检查 offscreen 页面错误')));\n      });\n      port.onMessage.addListener(response=>finish(response?.error?new Error(response.error):null,response));\n      port.postMessage(message);\n    }catch(error){finish(error);}\n  });\n}\n\n",'offscreen connection lifecycle');
  write('src/utils/common.js',common);
  let models=read('src/utils/models.js');
  models=replaceOnce(models,"  const options = {device: 'wasm', dtype: 'q8'};","  // Keep cached q8 weights; bypass the ONNX QDQ transpose optimization failure.\n  const options = {device: 'wasm', dtype: 'q8', session_options: {graphOptimizationLevel: 'disabled'}};",'avoid QDQ optimizer regression');
  models=replaceOnce(models,"browser.runtime.getURL('buster/src/wasm/');","browser.runtime.getURL('buster/src/wasm/');\n  transformersEnv.backends.onnx.wasm.numThreads = 1;",'single-threaded local model');
  models=replaceOnce(models,"    return await pipeline(...params);\n  } catch (err) {\n    console.log(err.toString());\n  }","    return await pipeline(...params);\n  } catch (err) {\n    const detail=String(err?.message||err).replace(/https?:\\/\\/[^\\s\"'<>]+/g,value=>{try{const url=new URL(value);url.search='';url.hash='';return url.href;}catch{return 'URL';}}).slice(0,1200);\n    throw new Error('Whisper 加载失败：'+detail);\n  }",'surface local model failures');
  models=replaceOnce(models,"async function getTransformersApiSession({params = null} = {}) {","async function getTransformersApiSession({params = null, cachedOnly=false} = {}) {","cached-only inference");
  models=replaceOnce(models,"  try {\n    return await pipeline(...params);","  const allowLocalModels=transformersEnv.allowLocalModels;\n  if(cachedOnly){\n    // Transformers checks caches first; allowLocalModels is required by local_files_only.\n    transformersEnv.allowLocalModels=true;\n    params=[params[0],params[1],{...params[2],local_files_only:true}];\n  }\n  try {\n    return await pipeline(...params);","cached-only inference");
  models=replaceOnce(models,"    throw new Error('Whisper 加载失败：'+detail);\n  }\n}","    throw new Error('Whisper 加载失败：'+detail);\n  }finally{transformersEnv.allowLocalModels=allowLocalModels;}\n}","cached-only inference");
  models=replaceOnce(models,"  const session = await getTransformersApiSession();","  const session = await getTransformersApiSession({cachedOnly:true}); // Inference never downloads missing model files.","cached-only inference");
  write('src/utils/models.js',models);
  let off=read('src/offscreen/main.js');
  off=replaceOnce(off,"  messagePort.postMessage({result});","  if(status !== 'available')throw new Error('本地模型尚未准备：右键扩展图标打开人机辅助设置，先下载/准备 Whisper 模型');\n  messagePort.postMessage({result});",'missing model guidance');
  off=replaceBlock(off,'function onMessage(request) {','let messagePort;',`function onMessage(request) {
  const task=(async()=>{
    if(request.id==='prepareModel'){
      const session=await getTransformersApiSession();
      if(!session)throw Error('本地模型准备失败，请检查 Hugging Face 连接及浏览器支持');
      await session.dispose(); messagePort.postMessage({ready:true});
    }else if(request.id==='processAudio')await processAudio(request.audioString,request.audioOptions);
    else if(request.id==='transcribeAudio')await transcribeAudio(request.audioString,request.audioOptions);
  })();
  const heartbeat=setInterval(()=>browser.runtime.sendMessage({id:'busterOffscreenHeartbeat'}).catch(()=>{}),20000);
  task.catch(error=>{try{messagePort.postMessage({error:String(error?.message||error)});}catch{}}).finally(()=>clearInterval(heartbeat));
}

`,'offscreen preload');
  write('src/offscreen/main.js',"import 'utils/public-path';\n"+off);
  write('src/utils/public-path.js',"// SPDX-License-Identifier: GPL-3.0-only\n__webpack_public_path__=browser.runtime.getURL('/buster/src/');\n");
  let webpack=read('webpack.config.js');
  webpack=replaceOnce(webpack,"      options: './src/options/main.js',\n",'', 'exclude unrelated options bundle');
  webpack=replaceOnce(webpack,"      setup: './src/setup/main.js',\n",'', 'exclude native setup bundle');
  write('webpack.config.js',webpack);
  // Actual source and adapter remain reproducible; the build output is imported in the second phase.
  write('vodka-prepared.json',JSON.stringify({upstreamCommit:PIN,preparedAt:new Date().toISOString()},null,2));
  for(const [name,text]of pending){mkdirSync(dirname(join(source,name)),{recursive:true});writeFileSync(join(source,name),text);}
  console.log('BUSTER_SOURCE_PREPARED');
}else if(stage==='import'){
  if(!existsSync(join(source,'vodka-prepared.json')))throw Error('Prepare the pinned source before importing');
  const out=join(source,'dist','chrome');
  for(const name of ['src/background/script.js','src/base/script.js','src/offscreen/script.js'])if(!existsSync(join(out,name)))throw Error('Buster build output missing: '+name);
  if(existsSync(join(ROOT,'buster')))throw Error('buster/ already exists; avoid overwriting an existing integration');
  const dest=join(ROOT,'buster');mkdirSync(dest,{recursive:true});
  for(const name of ['base','background','offscreen','wasm'])cpSync(join(out,'src',name),join(dest,'src',name),{recursive:true});
  for(const name of readdirSync(join(out,'src'))){if(/\.mjs(?:\.LICENSE\.txt)?$/.test(name))cpSync(join(out,'src',name),join(dest,'src',name));}
  const nestedOrt=join(source,'node_modules','@huggingface','transformers','node_modules','onnxruntime-web');
  const ort=existsSync(nestedOrt)?nestedOrt:join(source,'node_modules','onnxruntime-web');
  mkdirSync(join(dest,'licenses'),{recursive:true});
  writeFileSync(join(dest,'licenses','onnxruntime-web-LICENSE'),existsSync(join(ort,'LICENSE'))?readFileSync(join(ort,'LICENSE'),'utf8'):"MIT License\n\nCopyright (c) Microsoft Corporation\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the \"Software\"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.\n"); // Microsoft/onnxruntime LICENSE: full MIT text (npm pre-release omits it).
  for(const name of readdirSync(join(ort,'dist'))){if(/^ort-wasm-simd-threaded\.asyncify\.(?:wasm|mjs)$/.test(name))cpSync(join(ort,'dist',name),join(dest,'src','wasm',name));}
  mkdirSync(join(dest,'src','scripts'),{recursive:true});
  cpSync(join(out,'src','scripts','reset.js'),join(dest,'src','scripts','reset.js'));
  cpSync(join(out,'src','assets','icons'),join(dest,'src','assets','icons'),{recursive:true});
  if(existsSync(join(ROOT,'_locales')))throw Error('Existing locale catalog needs explicit merging');
  cpSync(join(out,'_locales'),join(ROOT,'_locales'),{recursive:true});
  mkdirSync(join(dest,'src','options'),{recursive:true});
  writeFileSync(join(dest,'src','options','index.html'),OPTIONS_HTML);
  writeFileSync(join(dest,'src','options','style.css'),OPTIONS_CSS);
  writeFileSync(join(dest,'src','options','options.js'),OPTIONS_JS);
  for(const pkg of Object.keys(JSON.parse(read('package.json')).dependencies||{})){
    const p=join(source,'node_modules',pkg);
    if(!existsSync(p))continue;
    for(const name of readdirSync(p)){if(/^(?:license|copying|notice)(?:[.-].*)?$/i.test(name)){
      const destFile=join(dest,'licenses',pkg.replaceAll('/','-')+'-'+name);
      mkdirSync(dirname(destFile),{recursive:true});cpSync(join(p,name),destFile,{recursive:true});
    }}
  }
  const sourceDest=join(ROOT,'vendor','buster','upstream');mkdirSync(sourceDest,{recursive:true});
  for(const item of readdirSync(source,{withFileTypes:true})){
    if(['.git','node_modules','dist','artifacts','secrets.json','secrets.txt','vodka-prepared.json'].includes(item.name))continue;
    cpSync(join(source,item.name),join(sourceDest,item.name),{recursive:true});
  }
  const license=read('LICENSE');
  if(existsSync(join(ROOT,'LICENSE'))&&readFileSync(join(ROOT,'LICENSE'),'utf8')!==license)throw Error('Existing host LICENSE requires an explicit merge');
  writeFileSync(join(ROOT,'LICENSE'),license);
  writeFileSync(join(dest,'NOTICE.md'),`# Embedded Buster\n\nDerived from dessant/buster 3.4.0, commit ${PIN}.\nCopyright (c) 2018-2026 Armin Sebastian. GPL-3.0-only; see the root LICENSE.\n\nVodka modifications: Arena-only trusted manual UI and default-off local automatic once; per-document session claims; private storage namespace; host-safe messages and setup; local Whisper preparation; custom settings; no managed-cloud secrets or native client.\nCorresponding adapted upstream source is in vendor/buster/upstream. Recipe and adapter source are in tools/integrate-buster.mjs; npm package versions are pinned in the preserved upstream package-lock.json. Existing ModelTrace MIT notices and license remain unchanged.\n\nBuild: clone the pinned commit, npm ci, run the recipe prepare phase, ENABLE_CONTRIBUTIONS=false ENABLE_SPONSORS=false npm run build:prod:chrome, then run recipe import. Requires the upstream-supported Node toolchain. No captcha success or browser runtime testing is asserted.\n`);
  const runtime=[...walk(dest),...walk(join(ROOT,'_locales'))].map(path=>relative(ROOT,path).replaceAll('\\','/'));
  const corresponding=[...walk(join(ROOT,'vendor','buster'))].map(path=>relative(ROOT,path).replaceAll('\\','/'));
  writeFileSync(join(dest,'runtime-files.json'),JSON.stringify({upstreamCommit:PIN,runtimeFiles:runtime.sort(),correspondingSource:[...corresponding,'tools/integrate-buster.mjs'].sort()},null,2)+'\n');
  console.log('BUSTER_RUNTIME_IMPORTED',runtime.length,'runtime assets;',corresponding.length,'source files');
}else if(stage==='recopy'){
  const dest=join(ROOT,'buster'),out=join(source,'dist','chrome');
  if(!readFileSync(join(dest,'NOTICE.md'),'utf8').includes(PIN))throw Error('Recovery is only allowed for this newly imported pinned module');
  for(const name of ['base','background','offscreen','wasm'])cpSync(join(out,'src',name),join(dest,'src',name));
  cpSync(join(out,'src','assets','icons'),join(dest,'src','assets','icons'));
  cpSync(join(out,'_locales'),join(ROOT,'_locales'));
  const nestedOrt=join(source,'node_modules','@huggingface','transformers','node_modules','onnxruntime-web');
  const ort=existsSync(nestedOrt)?nestedOrt:join(source,'node_modules','onnxruntime-web');
  mkdirSync(join(dest,'licenses'),{recursive:true});
  writeFileSync(join(dest,'licenses','onnxruntime-web-LICENSE'),existsSync(join(ort,'LICENSE'))?readFileSync(join(ort,'LICENSE'),'utf8'):"MIT License\n\nCopyright (c) Microsoft Corporation\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the \"Software\"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.\n"); // Microsoft/onnxruntime LICENSE: full MIT text (npm pre-release omits it).
  for(const name of readdirSync(join(ort,'dist'))){if(/^ort-wasm-simd-threaded\.asyncify\.(?:wasm|mjs)$/.test(name))cpSync(join(ort,'dist',name),join(dest,'src','wasm',name));}
  for(const item of readdirSync(source,{withFileTypes:true})){
    if(['.git','node_modules','dist','artifacts','secrets.json','secrets.txt','vodka-prepared.json'].includes(item.name))continue;
    cpSync(join(source,item.name),join(ROOT,'vendor','buster','upstream',item.name));
  }
  const runtime=[...walk(dest),...walk(join(ROOT,'_locales'))].filter(path=>!path.endsWith('runtime-files.json')).map(path=>relative(ROOT,path).replaceAll('\\','/'));
  const corresponding=walk(join(ROOT,'vendor','buster')).map(path=>relative(ROOT,path).replaceAll('\\','/'));
  writeFileSync(join(dest,'runtime-files.json'),JSON.stringify({upstreamCommit:PIN,runtimeFiles:runtime.sort(),correspondingSource:[...corresponding,'tools/integrate-buster.mjs'].sort()},null,2)+'\n');
  console.log('BUSTER_RUNTIME_IMPORTED',runtime.length,'runtime assets;',corresponding.length,'source files');
}else if(stage==='catalog'){
  const dest=join(ROOT,'buster');
  if(existsSync(join(dest,'runtime-files.json')))throw Error('Catalog already exists');
  for(const name of ['buster/NOTICE.md','_locales/en/messages.json','vendor/buster/upstream/package-lock.json','LICENSE'])if(!existsSync(join(ROOT,name)))throw Error('Incomplete imported module: '+name);
  const runtime=[...walk(dest),...walk(join(ROOT,'_locales'))].map(path=>relative(ROOT,path).replaceAll('\\','/'));
  const corresponding=walk(join(ROOT,'vendor','buster')).map(path=>relative(ROOT,path).replaceAll('\\','/'));
  writeFileSync(join(dest,'runtime-files.json'),JSON.stringify({upstreamCommit:PIN,runtimeFiles:runtime.sort(),correspondingSource:[...corresponding,'tools/integrate-buster.mjs'].sort()},null,2)+'\n');
  console.log('BUSTER_RUNTIME_IMPORTED',runtime.length,'runtime assets;',corresponding.length,'source files');
}else throw Error('Unknown phase: '+stage);

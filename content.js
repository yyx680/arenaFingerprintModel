/* Arena Model Probe v2.1.1 controller and HUD · 由 Vodka 制作。

   Standalone pipeline: 发送数字探针 → 捕获回复 → 本机指纹评分 → 自动重命名会话。
   v2.0.0：连续自动抽卡（New Chat → 发探针 → 识别 → 改名 → 下一轮）与 Arena 每日额度显示。
   v2.1.0：识别模式 —— 快速（随机 1 题）/ 精准（3 题全问），并支持「再补 1 题」逐步加强证据。
   v2.2.0：抽卡每轮先发随机数学题过人机验证；新增「拦截 thinking」开关（检测到 thinking 立即截断并进入下一轮）。
   v2.3.0：thinking 截断后自动删除该轮新建的对话（只走可见 UI：菜单 → 删除 → 确认）。
   v2.4.0：更快更准 —— 回复数字数量达标即停（截掉尾巴，不再空等）；快速模式判定不清晰时自动补题（最多 3 题）加强证据。
   v2.4.1：删除对话更宽容（等生成结束、Esc 收弹层、文案正则匹配、等菜单项可用），并为删不掉的会话建立「待删队列」，可一键重试。
   v2.5.0：池化评分 —— 同一会话的多条证据合并成一份更大的分布再算一次余弦，与逐条平均各占一半；结果里显示证据数字总数与「池化」标记。
   v2.5.2：Arena 侧栏菜单现在给的是「归档（Archive）」——插件优先归档、找不到归档项再退回删除；文案改为「清理」。
   v2.5.3：自检按钮会把第一个会话的侧栏菜单结构（每个条目的 role/aria-label/title/文本/是否禁用）打印出来，方便定位结构变化；忙锁超过 60 秒自动失效，避免卡住后续重命名。
   v2.5.4：按用户要求移除「待删队列 / 重试清理废对话」——清理只在该轮做一次，失败只报告，不再排队与后台重试。
   v2.6.0：置信度门槛 —— 只有「清晰匹配」才自动改会话名，判定不清晰时只显示 Top3/拟合/分离（浮层可勾「不确定也改名」恢复旧行为）。
   v2.6.1：门槛按蒙特卡洛标定下调（0.15/0.06）——同样 100% 精度下，可命名的比例从 32% 提到 60%（3 题时 87%）。
   v2.7.0：家族级兜底（不清晰时显示「GPT 家族」）+ scene 第二通道（12 汉字题，本机簇表）+ 本机标定统计（每轮记录，浮层显示）。
   v2.7.1：scene 通道改为默认关闭（修抽卡卡住风险），开启时每步有进度、超时收短到 15s/60s。
   v2.7.2：发送确认（点发送后 12 秒无动静自动再点一次）+ 数字探针前自动点掉「继续工作」弹窗，修「点一下就没后续」的静默卡住。
   v2.7.3：修 v2.7.0 引入的作用域错误（scene/本机统计的函数被误放进 sanitizePrefs 内部，HUD 渲染时抛 “localSummary is not defined”，导致界面卡住）。
   v2.9.2：开集似然比置信集 + 同族收缩 + 网络轨迹直读 + 流式节奏票 + 单 token 电池 + 本机分环境建档；单 token 支持历史回复恢复与多格式答案提取；命名用平衡阈值。
   v2.9.18：删除「自动建档 / 一键建档局（接口建档）/ UI建档局」三个入口及其流程代码，并清掉本机建档标注/摘要/导出（已知模型名输入框、「存」、建档进度行、导出本机建档 JSON）；并整体移除单 token 电池通道（按钮、状态行、解析与内嵌调用）；修抽卡期间浮层被收起后手动展开又被立刻收起（弹不出来）的问题。
    v2.9.19：清掉下线功能的残留后台处理（AMP_BANK_STATUS / AMP_EXPORT_EVIDENCE）及其本机数据 amp.token.evidence.v1 / amp.manualLabels.v1；识别门槛从一刀切 0.15 改为按每个模型自身分布自举标定（上限 0.18），多题证据池权重 0.5→0.65。
    v2.9.20：修拟合门槛自举与真实判定统计量不匹配的问题（原来只按单份大样本算一次余弦，标定偏严），分位定 0.15；另试过融合分数分离度、后验门、更严分位、每题要更多数字，蒙特卡洛复测都只是沿「命名率 vs 漂移误报」曲线滑动，故一律不采用。
   v2.9.23：修「页面不在前台（后台标签页）就识别不出模型」：隐藏页链式 setTimeout 被 Chrome 降频（隐藏超 5 分钟后 1 分钟/次）导致秒级轮询假超时；失焦文档里 execCommand('insertText'/'delete') 被拒绝导致探针写不进输入框。sleep 改为后台 SW 计时器竞速唤醒；writeEditor 增加受信任键入与合成 setter 兜底；发送确认二次点击改走受信任点击。
   v2.9.25：品牌改为 BY Vodka（原 BY PERKICA）；打包发布。
    2.9.24：性能与稳定性优化——轮询改 MutationObserver 变更唤醒（domTick，无变化低频兜底、有变化即时复查）；innerText 加 250ms 拍内读缓存；嗅探器 Worker 消息降耗（字符串直扫、跳过大字符串/二进制）；New Chat 链接与侧栏按钮改受信任点击兜底。
   额度端点 /api/me/pulse 的语义来自 Arena Trace Inspector 2.3.2，详见 billing.js 顶部注释。 */
(() => {
  const {probes,sceneProbes,sceneParseChoice,sceneParsePick,sceneVote,signatures,selectCandidate,isTaskSuccessText,isContinueWorkText,renameTitleForResult,planProbes,validateScene,findSceneSentence,sceneKeyOf,sceneClusterOf,TEXT_PROBES,TEXT_SCORE_PROBES,TEXT_BANK_TARGET}=globalThis.ArenaProbeRuntime;
  const records=new Map();
  const HOST_ID='arena-model-probe-standalone';
  const PREFS_KEY='amp.draw.prefs.v3';
  const LEGACY_PREFS_KEY='amp.draw.prefs.v2';
  const DEFAULTS=Object.freeze({rounds:5,mode:'quick',minPulse:0,blockThinking:false,autoTopUp:true,renameAnyway:false,sceneChannel:true});
  const MODE_LABEL=Object.freeze({quick:'快速 · 随机 1 题',precise:'精准 · 3 题全问'});
  const draw={running:false,cancelled:false,total:0,round:0,completed:0,failed:0,renamed:0,blocked:0,deleted:0,phase:'idle',note:'',results:[]};
  let prefs={...DEFAULTS};
  let host=null,root=null,collapsed=false,autoCollapsed=false;
  let runOneButton,runAllButton,stopButton,clearButton,progressNode,resultNode,resultModel,resultBadge,resultMetrics,resultBank,traceNode,compactText;
  let drawInput,drawMode,drawMinPulse,drawBlockThinking,drawAutoTopUp,drawRenameAnyway,drawSceneChannel,drawStartButton,drawStopButton,drawProgressNode,drawResultsNode,balanceNode,balanceNote,balanceButton,diagnoseButton,appendButton;
  let running=false,cancelled=false,sent=false,targetSession=null,phase='idle',progress='点击即发送真实探针，不再弹出确认';
  let pendingPrompt='';
  let balanceInfo=null,balanceError='',balanceLoading=false;

  const visible=element=>{
    if(!element?.isConnected||!element.getClientRects().length)return false;
    if(['dialog','alertdialog','menu'].includes(element.getAttribute('role'))&&element.getAttribute('data-state')==='closed')return false;
    if(typeof getComputedStyle==='function'){const style=getComputedStyle(element);if(style.display==='none'||style.visibility==='hidden')return false;}
    return true;
  };
  const session=()=>{const match=location.pathname.match(/^\/[^\s]+\/([a-zA-Z0-9-]{8,128})\/?$/);return match&&!/^(?:code|text|webdev|image|search|vision|login|signup|settings)$/i.test(match[1])?match[1]:null;}; // 各模式会话统一取末段 ID（≥8 位，排除 code 等路由词）
  const agentPage=()=>location.origin==='https://arena.ai'; // arena.ai 全站显示浮层（Battle 挂在首页路径，不再排除首页）
  const agentPath=()=>location.pathname.replace(/\/$/,'');
  const editors=()=>{const editable=[...document.querySelectorAll('[contenteditable="true"]')].filter(visible);return editable.length?editable:[...document.querySelectorAll('textarea:not([readonly]):not([disabled])')].filter(visible);}; // battle 等聊天页用 textarea：无 contenteditable 时回退
  const editorText=element=>String(element?.tagName==='TEXTAREA'?(element?.value??''):(element?.innerText??element?.textContent??'')).trim();
  // Arena contenteditable may reserialize inserted multiline text as paragraphs or CRLF; compare the same visible text modulo whitespace only.
  const promptComparable=value=>String(value??'').normalize('NFKC').replace(/[\u200b\uFEFF]/g,'').replace(/\u00a0/g,' ').replace(/\s+/g,' ').trim();
  const promptMatches=(element,expected)=>promptComparable(editorText(element))===promptComparable(expected);
  const combos=()=>[...document.querySelectorAll('button[role="combobox"],[role="combobox"]')].filter(visible);
  const isWorkMode=element=>/^(?:Agent|Work)(?:\s|$)/i.test(element.textContent.trim());
  const modeReady=()=>combos().some(isWorkMode);
  const battleMode=()=>combos().some(element=>/battle|对战|匿名/i.test(String(element?.textContent||''))); // Battle（匿名对战）模式下组合框回显不含 Agent/Work
  const isNewChatPath=path=>/^\/(?:(?:agent|work|code|text|image|video|search)\/?)?$/.test(path); // v2.9.15：各模式新聊天根路径——battle 首页 /、Code 页 /code（每模式 New Chat 链接指向自己模式的根）
  /* 页面性能：generating() 每个 tick 全页两次 querySelector —— 250ms 拍内缓存与 domTick 最小复查间隔对齐；
     各调用点的等待预算（1.2s 稳定窗 / 6s 截断窗等）都远大于 250ms，−250ms 时滞不影响判定。 */
  const generatingCompute=()=>[...document.querySelectorAll('button[aria-label]')].some(element=>visible(element)&&/stop|cancel/i.test(element.getAttribute('aria-label')||''))||[...document.querySelectorAll('[data-streaming="true"],[aria-busy="true"]')].some(visible);
  const generating=()=>cachedRead('generating',250,generatingCompute);
  /* v2.9.23：防节流 sleep —— 隐藏标签页的链式 setTimeout 会被 Chrome 双重降频（隐藏后钳 1 秒、超 5 分钟降到 1 分钟/次），
     confirmSend/waitFor 的秒级窗口会大面积假超时（后台抽卡「识别不出模型」的直接原因）。
     改为后台 SW 计时器竞速：SW 的 setTimeout 不受页面可见性节流，经长连接端口回唤醒；
     SW 不可用时退回页面计时器兜底。每次调用都发一条消息，顺带持续重置 SW 空闲计时，抽卡全程不被回收。 */
  let timerPort=null,timerSeq=0;const timerWaiters=new Map();
  function ensureTimerPort(){
    try{
      if(timerPort)return timerPort;
      const port=chrome.runtime.connect({name:'amp-timer'});
      port.onMessage.addListener(message=>{const finish=timerWaiters.get(message&&message.id);if(finish){timerWaiters.delete(message.id);finish();}});
      port.onDisconnect.addListener(()=>{timerPort=null;});
      timerPort=port;return port;
    }catch{return null;}
  }
  const sleep=ms=>new Promise(resolve=>{
    const id=++timerSeq;let done=false;
    const finish=()=>{if(done)return;done=true;clearTimeout(fallback);timerWaiters.delete(id);resolve();};
    const fallback=setTimeout(finish,Math.max(0,ms)+50); // SW 失联时按页面计时器兜底
    try{
      const port=ensureTimerPort();
      if(port){timerWaiters.set(id,finish);port.postMessage({type:'AMP_TIMER',id,ms:Math.max(0,ms)});}
    }catch{finish();}
  });
  /* v2.9.24：变更唤醒等待 —— MutationObserver 驱动：页面无变化按 maxMs 低频兜底，有变化 minMs 后立刻复查；
     替代固定 250/350ms 轮询，空闲 CPU 大降、回复文本一落地就检测。observer 不可用时退化为纯超时（行为等同旧轮询）。 */
  function domTick(maxMs=1200,minMs=250){
    return new Promise(resolve=>{
      const started=Date.now();let done=false,floor=null,hard=null,observer=null;
      const finish=()=>{if(done)return;done=true;if(floor)clearTimeout(floor);if(hard)clearTimeout(hard);try{observer&&observer.disconnect();}catch{}resolve();};
      try{
        observer=new MutationObserver(()=>{
          const elapsed=Date.now()-started;
          if(elapsed>=minMs)finish();
          else if(!floor)floor=setTimeout(finish,minMs-elapsed);
        });
        observer.observe(document.body||document.documentElement||document,{subtree:true,childList:true,characterData:true,attributes:true});
      }catch{observer=null;}
      hard=setTimeout(finish,maxMs);
    });
  }
  /* v2.9.24：innerText 是强制布局读 —— 同一拍内多处读取走 250ms 短缓存，重复读取只算一次。 */
  const readCache=new Map();
  function cachedRead(key,ttl,compute){
    const now=Date.now(),hit=readCache.get(key);
    if(hit&&now-hit.at<ttl)return hit.value;
    const value=compute();
    readCache.set(key,{at:now,value});
    return value;
  }
  const fatal=message=>Object.assign(Error(message),{fatal:true});
  const pctText=value=>typeof value==='number'&&Number.isFinite(value)?(Math.round(value*10)/10)+'%':'—';
  const clock=iso=>{const date=iso?new Date(iso):null;return date&&Number.isFinite(date.getTime())?`${date.getMonth()+1}-${date.getDate()} ${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`:'—';};

  /* ---------- 偏好设置：chrome.storage.local；不可用时退化为内存设置 ---------- */
  const clampInt=(value,min,max,fallback)=>{const number=Number(value);return Number.isInteger(number)&&number>=min&&number<=max?number:fallback;};
  function sanitizePrefs(value){
    // 兼容 2.0.x 的 probesPerChat：3 条 → 精准，其余 → 快速。
    const mode=value?.mode==='precise'||value?.probesPerChat===3?'precise':'quick';
    return {rounds:clampInt(value?.rounds,1,100,DEFAULTS.rounds),mode,minPulse:clampInt(value?.minPulse,0,100,DEFAULTS.minPulse),blockThinking:value?.blockThinking===true,autoTopUp:value?.autoTopUp!==false,renameAnyway:value?.renameAnyway===true,sceneChannel:value?.sceneChannel!==false};


  }
  const storageGet=key=>new Promise(resolve=>{try{chrome.storage.local.get(key,items=>resolve(items&&typeof items==='object'?items:{}));}catch{resolve({});}});
  const storageSet=value=>new Promise(resolve=>{try{chrome.storage.local.set(value,()=>resolve(true));}catch{resolve(false);}});
  /* ---------- v2.7.0 本机 scene 通道 + 本机标定（全部只存本机） ---------- */
  const SCENE_KEY='amp.scene.bank.v1';
  const STATS_KEY='amp.local.stats.v1';
  let sceneBank={clusters:[],byPrompt:{}},localStats={rounds:0,clear:0,fits:[],seps:[]};
  async function loadLocalState(){try{const items=await storageGet([SCENE_KEY,STATS_KEY]);const bank=items&&items[SCENE_KEY];const stats=items&&items[STATS_KEY];if(bank&&typeof bank==='object'){sceneBank={clusters:Array.isArray(bank.clusters)?bank.clusters.slice(0,60):[],byPrompt:bank.byPrompt&&typeof bank.byPrompt==='object'?bank.byPrompt:{}};}if(stats&&typeof stats==='object')localStats={rounds:Number(stats.rounds)||0,clear:Number(stats.clear)||0,fits:Array.isArray(stats.fits)?stats.fits.slice(-40):[],seps:Array.isArray(stats.seps)?stats.seps.slice(-40):[]};}catch{}}
  const saveSceneBank=async()=>{try{await storageSet({[SCENE_KEY]:{clusters:sceneBank.clusters.slice(0,60),byPrompt:sceneBank.byPrompt||{},updatedAt:Date.now()}});}catch{}};
  const saveLocalStats=async()=>{try{await storageSet({[STATS_KEY]:{rounds:localStats.rounds,clear:localStats.clear,fits:localStats.fits.slice(-40),seps:localStats.seps.slice(-40)}});}catch{}};
  const medianOf=list=>{if(!list||!list.length)return null;const sorted=[...list].sort((left,right)=>left-right);return sorted[Math.floor(sorted.length/2)];};
  const localSummary=()=>{const rate=localStats.rounds?Math.round(100*localStats.clear/localStats.rounds):0;const fit=medianOf(localStats.fits);const sep=medianOf(localStats.seps);return `本机 ${localStats.rounds} 轮 · 清晰 ${rate}%${fit===null?'':` · 拟合中位 ${fit.toFixed(3)}`}${sep===null?'':` · 分离中位 ${sep.toFixed(3)}`}`;};
  function sceneStore(){return sceneBank.byPrompt||(sceneBank.byPrompt={});}
  function rememberScene(scene,label){
    const store=sceneStore();
    const item=store[scene.probe]||(store[scene.probe]={kind:scene.kind,options:scene.options||null,samples:[],clusters:[]});
    item.kind=scene.kind;item.options=scene.options||null;
    item.samples.push({v:scene.value,label:label||null,ok:!!scene.ok,at:Date.now()});
    if(item.samples.length>120)item.samples.splice(0,item.samples.length-120);
    let cluster=null;
    if(scene.kind==='free'){
      item.clusters=item.clusters||[];
      cluster=sceneClusterOf(item.clusters,scene.value);
      if(!cluster){cluster={key:scene.value,variants:[],labels:{},count:0,firstAt:Date.now(),lastAt:Date.now()};item.clusters.unshift(cluster);if(item.clusters.length>24)item.clusters.length=24;}
      cluster.count+=1;cluster.lastAt=Date.now();
      if(!cluster.variants.includes(scene.value)&&cluster.variants.length<8)cluster.variants.push(scene.value);
      if(label)cluster.labels[label]=(cluster.labels[label]||0)+1;
    }
    void saveSceneBank();
    return {item,cluster};
  }
  function sceneProfiles(){
    const out={};
    for(const [id,item] of Object.entries(sceneBank.byPrompt||{})){
      const hist={};
      for(const sample of item.samples||[]){
        if(!sample.label||!sample.v)continue;
        hist[sample.label]=hist[sample.label]||{};
        hist[sample.label][sample.v]=(hist[sample.label][sample.v]||0)+1;
      }
      out[id]={kind:item.kind,options:item.options,hist,clusters:item.clusters||[]};
    }
    return out;
  }
  function sceneObservations(){
    return Object.entries(sceneBank.byPrompt||{}).map(([id,item])=>{
      const last=(item.samples||[]).slice(-1)[0];
      return last&&last.v?{promptId:id,kind:item.kind,value:last.v,options:item.options}:null;
    }).filter(Boolean);
  }
  async function runSceneProbe(round,expectedSession){
    const probe=sceneProbes[(Math.max(1,round)-1)%sceneProbes.length];
    ensureReady(expectedSession);
    const editor=editors()[0];if(!editor)throw Error('未找到输入框；scene 探针未发送');
    writeEditor(editor,probe.prompt);
    const button=await waitFor(()=>sendButton(),'发送按钮不可用；scene 探针未发送',30000,expectedSession);
    guard(expectedSession);if(editorText(editor)!==probe.prompt)throw Error('输入内容已变化；scene 探针未发送');
    const beforeLength=transcriptText().length;
    button.click();
    publishDraw('waiting',`第 ${round} 轮：scene 题已发送（${sceneKindLabel(probe.kind)}），等回复…`);
    try{await confirmSend(expectedSession,beforeLength,`第 ${round} 轮 scene 题`);}catch(error){throw Error('scene 题没发出去：'+String(error&&error.message||error));}
    try{await waitFor(()=>generating(),'scene 探针未开始生成',15000,expectedSession);}catch{}
    await waitFor(()=>!generating(),'scene 探针生成超时（60 秒）',60000,expectedSession);
    publishDraw('waiting',`第 ${round} 轮：scene 回复已到，正在解析…`);
    const tail=transcriptText(),marker=probe.prompt.slice(-8),at=tail.lastIndexOf(marker);
    const scope=at>=0?tail.slice(at+marker.length):tail;
    if(probe.kind==='choice'){
      const letter=sceneParseChoice(scope,probe.options);
      return {probe:probe.id,kind:'choice',options:probe.options,value:letter,ok:!!letter};
    }
    if(probe.kind==='pick'){
      const pick=sceneParsePick(scope);
      return {probe:probe.id,kind:'pick',options:null,value:pick?pick.key:'',ok:!!pick};
    }
    const found=findSceneSentence(scope)||'',check=validateScene(found);
    return {probe:probe.id,kind:'free',options:null,value:check.key||sceneKeyOf(found),ok:check.ok,han:check.han};
  }
  async function sceneChannelFor(round,expectedSession,label){
    if(prefs.sceneChannel!==true||!sceneProbes||!sceneProbes.length)return '';
    try{
      const scene=await runSceneProbe(round,expectedSession);
      if(!scene.value)return ' · scene：未取到合规回复';
      const saved=rememberScene(scene,label||null);
      const head=scene.kind==='free'
        ?`scene「${scene.value}」${saved.cluster?`（本机第 ${saved.cluster.count} 次${Object.keys(saved.cluster.labels||{}).length?` · 历史多数：${Object.entries(saved.cluster.labels).sort((left,right)=>right[1]-left[1])[0][0]}`:''}）`:''}`
        :`scene ${scene.kind==='choice'?`选项 ${scene.value}`:`自选「${scene.value}」`}`;
      const vote=sceneVote(sceneObservations(),sceneProfiles()).slice(0,2);
      const top=vote[0];
      const agree=top&&label&&top.label===label;
      const voteText=top?`scene 投票：${top.label}（相似 ${top.score.toFixed(2)} · ${top.samples} 项样本${agree?' · 与数字通道一致':''}）`:'';
      return ` · ${scene.ok?'':'（格式不合规）'}${head}${voteText?` · ${voteText}`:''}`;
    }catch(error){return ` · scene 通道失败：${error&&error.message?error.message:'未知原因'}`;}
  }
  const sceneKindLabel=kind=>kind==='free'?'12 字句':kind==='choice'?'单选':'自选';
  async function loadPrefs(){const items=await storageGet([PREFS_KEY,LEGACY_PREFS_KEY]);prefs=sanitizePrefs(items[PREFS_KEY]||items[LEGACY_PREFS_KEY]);}
  async function savePrefs(patch){prefs=sanitizePrefs({...prefs,...patch});await storageSet({[PREFS_KEY]:prefs});paint();return prefs;}
  /* 随机源：优先 crypto，保证「随机 1 题」不是可预测的伪随机。 */
  const cryptoRandom=()=>{const buffer=new Uint32Array(1);if(globalThis.crypto?.getRandomValues){crypto.getRandomValues(buffer);return buffer[0]/4294967296;}return Math.random();};
  const usedProbeIndexes=record=>record.samples.map(sample=>sample.probeIndex).filter(index=>Number.isInteger(index));
  const planFor=(record,mode)=>planProbes(mode,usedProbeIndexes(record),cryptoRandom);
  /* ---------- v2.2.0：随机数学题（过人机验证）与 thinking 拦截 ---------- */
  function randomMathQuestion(){
    const pick=(min,max)=>min+Math.floor(cryptoRandom()*(max-min+1));
    const roll=cryptoRandom();
    if(roll<0.5){const a=pick(13,89),b=pick(13,89);return `${a} + ${b} = ?`;}
    if(roll<0.8){const a=pick(41,99),b=pick(11,40);return `${a} - ${b} = ?`;}
    const a=pick(3,19),b=pick(3,12);return `${a} × ${b} = ?`;
  }
  const MATH_WARMUP_PREFIX='Answer with a single number: ';
  function thinkingMarkers(){
    const hits=[];
    for(const element of document.querySelectorAll('[data-state="thinking"],[data-thinking="true"],[aria-label],[title]')){
      if(!visible(element))continue;
      const label=`${element.getAttribute('aria-label')||''} ${element.getAttribute('title')||''} ${element.getAttribute('data-state')||''} ${element.getAttribute('data-thinking')||''}`;
      if(/think|reason|思考|推理/i.test(label))hits.push(element);
    }
    for(const element of document.querySelectorAll('span,button,summary,p,strong,b,em,small')){
      if(!visible(element))continue;
      const text=(element.textContent||'').trim();
      if(text&&text.length<=32&&/(thinking|reasoning|思考中|正在思考|深度思考|推理中|思考过程)/i.test(text))hits.push(element);
    }
    return hits;
  }
  function stopGeneratingButton(){
    return [...document.querySelectorAll('button[aria-label]')].filter(element=>visible(element)&&!element.disabled&&/stop|cancel|停止|取消|中止/i.test(element.getAttribute('aria-label')||''))[0]||null;
  }
  async function abortThinking(record,round){
    const text=`第 ${round} 轮：检测到 thinking，正在立即截断…`;
    if(draw.running)publishDraw('thinking',text);else publish('thinking',text,record);
    const stop=stopGeneratingButton();
    if(stop)press(stop);
    const end=Date.now()+6000;
    while(Date.now()<end&&generating())await sleep(200);
    throw Object.assign(Error('检测到 thinking，已截断；本轮跳过，直接进入下一轮抽卡'),{thinkingBlocked:true});
  }

  /* v2.9.x：会话文本容器（[role=log] 优先，否则最大可见 main）的选择集中到 largestVisible，transcriptText 与 tokenTranscriptText 共用。 */
  const largestVisible=selector=>[...document.querySelectorAll(selector)].filter(visible).sort((left,right)=>(right.innerText||'').length-(left.innerText||'').length)[0]||null;
  function transcriptText(){return cachedRead('transcript',250,()=>{
    const log=largestVisible('[role="log"]');
    if(log)return log.innerText||'';
    return largestVisible('main')?.innerText||'';
  });}
  function currentRecord(){const id=session();return id?records.get(id)||null:null;}
  function publicStatus(){
    const id=session(),record=id?records.get(id)||null:null;
    return {
      running:running||draw.running,
      phase:running?phase:(draw.running?draw.phase:(record?.phase||phase)),
      progress:running?progress:(draw.note||record?.progress||progress),
      sessionId:targetSession||id,
      samples:record?.samples.length||0,
      continueClicks:record?.continueClicks||0,
      result:record?.result||null,
      check:record?.lastCheck||null,
      trace:globalThis.__ampTrace||null,
      draw:{running:draw.running,phase:draw.phase,note:draw.note,round:draw.round,total:draw.total,completed:draw.completed,failed:draw.failed,renamed:draw.renamed,results:draw.results.slice(0,10)},
      prefs:{...prefs},
      balance:balanceInfo,balanceError,balanceLoading,
    };
  }
  function publish(nextPhase,text,record=null){phase=nextPhase;progress=text;if(record){record.phase=nextPhase;record.progress=text;}paint();}
  function publishDraw(nextPhase,text){draw.phase=nextPhase;draw.note=text;progress=text;paint();}
  function guard(expectedSession=null){
    if(cancelled)throw fatal('已停止；已经发送的消息不会撤回');
    if(!agentPage())throw fatal('已离开 Arena Work / Agent 页面，探测停止');
    if(expectedSession&&session()!==expectedSession)throw fatal('已切换到其他聊天，探测停止');
  }
  function ensureReady(expectedSession=null){
    guard(expectedSession);
    if(generating())throw fatal('当前回复仍在生成，请等待结束后再探测');
    if(!modeReady()&&!battleMode())throw fatal('未确认 Work / Agent Mode，请先切换到 Work / Agent Mode（Battle 模式亦可）');
    if(editors().some(element=>editorText(element)))throw fatal('输入框有未发送草稿；为避免覆盖，未发送探针');
  }
  async function waitGenIdle(maxMs=480000){const t0=Date.now();while(Date.now()-t0<maxMs){guard();if(!generating())return;await sleep(3000);}} // v2.9.15：battle 模型会持续迭代建设——收集/入库前等生成空闲而非直接 fatal
  /* v2.9.23：失焦/后台标签页里 document.execCommand 会被 Chromium 直接拒绝（返回 false），
     旧代码当场抛错——「页面没切到前面就识别不出模型」的第一现场。三层兜底：
     execCommand → 受信任键入（debugger Input.insertText，不依赖文档焦点）→ 合成 setter+input；全失败才报错。 */
  function syntheticWrite(editor,text){
    if(editor.tagName==='TEXTAREA'||editor.tagName==='INPUT'){
      const setter=Object.getOwnPropertyDescriptor(editor.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value')?.set;
      setter?setter.call(editor,text):editor.value=text;
    }else if(!text)editor.replaceChildren();
    else editor.textContent=text;
    const init={bubbles:true,cancelable:true,composed:true,inputType:text?'insertText':'deleteContentBackward'};
    if(text)init.data=text;
    try{editor.dispatchEvent(new InputEvent('input',init));}
    catch{editor.dispatchEvent(new Event('input',{bubbles:true}));}
  }
  async function writeEditor(editor,text){
    editor.focus();
    if(editor.tagName==='TEXTAREA'){const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')?.set;setter?setter.call(editor,text):editor.value=text;editor.dispatchEvent(new Event('input',{bubbles:true}));return;}
    const selection=window.getSelection(),range=document.createRange();range.selectNodeContents(editor);selection.removeAllRanges();selection.addRange(range);
    if(editorText(editor)){
      if(!document.execCommand('delete',false))syntheticWrite(editor,'');
      if(editorText(editor))throw Error('无法清空输入框；未发送');
    }
    if(!text)return;
    if(document.execCommand('insertText',false,text)&&editorText(editor)===text)return;
    if(await ensureDebug()){try{await trustedType(editor,text);if(editorText(editor)===text)return;}catch{}}
    syntheticWrite(editor,text);
    if(editorText(editor)!==text)throw Error('无法写入探针；未发送');
  }
  async function waitFor(check,message,timeout=30000,expectedSession=null){
    const end=Date.now()+timeout;
    while(Date.now()<end){guard(expectedSession);const value=await check();if(value)return value;await domTick(1200,250);}
    throw Error(message);
  }
  async function waitForReply(before,expected,expectedSession,record,round,thinkingBaseline=0){
    const started=Date.now();let lastSignature='',changedAt=Date.now(),candidate=null,continued=false,continuedAt=0,promptSeenAt=0;
    while(Date.now()-started<600000){
      guard(expectedSession);
      if(prefs.blockThinking&&thinkingMarkers().length>thinkingBaseline)await abortThinking(record,round);
      const busy=generating();
      const next=selectCandidate(transcriptText(),before,expected),signature=next?.join(',')||'';
      if(signature!==lastSignature){lastSignature=signature;changedAt=Date.now();candidate=next;}
      const ui=taskSuccessUi();
      if(!continued&&ui){continued=await clickContinueWork(expectedSession,record,round);continuedAt=Date.now();}
      if(!continued&&taskSuccessPromptVisible()&&!promptSeenAt)promptSeenAt=Date.now();
      const stable=Date.now()-changedAt;
      if(continued&&!candidate&&Date.now()-continuedAt>=3000)throw Error('已点击“继续工作”，但本轮回复中没有可用的数字序列');
      if(!continued&&promptSeenAt&&Date.now()-promptSeenAt>=6000)throw Error('已看到“任务成功”提示，但没有找到可点击的“继续工作”控件；已停止后续探针');
      if(candidate){
        const nearComplete=candidate.length>=Math.ceil(expected*.9),complete=candidate.length>=expected;
        // 生成已结束：数量达标立刻收工，不再空等 12 秒的“稳定”窗口（v2.4.0）。
        if(!busy&&complete)return candidate;
        if(!busy&&nearComplete&&stable>=2000)return candidate;
        if(!busy&&stable>=4000)return candidate;
        // 还在生成但数量已达标：直接点「停止生成」截掉尾巴，省下剩余输出时间（v2.4.0）。
        if(busy&&complete&&stable>=1200){const stop=stopGeneratingButton();if(stop){press(stop);await sleep(300);}if(candidate)return candidate;}
        if(continued&&((nearComplete&&stable>=500)||stable>=2000))return candidate;
      }
      await domTick(1500,250);
    }
    if(candidate)return candidate;
    throw Error('等待数字回复超时（10 分钟）；不会自动重发');
  }
  function controlLabels(element){return [element?.getAttribute?.('aria-label'),element?.getAttribute?.('title'),element?.value,element?.innerText,element?.textContent].map(value=>String(value||'').replace(/\s+/g,' ').trim()).filter(Boolean);}
  function taskSuccessPromptVisible(){return [...document.querySelectorAll('[role="dialog"],[role="alertdialog"],[aria-modal="true"],[role="heading"],h1,h2,h3,h4,p')].some(element=>visible(element)&&isTaskSuccessText(`${element.getAttribute?.('aria-label')||''} ${element.textContent||''}`));}
  /* 页面性能：waitForReply/clickContinueWork 每个 tick 都调用本函数（全页按钮+容器扫描），
     同一拍内复用 250ms 缓存结果即可——domTick 的最小复查间隔就是 250ms，语义不变。 */
  function taskSuccessUi(){
    return cachedRead('taskSuccessUi',250,taskSuccessUiCompute);
  }
  function taskSuccessUiCompute(){
    const controls=[...document.querySelectorAll('button,[role="button"],[data-slot="button"],[tabindex]:not([tabindex="-1"]),input[type="button"],input[type="submit"]')].filter(element=>visible(element)&&!element.disabled&&element.getAttribute('aria-disabled')!=='true'&&controlLabels(element).some(isContinueWorkText));
    const unique=controls.filter((element,index)=>!controls.some((other,otherIndex)=>otherIndex!==index&&element.contains(other)));
    const contextual=unique.map(control=>{
      let container=control;
      for(let depth=0;container&&container!==document.body&&depth<14;depth++,container=container.parentElement){
        const label=`${container.getAttribute?.('aria-label')||''} ${container.textContent||''}`;
        if(isTaskSuccessText(label))return {control,container};
      }
      return null;
    }).filter(Boolean);
    const matches=contextual.length?contextual:(taskSuccessPromptVisible()?unique.map(control=>({control,container:control.parentElement})):[]);
    if(matches.length>1)return {ambiguous:true,matches};
    return matches[0]||null;
  }
  async function clickContinueWork(expectedSession,record,round){
    const ui=taskSuccessUi();
    if(!ui)return false;
    if(ui.ambiguous)throw fatal('页面上有多个“继续工作”控件，已停止自动操作');
    publish('continuing',`第 ${round} 条回复结束，正在点击“继续工作”…`,record);
    guard(expectedSession);ui.control.click();
    try{await waitFor(()=>!taskSuccessUi(),'点击“继续工作”后提示仍未关闭',10000,expectedSession);}
    catch(error){if(error?.fatal)throw error;publish('continuing','“继续工作”提示仍在，再点一次…',record);const again=taskSuccessUi();if(again&&!again.ambiguous)again.control.click();await sleep(1500);}
    record.continueClicks=(record.continueClicks||0)+1;
    return true;
  }
  function newRecord(){return {samples:[],result:null,checks:[],lastCheck:null,continueClicks:0,renameTitle:'',renameError:'',phase:'idle',progress:''};}
  async function score(record){
    // 快速模式可能只问了第 2/3 题：按题号长度升序（297→315→331）后交给后台，后台按实际题号校验。
    const outputs=[...record.samples].sort((left,right)=>probes[left.probeIndex].expected_count-probes[right.probeIndex].expected_count).map(sample=>({text:sample.text,expected_count:probes[sample.probeIndex].expected_count,challenge_id:probes[sample.probeIndex].id}));
    const response=await chrome.runtime.sendMessage({type:'AMP_SCORE',outputs,pageUrl:location.href});
    if(response?.error)throw Error(response.error);
    record.checks=response?.checks||[];record.lastCheck=record.checks.at(-1)||null;record.result=response?.result||null;
    // B：只把新回答的 355 维数字计数送到本机后台；只有在本条发送之后返回的网络轨迹才可作真标签。
    const pending=record.samples.filter(sample=>!sample.evidenceSaved);
    if(pending.length){
      const trace=globalThis.__ampTrace||null;
      const latestSentAt=Math.max(...pending.map(sample=>Number(sample.sentAt)||0));
      const traceVerified=trace?.status==='ok'&&!!trace?.name&&Number(trace.at)>=latestSentAt;
      try{
        const saved=await chrome.runtime.sendMessage({
          type:'AMP_EVIDENCE_SAVE',traceVerified,traceModel:traceVerified?trace.name:null,
          candidateModel:record.result?.nearest?.id||null,status:record.result?.status||null,
          environment:traceVerified?trace.environment:null,
          samples:pending.map(sample=>({text:sample.text.slice(0,12000),expected_count:probes[sample.probeIndex].expected_count})),
          pageUrl:location.href,
        });
        if(saved&&!saved.error){pending.forEach(sample=>{sample.evidenceSaved=true;});}
      }catch{}
    }
    return record.result;
  }
  /* v2.7.2：发送确认 + 点掉「继续工作」弹窗 —— 修两个静默阻塞点（点一下发送就被吞 / 弹窗挡住输入框）。 */

  async function clearContinuePrompt(expectedSession){

    try{

      const ui=taskSuccessUi();

      if(ui&&!ui.ambiguous){publish('continuing','检测到「继续工作」提示，先点掉它再继续…');guard(expectedSession);ui.control.click();await sleep(800);}

    }catch{}

  }

  async function confirmSend(expectedSession,beforeLength,label){

    for(let attempt=1;attempt<=2;attempt+=1){

      const startedAt=Date.now();

      while(Date.now()-startedAt<12000){

        const composer=editors()[0];

        if(/Something went wrong/.test(document.body?document.body.innerText:'')){const retry=[...document.querySelectorAll('button')].find(b=>/^retry$/i.test((b.textContent||'').trim())&&!b.disabled);if(retry){await trustedClick(retry).catch(()=>press(retry));await sleep(2500);}} // v2.9.16：Arena 服务端生成出错时自动点 Retry 自愈
        if(generating()||transcriptText().length>beforeLength||(Date.now()-startedAt>3000&&composer&&!editorText(composer)))return true;

        guard(expectedSession);

        await domTick(1200,250);

      }

      const button=sendButton();

      if(attempt<2&&button){publish('sent',`${label}：点发送后 12 秒没动静，自动再点一次…`);await trustedClick(button).catch(()=>button.click());continue;} // v2.9.23：合成 click 会被 Arena 过滤（isTrusted=false），二次点击必须走受信任点击

    }

    throw fatal('发送后 12 秒仍无任何动静（不重发第二道题）；已停止，避免无声等 10 分钟');

  }

  /* 发送一条探针、等待回复、评分。单条模式与自动抽卡共用这一条路径。 */
  async function captureProbe({record,probeIndex,expectedSession,label=''}){
    const probe=probes[probeIndex];await clearContinuePrompt(expectedSession);ensureReady(expectedSession);
    const editor=editors()[0];if(!editor)throw fatal('未找到 Agent 输入框；未发送探针');
    const before=signatures(transcriptText());const thinkingBaseline=thinkingMarkers().length;const beforeLength=transcriptText().length;pendingPrompt=probe.prompt;await writeEditor(editor,probe.prompt);
    const send=await waitFor(()=>sendButton(),'发送按钮不可用；未发送',30000,expectedSession);
    guard(expectedSession);if(editorText(editor)!==probe.prompt)throw fatal('输入内容已变化；未发送探针');
    sent=true;const sentAt=Date.now();publish('sent',`${label}第 ${probeIndex+1} 题已发送，等待模型回复…`,record);await trustedClick(send).catch(()=>send.click()); // v2.9.15：Arena 过滤合成点击，发送必须走受信任点击
    await confirmSend(expectedSession,beforeLength,`${label}第 ${probeIndex+1} 题`);
    let active=expectedSession;
    if(!active){
      try{active=await waitFor(()=>session(),'发送后未确认新会话；不会重发',30000,null);}
      catch(error){throw error?.fatal?error:fatal(error?.message||'发送后未确认新会话；不会重发');}
      targetSession=active;record=records.get(active)||record||newRecord();records.set(active,record);
    }
    guard(active);
    const values=await waitForReply(before,probe.expected_count,active,record,probeIndex+1,thinkingBaseline);
    record.samples.push({text:values.join(','),captured_count:values.length,probeIndex,sentAt,evidenceSaved:false});
    publish('scoring',`${label}第 ${probeIndex+1} 题捕获 ${values.length} 个数字，正在本机评分…`,record);
    const result=await score(record);
    if(result){
      const verdict={clear:'清晰匹配',close:'同族近似',weak:'弱匹配'}[result.status]||result.status;
      publish('scored',`${label}${verdict}：${resultLabelOf(result)} · 已用 ${result.used_outputs}/${record.samples.length} 条有效回复`,record);
    }else publish('scored',`${label}${record.lastCheck?.message||'本条回复未通过计分门控'}`,record);
    pendingPrompt='';sent=false;return {record,sessionId:active};
  }
  /* v2.9.3：Arena 常不渲染用户气泡，助手节点也没有稳定特征属性；用发送前快照做差集取出本轮新回复（电池与文本探针共用）。 */
  function makeTailAfter(beforeComparable){
    return full=>{
      if(!beforeComparable)return '';
      let at=full.indexOf(beforeComparable);
      if(at>=0)return full.slice(at+beforeComparable.length);
      const anchor=beforeComparable.slice(-600);
      if(anchor){at=full.lastIndexOf(anchor);if(at>=0)return full.slice(at+anchor.length);}
      return '';
    };
  }
  function tokenTranscriptText(){return cachedRead('tokenTranscript',250,()=>{
    const log=largestVisible('[role="log"]'),main=largestVisible('main');
    const logText=log?.innerText||'',mainText=main?.innerText||'';
    // v2.9.3：与 transcriptText 一致优先 [role=log]；main 可能是「Agent Workspace」侧栏而非会话，取字数多者会选错容器。
    let text=logText||mainText;
    if(!text)text=transcriptText();
    for(const editor of editors()){
      const draft=editorText(editor);if(!draft)continue;
      const at=text.lastIndexOf(draft);if(at>=0)text=text.slice(0,at)+text.slice(at+draft.length);
    }
    return text;
  });}

  /* v2.9.3：文本词频通道 —— 依次发送固定判别探针（数学/中文/编程），收集回复文本供建档/评分。 */
  async function collectTextSamples(expectedSession,ids,label,notify){
    const samples=[];
    for(let index=0;index<ids.length;index++){
      const wanted=ids[index];
      const probe=typeof wanted==='string'?TEXT_PROBES.find(item=>item.id===wanted):wanted;
      if(!probe)continue;
      guard(expectedSession);
      await clearContinuePrompt(expectedSession);
      ensureReady(expectedSession);
      const editor=editors()[0];if(!editor)throw fatal('未找到 Agent 输入框；文本探针未发送');
      const thinkingBaseline=thinkingMarkers().length;
      const beforeText=tokenTranscriptText(),beforeLength=beforeText.length;
      const beforeComparable=promptComparable(beforeText);
      pendingPrompt=probe.prompt;await writeEditor(editor,'');
      const sentResponse=await trustedSend(editor,probe.prompt,expectedSession,label+`文本探针${index+1}`).catch(async()=>{writeEditor(editor,probe.prompt);const send=await waitFor(()=>sendButton(),'发送按钮不可用；文本探针未发送',30000,expectedSession);await trustedClick(send).catch(()=>send.click());return {ok:true};}); // v2.9.16：兜底路径真实点击成功就返回 ok——是否真发出由 confirmSend/轨迹增长裁决，不能返回 null 让 guard 误杀
      guard(expectedSession);if(!(sentResponse&&sentResponse.ok)&&!promptMatches(editor,probe.prompt))throw fatal('输入内容已变化；文本探针未发送'); // 受信任发送后编辑器会被清空——以 ok 应答为发送凭证
      sent=true;const sentAt=Date.now();
      if(notify)notify('sent',`${label}文本探针 ${index+1}/${ids.length} 已发送，等待回复…`);
      await confirmSend(expectedSession,beforeLength,`${label}文本探针${index+1}`);
      let active=expectedSession;
      if(!active){active=await waitFor(()=>session(),'发送后未确认新会话；不会重发',60000,null);expectedSession=active;}
      guard(active);
      const started=Date.now();let lastText=tokenTranscriptText(),changedAt=Date.now(),grew=false,busySeen=false;
      while(Date.now()-started<180000){
        guard(active);
        if(prefs.blockThinking&&thinkingMarkers().length>thinkingBaseline)await abortThinking(null,label);
        const busy=generating();if(busy)busySeen=true;
        const text=tokenTranscriptText();
        if(text!==lastText){lastText=text;changedAt=Date.now();if(text.length>beforeLength+2)grew=true;}
        if(!busy&&Date.now()-changedAt>=1500&&(grew||(busySeen&&Date.now()-started>=6000)))break;
        await domTick(1500,250);
      }
      const full=promptComparable(tokenTranscriptText());
      const reply=makeTailAfter(beforeComparable)(full);
      samples.push({id:probe.id,text:reply.slice(0,40000),sentAt});
      pendingPrompt='';sent=false;
      if(index+1<ids.length)await sleep(900);
    }
    return {samples,sessionId:expectedSession};
  }
  /* 库就绪时（任一模型有参考样本）自动追加文本评分；库为空则零开销跳过。 */
  async function textBankScoreActive(active,label){
    const status=await chrome.runtime.sendMessage({type:'AMP_TEXT_SCORE',samples:[]}).catch(()=>null);
    if(!status||status.error||(status?.available?.ready||0)<1)return '';
    const collected=await collectTextSamples(active,TEXT_SCORE_PROBES,`${label} · `,null);
    const samples=collected.samples;
    if(samples.length<TEXT_SCORE_PROBES.length)return '';
    const result=await chrome.runtime.sendMessage({type:'AMP_TEXT_SCORE',samples}).catch(()=>null);
    if(!result||result.error||!result.top)return '';
    const mark=result.verdict==='candidate'?' ✓':'？';
    return ` · 文本:${result.top.model}(${result.top.score.toFixed(3)}${mark})`;
  }
  /* 抽卡每轮先发一道随机数学题：内容每轮不同，用来过人机验证；答完再发探针。 */
  async function waitForMathReply(expectedSession,thinkingBaseline,round){
    const started=Date.now(),baseline=transcriptText();let lastText=baseline,grew=false,busySeen=false,changedAt=Date.now(),continued=0;
    while(Date.now()-started<240000){
      guard(expectedSession);
      if(prefs.blockThinking&&thinkingMarkers().length>thinkingBaseline)await abortThinking(null,round);
      const busy=generating();if(busy)busySeen=true;
      const text=transcriptText();
      if(text!==lastText){lastText=text;changedAt=Date.now();if(text.length>baseline.length+2)grew=true;}
      const ui=taskSuccessUi();
      if(grew&&ui&&!ui.ambiguous&&continued<1){continued++;try{ui.control.click();await sleep(600);}catch{}}
      if(!busy&&Date.now()-changedAt>=1300&&busySeen&&(grew||Date.now()-started>=6000))return true; // v2.4.0：数学题回复短，收工更快；必须等模型真实生成过且已结束，避免把用户气泡当成回复提前放行
      if(!busy&&Date.now()-changedAt>=1300&&!busySeen&&grew&&Date.now()-started>=10000)return true; // 兜底：一直没捕捉到生成态时，回复稳定满 10 秒才放行
      await domTick(1500,250);
    }
    throw Error('数学题发出后 240 秒仍未结束；本轮跳过');
  }
  async function mathWarmup(round,expectedSession=null){
    guard(expectedSession);
    ensureReady(expectedSession);
    const question=randomMathQuestion(),prompt=`${MATH_WARMUP_PREFIX}${question}`;
    const editor=editors()[0];if(!editor)throw fatal('未找到 Agent 输入框；未发送数学题');
    const thinkingBaseline=thinkingMarkers().length;
    pendingPrompt=prompt;await writeEditor(editor,prompt);
    const send=await waitFor(()=>sendButton(),'发送按钮不可用；未发送数学题',30000,expectedSession);
    guard(expectedSession);if(editorText(editor)!==prompt)throw fatal('输入内容已变化；未发送数学题');
    publishDraw('verify',`第 ${round} 轮：先发随机数学题「${question}」过人机验证…`);
    const mathBeforeLength=transcriptText().length;await trustedClick(send).catch(()=>send.click()); // v2.9.15
    await confirmSend(expectedSession,mathBeforeLength,'数学题');
    let active=expectedSession;
    if(!active)active=await waitFor(()=>session(),'发送数学题后未确认新会话；不会重发',30000,null);
    guard(active);
    await waitForMathReply(active,thinkingBaseline,round);
    pendingPrompt='';
    return active;
  }
  async function run(mode='quick'){if(foldOn)unfoldAll();
    if(running||draw.running)return publicStatus();
    await ensureDebug(true);
    const precise=mode==='precise';
    guard();draw.note='';let active=session(),record=active?records.get(active)||newRecord():newRecord();
    if(active&&!records.has(active))records.set(active,record);
    const first=planFor(record,precise?'precise':'quick');
    if(!first.length){publish('done','当前聊天三道题都已问过；清除结果或新建聊天后可重新探测',record);return publicStatus();}
    const goal=precise?3:(prefs.autoTopUp?3:record.samples.length+1);
    running=true;cancelled=false;sent=false;targetSession=active;
    publish('checking',precise?'精准模式：依次问完三道题（3 条回复）':prefs.autoTopUp?'快速模式：随机 1 题；判定不是“清晰匹配”时自动补题加强证据（最多 3 题）':`快速模式：随机发第 ${first[0]+1} 题（1 条回复）`,record);
    try{
      while(record.samples.length<goal){
        const plan=planFor(record,precise?'precise':'quick');
        if(!plan.length)break;
        const label=precise?`精准 ${record.samples.length+1}/3 · `:'快速 · ';
        let step;
        try{step=await captureProbe({record,probeIndex:plan[0],expectedSession:active,label});}
        catch(error){
          // 补题（第 2/3 条）失败时保住已有证据，直接用第一条的结果判定。
          if(precise||!record.samples.length||error?.thinkingBlocked||error?.fatal)throw error;
          publish('waiting',`补题失败（${error?.message||'未知原因'}），用已有 ${record.samples.length} 条证据判定`,record);break;
        }
        record=step.record;active=step.sessionId;targetSession=active;
        if(!precise&&prefs.autoTopUp&&record.result?.status==='clear'){publish('waiting',`判定清晰（${record.result.nearest.display_name}），提前收工：不再补题`,record);break;}
        if(record.samples.length<goal){publish('waiting',`已捕获 ${record.samples.length} 条证据，准备下一题…`,record);await sleep(1200);}
      }
      const label=record.result?.nearest?.display_name||'暂无可靠候选';
      const verdict=record.result?({clear:'清晰匹配',close:'同族近似',weak:'弱匹配'}[record.result.status]||record.result.status):'未通过门控';
      let renameNote=record.result&&!namingClear(record.result)?` · 未改名（${verdict}）：Top3 ${topThreeOf(record.result)||'—'}`:'';
      if(record.result&&active&&namingClear(record.result)){
        const conversationTitle=renameTitleForResult(label,record.result.status);
        record.renameError='';publish('renaming',`探测完成，正在把当前会话重命名为 ${conversationTitle}…`,record);
        try{
          const renamed=await globalThis.ArenaProbeRename.rename({sessionId:active,title:conversationTitle,isCurrent:()=>!cancelled&&session()===active});
          record.renameTitle=renamed.title;renameNote=renamed.unchanged?' · 会话名称已是该模型标识':` · 已重命名为 ${renamed.title}`;
        }catch(error){record.renameError=error?.message||'自动重命名失败';renameNote=` · 重命名失败：${record.renameError}`;}
      }
      let textNote='';
      if(active&&!cancelled){try{textNote=await textBankScoreActive(active,'文本通道');}catch{}}
      publish('done',`${verdict}：${label} · 证据 ${record.samples.length}/3 条${record.samples.length<3?'（可点「再补 1 题」加强）':''} · 已点“继续工作” ${record.continueClicks||0}/${record.samples.length}${renameNote}${textNote}`,record);
    }catch(error){publish(cancelled?'stopped':'error',error?.message||'自动探测失败',record);}
    finally{running=false;sent=false;targetSession=null;paint();}
    return publicStatus();
  }
  function stop(){if(running){cancelled=true;publish('stopping','正在停止；不会再发送下一条');}return publicStatus();}
  function clearCurrent(){if(running||draw.running)return publicStatus();const id=session();if(id)records.delete(id);phase='idle';draw.note='';progress='当前聊天的内存结果已清除；可重新点「快速识别」或「精准识别」';paint();return publicStatus();}

  /* ---------- 自动抽卡：New Chat → 发探针 → 识别 → 重命名 → 下一轮 ---------- */
  function press(element){
    const base={bubbles:true,cancelable:true,composed:true,button:0,pointerId:1,pointerType:'mouse',isPrimary:true};
    element.dispatchEvent(new PointerEvent('pointerdown',{...base,buttons:1}));
    element.dispatchEvent(new PointerEvent('pointerup',{...base,buttons:0}));
    element.dispatchEvent(new MouseEvent('click',{...base,buttons:0}));
  }
  /* v2.9.23：debugger 改为可选权限。已授权 → 受信任输入照旧；
     未授权 → 先向后台申请一次（弹窗按钮链路里带用户手势），仍失败才退回合成事件。 */
  let debugGranted=chrome.runtime.getManifest().permissions.includes('debugger'),debugCheckedAt=0;
  async function ensureDebug(force=false){
    if(debugGranted&&!force)return true;
    if(!force&&Date.now()-debugCheckedAt<3000)return debugGranted;
    debugCheckedAt=Date.now();
    try{
      const response=await chrome.runtime.sendMessage({type:'AMP_ENSURE_DEBUG'}).catch(()=>null);
      debugGranted=!!(response&&response.granted);
    }catch{debugGranted=false;}
    return debugGranted;
  }
  /* v2.9.14：受信任点击 —— 经 background 的 chrome.debugger 派发真实鼠标事件，绕过 Arena 的合成事件过滤。 */
  async function trustedClick(element){
    if(!(await ensureDebug())){element.click();return;}
    const box=element.getBoundingClientRect();
    let x=Math.round(box.left+box.width/2),y=Math.round(box.top+box.height/2);
    scan:for(const fy of [0.5,0.35,0.65,0.25,0.75,0.15,0.85]){for(const fx of [0.5,0.4,0.6,0.3,0.7,0.2,0.8]){const px=box.left+box.width*fx,py=box.top+box.height*fy;const hit=document.elementFromPoint(px,py);if(hit&&(hit===element||element.contains(hit))){x=Math.round(px);y=Math.round(py);break scan;}}} // v2.9.15 关键修复：按钮中心可能被悬浮层（building 动画/rive 层）遮挡——扫描矩形找 elementFromPoint 真正命中的点
    // v2.9.15：6 秒兜底超时 —— debugger 通道一旦挂起绝不阻塞建档流程（调用方自动回退合成点击）。
    const response=await Promise.race([
      chrome.runtime.sendMessage({type:'AMP_TRUSTED_CLICK',x,y}).catch(error=>({error:String(error)})),
      sleep(10000).then(()=>({error:'受信任点击超时（10s）'}))
    ]);
    if(!response||response.error){try{document.documentElement.dataset.ampTrustedErr='click: '+((response&&response.error)||'no-response');}catch{}throw Error(response?.error||'受信任点击失败');}
  }
  /* v2.9.15：受信任键入 —— 站点只认受信任 input 事件，合成 value+input 不会让发送按钮可用；改走 debugger 的 Input.insertText。 */
  async function trustedType(element,text){
    const box=element.getBoundingClientRect(),x=Math.round(box.left+box.width/2),y=Math.round(box.top+box.height/2);
    const response=await Promise.race([
      chrome.runtime.sendMessage({type:'AMP_TRUSTED_TYPE',x,y,text,skipClick:document.activeElement===element}).catch(error=>({error:String(error)})),
      sleep(12000).then(()=>({error:'受信任键入超时（12s）'}))
    ]);
    try{document.documentElement.dataset.ampTrustedErr='type '+(response&&response.ok?('ok active='+(response.active||'?')):((response&&response.error)||'no-response'));}catch{}
    if(!response||response.error)throw Error(response?.error||'受信任键入失败');
  }
  /* v2.9.15：受信任发送 —— 单条消息里完成「聚焦→键入→点发送」，中途不再依赖 SW 存活，杜绝孤儿调试会话。 */
  async function trustedSend(editor,text,expectedSession,label){
    if(!(await ensureDebug())){
      await writeEditor(editor,text);
      const send=await waitFor(()=>sendButton(),label+'：发送按钮不可用',30000,expectedSession);
      send.click();
      return {ok:true};
    }
    const send=sendButton()||[...document.querySelectorAll('button[aria-label]')].find(button=>visible(button)&&/^send\s*message$/i.test(String(button.getAttribute('aria-label')||'').trim()))||[...document.querySelectorAll('button')].find(button=>visible(button)&&/^(send|发送)$/i.test(String(button.textContent||'').trim()));
    if(!send)throw Error(label+'：找不到发送按钮'); // v2.9.15：不要求按钮已点亮（空编辑器时它必然是禁用的），坐标交给 background 在键入并点亮后自定位
    const box=editor.getBoundingClientRect(),sbox=send.getBoundingClientRect();
    const response=await Promise.race([
      chrome.runtime.sendMessage({type:'AMP_TRUSTED_SEND',x:Math.round(box.left+box.width/2),y:Math.round(box.top+box.height/2),x2:Math.round(sbox.left+sbox.width/2),y2:Math.round(sbox.top+sbox.height/2),text,skipClick:document.activeElement===editor}).catch(error=>({error:String(error)})),
      sleep(25000).then(()=>({error:'受信任发送超时（25s）'}))
    ]);
    try{document.documentElement.dataset.ampTrustedErr='send '+(response&&response.ok?('ok '+(response.timings?JSON.stringify(response.timings):'')):((response&&response.error)||'no-response'));}catch{}
    if(!response||response.error)throw Error(response?.error||'受信任发送失败');
    if(response.ok){await sleep(1200);if(editorText(editor)===text){try{const grow=tokenTranscriptText().length;await sleep(1800);if(tokenTranscriptText().length===grow&&editorText(editor)===text){await writeEditor(editor,'');return trustedSend(editor,text,expectedSession,label+'·补');}}catch{}}} // v2.9.16：只有「编辑器未清 AND 轨迹也无增长」才补枪——Arena 可能把已发送的提示恢复成草稿，不能只看编辑器
    return response; // v2.9.15 关键修复：此前漏了 return，trustedSend 恒返回 undefined，guard 必然误判「输入内容已变化」
  }
  function sendButton(){
    const labelled=[...document.querySelectorAll('button[aria-label]')].filter(button=>visible(button)&&!button.disabled);
    const byLabel=labelled.find(button=>/^send\s*message$/i.test(String(button.getAttribute('aria-label')).trim()));
    if(byLabel)return byLabel;
    return labelled.find(button=>/^(send|发送)$/i.test(String(button.textContent||'').trim()))||null;
  }
  const NEW_CHAT_LABELS=['new chat','新建聊天','新对话','新的聊天','开始新对话'];
  function newChatLinks(){
    return [...document.querySelectorAll('a[href]')].filter(link=>{
      try{
        const url=new URL(link.href);
        if(url.origin!=='https://arena.ai'||!isNewChatPath(url.pathname))return false;
        const text=String(link.textContent||'').trim().toLowerCase();
        const label=String(link.getAttribute('aria-label')||'').trim().toLowerCase();
        return NEW_CHAT_LABELS.includes(text)||NEW_CHAT_LABELS.some(value=>label.includes(value));
      }catch{return false;}
    });
  }
  function sidebarOpener(){
    const wanted=['Open sidebar','展开侧栏','打开侧边栏','展开侧边栏','Toggle Sidebar','Toggle sidebar','切换侧栏','展开导航'];
    return [...document.querySelectorAll('button[aria-label]')].filter(button=>visible(button)&&!button.disabled).find(button=>wanted.includes(button.getAttribute('aria-label')))||null;
  }
  function pickNewChatLink(links){return links.find(link=>link.getAttribute('data-sidebar')==='menu-button')||links[0]||null;}
  async function newChat(){
    guard();
    if(editors().some(element=>editorText(element)&&editorText(element)!==pendingPrompt))throw fatal('输入框有未发送草稿；为避免覆盖，未发送探针');
    let link=pickNewChatLink(newChatLinks());
    for(let attempt=0;!link&&attempt<2;attempt++){
      const opener=sidebarOpener();
      if(!opener)break;
      await trustedClick(opener).catch(()=>opener.click());
      try{await waitFor(()=>newChatLinks().length>0,'展开侧栏后仍未出现 New Chat 入口',4000,null);}catch{}
      link=pickNewChatLink(newChatLinks());
    }
    if(!link)throw Error('未找到 New Chat 入口，已停止本轮（可先点「自检」查看页面结构）');
    await trustedClick(link).catch(()=>link.click());
    await waitFor(()=>isNewChatPath(agentPath()),'点击 New Chat 后页面没有回到 /work 或 /agent，已停止本轮',15000,null);
    await waitFor(()=>editors().length===1,'等待新聊天输入框超时',15000,null);
    const editor=editors()[0];
    // Arena 可能把刚提交的提示恢复成新聊天草稿；只清理我们自己的那一条。
    if(pendingPrompt&&editorText(editor)===pendingPrompt){
      // v2.9.23：清空统一走 writeEditor 三层兜底（失焦文档里 execCommand('delete') 会被拒绝，旧代码误报「残留提示未能清理」）
      await writeEditor(editor,'').catch(()=>{});
      await waitFor(()=>!editorText(editors()[0]||editor),'新聊天草稿未能清空；未再次发送',8000,null);
    }
    if(editors().some(element=>editorText(element)))throw fatal('输入框有未发送草稿；为避免覆盖，未发送探针');
  }
  async function ensureMode(){
    if(modeReady())return;
    const combo=await waitFor(()=>combos()[0],'未找到模式选择器',10000,null);
    press(combo);
    const option=await waitFor(()=>[...document.querySelectorAll('[role="option"]')].find(element=>visible(element)&&isWorkMode(element)&&element.getAttribute('aria-disabled')!=='true'&&!element.hasAttribute('data-disabled')),'未找到 Work / Agent Mode 选项',10000,null);
    press(option);
    await waitFor(modeReady,'未能确认 Work / Agent Mode',10000,null);
  }
  /* v2.9.7：一键建档局专用 —— 新会话切到 Battle（匿名对战）模式。同一选项按 合成press → 原生鼠标序列 → 键盘(listbox/item/combo 三通道) 激活；每种之后先等下拉回显，再重开菜单用 aria-selected 复核（回显缺失但选中位已在 Battle 也算成功）。失败报出每轮菜单快照(✓=aria-selected)。 */
  async function refreshBalance(force=false){
    if(balanceLoading)return {balance:balanceInfo,error:balanceError};
    balanceLoading=true;paint();
    let error='';
    try{
      let response=null;
      try{response=await chrome.runtime.sendMessage({type:'AMP_BALANCE',force,pageUrl:location.href});}catch{}
      if(response?.balance)balanceInfo=response.balance;
      error=response?.error||'';
      if(!response?.balance||error){
        // 后台读取失败时用页面自身的同源请求兜底（页面就在 arena.ai 上）。
        try{
          const res=await fetch('/api/me/pulse',{method:'GET',credentials:'include',cache:'no-store',redirect:'error',headers:{Accept:'application/json'},signal:AbortSignal.timeout(10000)});
          if(!res.ok)throw Error(`HTTP ${res.status}`);
          const data=await res.json();
          const pulse=typeof data?.pulse==='number'&&Number.isFinite(data.pulse)&&data.pulse>=0?data.pulse:null;
          if(pulse===null)throw Error('响应缺少 pulse 字段');
          balanceInfo={pulse,refreshedAt:typeof data.refreshedAt==='string'?data.refreshedAt:null,receivedAt:new Date().toISOString()};
          error='';
        }catch(fallbackError){error=error||fallbackError?.message||'额度读取失败';}
      }
      balanceError=error;
      return {balance:balanceInfo,error:balanceError};
    }finally{balanceLoading=false;paint();}
  }
  /* 自检：只读取页面结构与额度，不发送任何消息、不消耗额度。 */
  async function diagnose(){
    const lines=[];
    const mark=(label,value)=>lines.push(`${value?'✅':'❌'} ${label}${typeof value==='string'?'：'+value:''}`);
    mark('Arena Work / Agent 页面',agentPage());
    mark('Work / Agent Mode 已选',modeReady());
    mark('各下拉当前值',[...combos().map(element=>'combo:'+String(element.textContent||'').replace(/\s+/g,' ').trim()),...[...document.querySelectorAll('select')].filter(visible).map(element=>'select:'+String(element.selectedOptions?.[0]?.textContent||'').replace(/\s+/g,' ').trim())].join(' | ')||'（无）'); // 模式/场景下拉当前值（含原生 select），battle 场景校准用
    mark('输入框唯一可见',editors().length===1);
    mark('发送按钮可用',!!sendButton());
    mark('当前未在生成',!generating());
    const links=newChatLinks();
    mark('New Chat 入口',links.length?`找到 ${links.length} 个`:'未找到');
    mark('侧栏展开按钮',!!sidebarOpener());
    const id=session();
    mark('当前会话',id?id:'尚未创建（/work 或 /agent 空白页）');
    if(id)mark('会话侧栏标签可重命名',[...document.querySelectorAll('a[data-sidebar="menu-button"][href]')].some(link=>String(link.href).includes(id)));
    await refreshBalance(false);
    mark('额度 /api/me/pulse',typeof balanceInfo?.pulse==='number'?pctText(balanceInfo.pulse):(balanceError||'未读取'));
    /* v2.5.3 诊断：dump 第一个侧栏会话的菜单结构（只读取 + 打开菜单 + Esc，不点任何菜单项）。 */
    try{
      const rows=[...document.querySelectorAll('a[data-sidebar="menu-button"][href],a[href*="/agent/"],a[href*="/work/"]')].filter(visible);
      mark('侧栏可见会话行',rows.length?String(rows.length):'未找到（侧栏可能收起或结构变了）');
      const link=rows.find(element=>globalThis.ArenaProbeRename?.sessionFromPath?.(new URL(element.href,location.origin).pathname))||rows[0];
      if(link){
        const row=link.closest('[data-sidebar="menu-item"]')||link.parentElement;
        const trigger=row?.querySelector('button[data-sidebar="menu-action"][aria-haspopup="menu"]')||[...(row?.querySelectorAll('button[aria-haspopup="menu"]')||[])].find(element=>visible(element));
        mark('会话菜单按钮',trigger?([trigger.getAttribute('aria-label'),trigger.getAttribute('title'),(trigger.textContent||'').replace(/\s+/g,' ').trim()].filter(Boolean).join(' | ').slice(0,40)||'（无标签）'):'未找到');
        if(trigger){
          trigger.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerType:'mouse',button:0,buttons:1,isPrimary:true}));
          trigger.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerType:'mouse',button:0,buttons:0,isPrimary:true}));
          trigger.click();
          await sleep(700);
          const menus=[...document.querySelectorAll('[role="menu"]')].filter(visible);
          const items=[...new Set(menus.flatMap(menu=>[...menu.querySelectorAll('[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="option"],button,[role="button"]')]))].filter(visible);
          mark('会话菜单',menus.length?`${menus.length} 个菜单 · ${items.length} 个条目`:'菜单没有打开');
          items.slice(0,12).forEach((item,index)=>mark(`菜单项${index+1}`,[`role=${item.getAttribute('role')||'-'}`,item.getAttribute('aria-label'),item.getAttribute('title'),item.hasAttribute('data-disabled')?'data-disabled':'',(item.textContent||'').replace(/\s+/g,' ').trim().slice(0,28)].filter(Boolean).join(' ')||'（无文本）'));
          document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',bubbles:true}));
          await sleep(200);
        }
      }
      mark('重命名/清理忙',globalThis.ArenaProbeRename?.isBusy?.()?'忙于其他操作（会挡住改名）':'空闲');
    }catch(error){mark('侧栏菜单探测','失败：'+(error?.message||'未知原因'));}

    const text=lines.join(' · ');
    publishDraw('diagnosed',text);
    return text;
  }
  const verdictOf=result=>result?({clear:'清晰匹配',close:'同族近似',weak:'弱匹配'}[result.status]||result.status):'未通过门控';
  // v2.6.0 置信度门槛：只有「清晰匹配」才自动改会话名；Top3 与拟合/分离始终展示，避免“向某个模型塌缩”被当成确定答案。
  const topThreeOf=result=>((result?.top3||[]).slice(0,3).map(item=>`${item.display_name} ${Number(item.fit).toFixed(3)}`).join(' / '));
  const namingClear=result=>result?.status==='clear'||prefs.renameAnyway===true;
  // v2.8.1：结果面板与气泡统一走这两个函数——置信集 >1 显示家族+候选集，混合/漂移挂提示，弱匹配显示未定。
  const decisionOf=result=>result?.signals?.decision||null;
  const resultLabelOf=result=>{
    if(!result)return '暂无可靠候选';
    const nearest=result.nearest?.display_name||'—',d=decisionOf(result);
    if(result.status==='weak')return `未定（最近 ${nearest}）`;
    if(d&&d.set_size>1)return `${result.nearest?.family_name||nearest} 家族 · 候选 ${d.set_names.join(' / ')}`;
    if(d&&d.mixture)return `${nearest}（疑似近亲混合路由或参考库漂移 ${d.mixture.names.join('+')}）`;
    return nearest;
  };
  const badgeTextOf=result=>({clear:'清晰匹配',close:'同族近似',weak:'弱匹配'}[result?.status]||result?.status||'');
  async function drawRound(index){
    if(generating()){publishDraw('waiting',`第 ${index} 轮：上一条回复仍在生成，等待结束后再新建聊天…`);await waitFor(()=>!generating(),'上一条回复超过 240 秒仍在生成，本轮跳过',240000,null);}
    publishDraw('new-chat',`第 ${index} 轮：正在点击 New Chat…`);
    await newChat();
    publishDraw('mode',`第 ${index} 轮：正在确认 Work / Agent Mode…`);
    await ensureMode();
    guard();
    if(!isNewChatPath(agentPath())||session())throw Error('新聊天状态已变化；未发送');
    if(!modeReady())throw Error('模式已变化；未发送');
    if(editors().some(element=>editorText(element)))throw fatal('输入框有未发送草稿；为避免覆盖，未发送探针');
    const mode=prefs.mode==='precise'?'precise':'quick';
    const plan=planProbes(mode,[],cryptoRandom);
    let active=await mathWarmup(index);
    let record=newRecord(),lastResult=null;
    if(active)records.set(active,record);
    for(const [order,probeIndex] of plan.entries()){
      const label=`第 ${index} 轮 · ${mode==='precise'?`精准 ${order+1}/${plan.length} · `:'快速 · '}`;
      const step=await captureProbe({record,probeIndex,expectedSession:active,label});
      record=step.record;active=step.sessionId;targetSession=active;lastResult=record.result;
      if(order+1<plan.length)await sleep(1200);
    }
    if(prefs.autoTopUp&&mode==='quick'){
      let added=0;
      while(added<2&&record.result&&record.result.status!=='clear'){
        const more=planProbes('precise',usedProbeIndexes(record),cryptoRandom);
        if(!more.length)break;
        const why={clear:'清晰匹配',close:'同族近似',weak:'弱匹配'}[record.result.status]||record.result.status;
        publishDraw('topup',`第 ${index} 轮：${why}，自动补第 ${more[0]+1} 题加强证据…`);
        let step;
        try{step=await captureProbe({record,probeIndex:more[0],expectedSession:active,label:`第 ${index} 轮 · 补题 · `});}
        catch(error){
          if(error?.thinkingBlocked||error?.fatal||!record.samples.length)throw error;
          publishDraw('topup',`第 ${index} 轮：补题失败（${error?.message||'未知原因'}），改用已有证据判定`);
          break;
        }
        record=step.record;active=step.sessionId;targetSession=active;lastResult=record.result;added++;
        if(record.result&&record.result.status!=='clear')await sleep(1000);
      }
    }
    let textNote='';
    if(active&&!cancelled){try{textNote=await textBankScoreActive(active,`第 ${index} 轮 · 文本通道`);}catch{}}
    if(!lastResult)return {sessionId:active,label:'未通过门控',verdict:'未通过门控',status:'none',renamed:false,renameNote:(record.lastCheck?.message||'')+textNote,fit:null,separation:null};
    const top3Now=topThreeOf(lastResult),verdictNow=verdictOf(lastResult);
    const familyNow=(lastResult.top_family&&Number(lastResult.top_family.probability)>=0.8)?lastResult.top_family.name:null;
    const sceneNow=await sceneChannelFor(index,active,lastResult.nearest.display_name);
    if(!namingClear(lastResult)){const fitNow=Number(lastResult.signals?.fit),sepNow=Number(lastResult.signals?.separation);const why=` · 未改名（${verdictNow}）${familyNow?`［${familyNow} 家族］`:''}：Top3 ${top3Now||'—'} · 拟合 ${Number.isFinite(fitNow)?fitNow.toFixed(3):'—'} · 分离 ${Number.isFinite(sepNow)?sepNow.toFixed(3):'—'}${sceneNow}${textNote}`;publishDraw('scored',`第 ${index} 轮：${verdictNow}${familyNow?` ${familyNow} 家族`:''} ${lastResult.nearest.display_name} —— 不改名 · Top3 ${top3Now||'—'}${sceneNow}${textNote}`);return {sessionId:active,label:lastResult.nearest.display_name,verdict:verdictNow,status:lastResult.status,renamed:false,renameNote:why,fit:fitNow,separation:sepNow,top3:top3Now};}
    const label=lastResult.nearest.display_name,verdict=verdictOf(lastResult);
    const title=renameTitleForResult(label,lastResult.status);
    const fit=Number(lastResult.signals?.fit),separation=Number(lastResult.signals?.separation);
    let renamed=false,renameNote='';
    publishDraw('renaming',`第 ${index} 轮：${verdict} ${label}，正在重命名会话…`);
    try{
      const done=await globalThis.ArenaProbeRename.rename({sessionId:active,title,isCurrent:()=>!cancelled&&session()===active});
      renamed=true;renameNote=(done.unchanged?'会话名已一致':`已重命名为 ${done.title}`)+` · Top3 ${topThreeOf(lastResult)||'—'}${sceneNow}${textNote}`;
    }catch(error){renameNote=`重命名失败：${error?.message||'未知原因'}${textNote}`;}
    return {sessionId:active,label,verdict,status:lastResult.status,renamed,renameNote,fit,separation};
  }
  async function runDraw(rounds){if(foldOn)unfoldAll();
    if(draw.running||running)return publicStatus();
    await ensureDebug(true);
    guard();
    const count=Number(rounds);
    if(!Number.isInteger(count)||count<1||count>100){publishDraw('blocked','轮数必须是 1–100 的整数');return publicStatus();}
    await savePrefs({rounds:count});
    cancelled=false;sent=false;targetSession=null;
    draw.running=true;draw.cancelled=false;draw.total=count;draw.round=0;draw.completed=0;draw.failed=0;draw.renamed=0;draw.blocked=0;draw.deleted=0;draw.results=[];
    let consecutive=0,halted=false;
    publishDraw('checking',`准备连续抽卡：共 ${count} 轮 · ${MODE_LABEL[prefs.mode]||MODE_LABEL.quick} · 每轮先发随机数学题过人机验证${prefs.autoTopUp&&prefs.mode!=='precise'?' · 判定不清自动补题':''}${prefs.blockThinking?' · 拦截 thinking':''}${prefs.minPulse>0?` · 额度低于 ${prefs.minPulse}% 自动停止`:''}`);
    try{
      if(prefs.minPulse>0)await refreshBalance(true);
      for(draw.round=1;draw.round<=count;draw.round++){
        if(prefs.minPulse>0){
          const pulse=typeof balanceInfo?.pulse==='number'?balanceInfo.pulse:null;
          if(pulse!==null&&pulse<prefs.minPulse){halted=true;publishDraw('stopped',`额度剩余 ${pctText(pulse)} 低于阈值 ${prefs.minPulse}%，已停止抽卡（第 ${draw.round} 轮未发送）`);break;}
        }
        publishDraw('round',`第 ${draw.round}/${count} 轮：新建聊天 → 随机数学题 → 发送探针（${MODE_LABEL[prefs.mode]||MODE_LABEL.quick}）→ 识别 → 重命名`);
        targetSession=null; // v2.9.23：每轮开局清掉上一轮残留的会话号，thinking 截断时只可能归档本轮新建的对话
        try{
          const result=await drawRound(draw.round);
          draw.results.unshift({round:draw.round,at:Date.now(),label:result.label,verdict:result.verdict,renamed:result.renamed,sessionId:result.sessionId});
          localStats.rounds+=1;if(result.status==='clear')localStats.clear+=1;if(Number.isFinite(result.fit))localStats.fits.push(Number(result.fit));if(Number.isFinite(result.separation))localStats.seps.push(Number(result.separation));void saveLocalStats();
          if(draw.results.length>25)draw.results.length=25;
          if(result.status==='none')draw.failed++;else{draw.completed++;if(result.renamed)draw.renamed++;}
          consecutive=0;
          publishDraw(result.renamed?'renamed':'scored',`第 ${draw.round}/${count} 轮：${result.verdict} ${result.label}${result.renameNote?' · '+result.renameNote:''}`);
          if(prefs.minPulse>0)void refreshBalance(false);
        }catch(error){
          if(draw.cancelled)throw error;
          if(error?.thinkingBlocked){
            draw.blocked++;consecutive=0;
            const candidate=targetSession||session();
            const namedBefore=id=>!!id&&(draw.results.some(entry=>entry.sessionId===id&&entry.renamed)||[...records.entries()].some(([key,record])=>key===id&&record.renameTitle));
            const doomed=namedBefore(candidate)?null:candidate; // v2.9.23：绝不归档已经命名过的会话（此前会误归档上一轮已改名的对话）
            let deleted=false,deleteNote='';
            if(doomed){
              publishDraw('cleanup',`第 ${draw.round}/${count} 轮：已截断 thinking，正在归档该对话…`);
              // 生成还没停下时删除常被忽略：先等它停（最多 12 秒）。
              for(let waited=0;waited<12000&&generating();waited+=300)await sleep(300);
              try{
                const removed=await globalThis.ArenaProbeRename.deleteConversation({sessionId:doomed,isCurrent:()=>!draw.cancelled});
                deleted=!!removed?.deleted;deleteNote=deleted?(removed?.unconfirmed?`已${removed?.archived?'归档':'删除'}（未完全确认）`:(removed?.archived?'已归档该对话':'已删除该对话')):(removed?.note||'未清理');
              }catch(deleteError){deleteNote=`删除失败：${deleteError?.message||'未知原因'}`}
            }else if(!candidate)deleteNote='未建立会话，无需删除';
            else deleteNote='该对话已识别并命名，跳过清理（避免误归档）';
            if(deleted)draw.deleted++;
            draw.results.unshift({round:draw.round,at:Date.now(),label:'thinking 已截断',verdict:deleteNote,renamed:false,sessionId:doomed||null});
            if(draw.results.length>25)draw.results.length=25;
            publishDraw('thinking',`第 ${draw.round}/${count} 轮：检测到 thinking，已立即截断${deleted?'并清理掉该对话':`（${deleteNote}）`} → 下一轮`);
          }else if(error?.fatal){halted=true;publishDraw('stopped',error.message||'自动抽卡已停止');break;}
          else{
            draw.failed++;consecutive++;
            publishDraw('skipped',`第 ${draw.round}/${count} 轮失败：${error?.message||'未知原因'}${consecutive>=3?'；连续失败 3 次，已停止抽卡':'；跳过本轮'}`);
            if(consecutive>=3){halted=true;break;}
          }
        }
        guard();
        await sleep(600);
      }
      if(!halted)publishDraw('done',`抽卡结束：成功识别 ${draw.completed} 轮（已改名 ${draw.renamed} 个），thinking 截断 ${draw.blocked} 轮（已清理 ${draw.deleted} 个对话），跳过 ${draw.failed} 轮；不再自动发送`);
    }catch(error){publishDraw('stopped',error?.message||'自动抽卡已停止');}
    finally{draw.running=false;draw.cancelled=false;sent=false;targetSession=null;paint();}
    return publicStatus();
  }
  function stopDraw(){if(draw.running){draw.cancelled=true;cancelled=true;publishDraw('stopping','正在停止抽卡；不会再发送新消息');}else stop();}

  function el(tag,className,text){const element=document.createElement(tag);if(className)element.className=className;if(text!==undefined)element.textContent=text;return element;}


  /* v2.9.22 页面便捷：一键回到底部 / 一键折叠旧消息（长上下文卡顿时的降载手段）。
     折叠只隐藏「最近 3 条之外」的消息（display:none，最省渲染）；探测/抽卡运行期间自动展开，
     保证 transcriptText 读到完整上下文，运行结束后自动恢复折叠状态。 */
  const FOLD_KEEP=3;let foldOn=false,foldApplied=new WeakSet(),lastResultsSignature='';const toolButtons=[];
  function transcriptRoot(){
    return largestVisible('[role="log"]')||largestVisible('main')||null;
  }
  function chatScroller(){
    let node=transcriptRoot();
    if(!node)return null;
    for(let hop=0;hop<12&&node;hop+=1){
      const style=getComputedStyle(node);
      if(node.scrollHeight>node.clientHeight+40&&/(auto|scroll|overlay)/.test(style.overflowY))return node;
      node=node.parentElement;
    }
    return transcriptRoot();
  }
  function messageRoots(){
    const root=transcriptRoot();
    if(!root)return [];
    let list=root;
    for(let hop=0;hop<4;hop+=1){
      const children=[...list.children].filter(visible);
      if(children.length>1)return children;
      if(children.length===1){list=children[0];continue}
      break;
    }
    const children=[...root.children].filter(visible);
    return children.length>1?children:[];
  }
  function jumpBottom(){
    const scroller=chatScroller();
    if(scroller){try{scroller.scrollTo({top:scroller.scrollHeight,behavior:'smooth'})}catch{scroller.scrollTop=scroller.scrollHeight}return}
    try{window.scrollTo({top:document.body.scrollHeight,behavior:'smooth'})}catch{window.scrollTo(0,document.body.scrollHeight)}
  }
  function applyFold(){
    if(!foldOn)return;
    const roots=messageRoots();
    if(roots.length<=FOLD_KEEP+1)return;
    for(const node of roots.slice(0,roots.length-FOLD_KEEP)){
      if(foldApplied.has(node))continue;
      node.dataset.ampFold='1';node.style.setProperty('display','none','important');foldApplied.add(node);
    }
  }
  function unfoldAll(){
    for(const node of document.querySelectorAll('[data-amp-fold]')){node.style.removeProperty('display');delete node.dataset.ampFold}
    foldApplied=new WeakSet();
  }
  function toggleFold(){foldOn=!foldOn;if(foldOn)applyFold();else unfoldAll();paint();}
  function makeTools(){
    const bottom=el('button','mini','↓');bottom.title='一键回到底部';bottom.addEventListener('click',jumpBottom);
    const fold=el('button','mini','«');fold.title='一键折叠旧消息（只留最近 3 条，长上下文卡顿用）';fold.addEventListener('click',toggleFold);
    toolButtons.push({bottom,fold});return [bottom,fold];
  }  function createHud(){
    document.getElementById(HOST_ID)?.remove();host=el('div');host.id=HOST_ID;host.style.cssText='position:fixed;right:16px;bottom:16px;z-index:2147483647';root=host.attachShadow({mode:'closed'});
    const style=el('style');style.textContent=`:host{all:initial}.box{box-sizing:border-box;width:340px;max-width:calc(100vw - 24px);border:1px solid #3d5e51;border-radius:14px;background:#101a20;color:#e7f1ed;box-shadow:0 16px 50px #0008;font:12px/1.5 system-ui,sans-serif;overflow:hidden}.box *{box-sizing:border-box}[hidden]{display:none!important}.head{display:flex;align-items:center;gap:8px;padding:11px 12px;border-bottom:1px solid #2a3d40;background:#142329}.mark{display:grid;place-items:center;width:23px;height:23px;border:1px solid #56816d;border-radius:7px;background:#224639;color:#bdf0d4;font:700 12px ui-monospace,monospace}.title{flex:1}.title b,.title small{display:block}.title b{font-size:11px}.title small{font-size:8px;color:#84a39c;letter-spacing:.8px}.collapse{width:25px;height:25px;padding:0}.mini{min-width:24px;height:24px;padding:0 5px;font:11px system-ui;line-height:1}.body{padding:11px}.warning{margin:0 0 9px;padding:7px 8px;border-left:2px solid #b48645;background:#251f15;color:#d9c18e;font-size:9px}.controls{display:grid;grid-template-columns:1fr 1fr;gap:6px}.minor{display:flex;gap:6px;margin-top:6px}.minor button{flex:1}button{border:1px solid #466257;border-radius:7px;padding:7px 8px;background:#172823;color:#cfe9dc;font:10px system-ui,sans-serif;cursor:pointer}button:hover:not(:disabled){filter:brightness(1.15)}button:disabled{opacity:.4;cursor:default}.primary{background:#286149;border-color:#559174;color:#f0fff7;font-weight:650}.all{background:#23453a}.stop{color:#efb1ab;border-color:#744b49}.progress{min-height:31px;margin:8px 1px 0;color:#9eb7b0;font-size:9px;line-height:1.55;overflow-wrap:anywhere}.result{margin-top:8px;padding:9px;border:1px solid #416a56;border-radius:9px;background:#173127}.result-top{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}.model{font:650 14px/1.3 ui-monospace,Consolas,monospace;color:#b8efd2;overflow-wrap:anywhere}.badge{white-space:nowrap;border:1px solid #55816b;border-radius:999px;padding:2px 6px;color:#bfead5;font-size:8px}.result[data-level=close]{border-color:#735f39;background:#2a2418}.result[data-level=close] .model{color:#ecd49a}.result[data-level=weak]{border-color:#704946;background:#2d2021}.result[data-level=weak] .model{color:#e9b0aa}.metrics{margin-top:6px;color:#9fb8b1;font:9px/1.55 ui-monospace,Consolas,monospace}.bank{margin-top:4px;color:#748f89;font-size:8px}.draw{margin-top:9px;padding:9px;border:1px solid #35544a;border-radius:9px;background:#12211c}.draw-title{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;font-size:10px;color:#d6ece2;font-weight:650}.draw-grid{display:grid;grid-template-columns:auto 1fr;gap:5px 7px;align-items:center;font-size:9px;color:#9eb7b0}.draw-grid input,.draw-grid select{width:100%;border:1px solid #466257;border-radius:6px;background:#0d1714;color:#dff3e9;padding:4px 6px;font:10px system-ui,sans-serif}.draw-actions{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:7px}.draw-minor{margin-top:6px}.draw-minor button{width:100%}.draw-note{margin:7px 0 0;color:#9eb7b0;font-size:9px;line-height:1.5;overflow-wrap:anywhere}.results{margin-top:6px;display:grid;gap:3px;max-height:108px;overflow:auto}.results div{display:flex;justify-content:space-between;gap:6px;font:9px ui-monospace,Consolas,monospace;color:#a8c3bb}.results b{color:#c8efd9;font-weight:600}.balance{margin-top:8px;padding:7px 8px;border:1px solid #35544a;border-radius:9px;background:#12211c}.balance-row{display:flex;align-items:center;justify-content:space-between;gap:7px;font-size:9px;color:#9eb7b0}.balance-row b{color:#c8efd9;font:600 12px ui-monospace,Consolas,monospace}.balance-note{margin:4px 0 0;color:#7d968f;font-size:8px;line-height:1.5;overflow-wrap:anywhere}.compact{display:flex;align-items:center;gap:7px;padding:8px 10px}.compact-text{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#b8e9d1;font:600 11px system-ui}.expand{width:24px;height:24px;padding:0}.byline{margin:8px 1px 0;color:#6d8a83;font-size:8px;text-align:center}`;
    const box=el('section','box'),head=el('header','head'),mark=el('span','mark','M'),title=el('div','title');title.append(el('b','','Arena Model Probe'),el('small','','OPEN SET · v2.9.25 · BY Vodka'));const collapse=el('button','collapse','—');collapse.title='收起';collapse.addEventListener('click',()=>{collapsed=true;paint();});const headTools=makeTools();head.append(mark,title,headTools[0],headTools[1],collapse);
    const body=el('div','body'),warning=el('p','warning','点击即发送真实消息：快速=随机 1 题（判定不是“清晰匹配”时自动补题，最多 3 题），精准=3 题全问；抽卡每轮执行 New Chat → 随机数学题（过人机验证） → 发探针 → 识别 → 清晰才改名（平衡阈值：拟合≥0.15、分离≥0.06、置信集唯一） → 下一轮。'),controls=el('div','controls');runOneButton=el('button','primary','快速识别 · 随机1题');runAllButton=el('button','all','精准识别 · 3题全问');controls.append(runOneButton,runAllButton);const minor=el('div','minor');appendButton=el('button','','再补 1 题');stopButton=el('button','stop','停止');clearButton=el('button','','清除结果');minor.append(appendButton,stopButton,clearButton);progressNode=el('p','progress');progressNode.setAttribute('role','status');
    resultNode=el('section','result');const resultTop=el('div','result-top');resultModel=el('div','model');resultBadge=el('span','badge');resultTop.append(resultModel,resultBadge);resultMetrics=el('div','metrics');resultBank=el('div','bank');resultNode.append(resultTop,resultMetrics,resultBank);
    const drawBox=el('section','draw'),drawHead=el('div','draw-title');drawHead.append(el('b','','自动抽卡'),el('span','','New Chat 循环'));
    const drawGrid=el('div','draw-grid');
    drawInput=el('input');drawInput.type='number';drawInput.min='1';drawInput.max='100';drawInput.title='抽卡轮数（1–100）';
    drawMode=el('select');for(const [value,label] of [['quick','快速 · 随机1题'],['precise','精准 · 3题全问']]){const option=el('option',null,label);option.value=value;drawMode.append(option);}drawMode.title='识别模式：快速=随机1题；精准=3题全问';
    drawMinPulse=el('input');drawMinPulse.type='number';drawMinPulse.min='0';drawMinPulse.max='100';drawMinPulse.title='额度下限百分比；低于它就停止抽卡，0 表示不限制';
    drawBlockThinking=el('input');drawBlockThinking.type='checkbox';drawBlockThinking.style.cssText='width:auto;height:13px;padding:0;justify-self:start;margin:0';drawBlockThinking.title='开启后：一旦检测到模型开始 thinking，立即截断并进入下一轮（本轮不识别、不改名）';
    drawAutoTopUp=el('input');drawAutoTopUp.type='checkbox';drawAutoTopUp.style.cssText='width:auto;height:13px;padding:0;justify-self:start;margin:0';drawAutoTopUp.title='默认开启：快速模式下若判定不是“清晰匹配”，自动补发剩余探针（最多 3 题）加强证据；判定清晰时只问 1 题，更快';
    drawRenameAnyway=el('input');drawRenameAnyway.type='checkbox';drawRenameAnyway.style.cssText='width:auto;height:13px;padding:0;justify-self:start;margin:0';drawRenameAnyway.title='默认关闭：只有判定“清晰匹配”才自动改会话名；开启后判定不清晰也照旧改名（名字可能不准）';
    drawSceneChannel=el('input');drawSceneChannel.type='checkbox';drawSceneChannel.style.cssText='width:auto;height:13px;padding:0;justify-self:start;margin:0';drawSceneChannel.title='默认开启：每轮再多问 1 道 scene 题（6 道循环：12 字句 / 只回一个字母的单选 / 自选「动物-交通工具」），本机按模型累积答案分布，用 Jensen-Shannon 相似度投票，与数字通道交叉验证。嫌慢可以关掉'
    drawGrid.append(el('label',null,'轮数'),drawInput,el('label',null,'识别模式'),drawMode,el('label',null,'额度下限%'),drawMinPulse,el('label',null,'拦截 thinking'),drawBlockThinking,el('label',null,'自动补题'),drawAutoTopUp,el('label',null,'不确定也改名'),drawRenameAnyway,el('label',null,'scene 通道'),drawSceneChannel);
    drawStartButton=el('button','primary','开始抽卡');drawStopButton=el('button','stop','停止抽卡');
    const drawActions=el('div','draw-actions');drawActions.append(drawStartButton,drawStopButton);
    const drawMinor=el('div','draw-minor');diagnoseButton=el('button',null,'自检（只检查，不发送）');drawMinor.append(diagnoseButton);
    drawProgressNode=el('p','draw-note');drawResultsNode=el('div','results');
    drawBox.append(drawHead,drawGrid,drawActions,drawMinor,drawProgressNode,drawResultsNode);
    const balanceBox=el('section','balance'),balanceRow=el('div','balance-row');balanceNode=el('b','','—');balanceButton=el('button',null,'刷新额度');balanceButton.title='重新读取每日额度';balanceRow.append(el('span',null,'每日额度剩余'),balanceNode,balanceButton);balanceNote=el('p','balance-note','额度来自 arena.ai/api/me/pulse（百分比）');balanceBox.append(balanceRow,balanceNote);
    const byline=el('p','byline','Arena Model Probe · 由 Vodka 制作 · 本机存数字计数与少量节奏特征，不存其他聊天正文');
    traceNode=el('div','bank');traceNode.textContent='轨迹直读：等待 public-access-token（页面自身请求的响应头）';
    body.append(warning,controls,minor,progressNode,resultNode,traceNode,drawBox,balanceBox,byline);
    const compact=el('div','compact');compactText=el('div','compact-text','模型探测');const expand=el('button','expand','↗');expand.title='展开';expand.addEventListener('click',()=>{collapsed=false;paint();});const compactTools=makeTools();compact.append(mark.cloneNode(true),compactText,compactTools[0],compactTools[1],expand);
    runOneButton.addEventListener('click',()=>void run('quick'));runAllButton.addEventListener('click',()=>void run('precise'));appendButton.addEventListener('click',()=>void run('quick'));stopButton.addEventListener('click',()=>{if(draw.running)stopDraw();else stop();});clearButton.addEventListener('click',clearCurrent);
    drawStartButton.addEventListener('click',()=>void runDraw(Number(drawInput.value)));
    drawStopButton.addEventListener('click',stopDraw);
    diagnoseButton.addEventListener('click',()=>void diagnose());
    balanceButton.addEventListener('click',()=>void refreshBalance(true));
    drawInput.addEventListener('change',()=>void savePrefs({rounds:Number(drawInput.value)}));
    drawMode.addEventListener('change',()=>void savePrefs({mode:drawMode.value}));
    drawMinPulse.addEventListener('change',()=>void savePrefs({minPulse:Number(drawMinPulse.value)}));
    drawBlockThinking.addEventListener('change',()=>void savePrefs({blockThinking:!!drawBlockThinking.checked}));
    drawAutoTopUp.addEventListener('change',()=>void savePrefs({autoTopUp:!!drawAutoTopUp.checked}));
    drawRenameAnyway.addEventListener('change',()=>void savePrefs({renameAnyway:!!drawRenameAnyway.checked}));
    drawSceneChannel.addEventListener('change',()=>void savePrefs({sceneChannel:!!drawSceneChannel.checked}));
    box.append(head,body,compact);root.append(style,box);document.documentElement.append(host);paint();
  }
  /* v2.9.x 页面性能：把同一拍内的多次 paint() 调用合并为一次渲染，避免重复强制重排（HUD 只面向本机显示）。 */
  let paintQueued=false;
  function paint(){if(paintQueued)return;paintQueued=true;queueMicrotask(()=>{paintQueued=false;renderHud();});}
  function renderHud(){
    if(!agentPage()){if(host)host.hidden=true;return;}if(!host?.isConnected)createHud();host.hidden=false;
    const body=root.querySelector('.body'),head=root.querySelector('.head'),compact=root.querySelector('.compact');
    const state=publicStatus(),samples=state.samples||0,busy=state.running;
    const autoBusy=busy||state.draw.running; // v2.9.18：只在运行开始时自动收起一次，用户手动点 ↗ 展开后保持展开（此前每秒重画都会再次强制收起，表现为「抽卡时被缩小后弹不出来」）。原 v2.9.15 目的不变：小窗口下不挡发送按钮
    if(autoBusy&&!collapsed&&!autoCollapsed){collapsed=true;autoCollapsed=true;}
    else if(!autoBusy&&autoCollapsed){collapsed=false;autoCollapsed=false;}
    body.hidden=collapsed;head.hidden=collapsed;compact.hidden=!collapsed;
    runOneButton.disabled=busy||samples>=3;runAllButton.disabled=busy||samples>=3;stopButton.disabled=!busy;
    appendButton.disabled=busy||samples===0||samples>=3;
    appendButton.textContent=samples>=3?'3 题已问完':`再补 1 题（已 ${samples}/3）`;
    clearButton.disabled=busy||(!samples&&!state.result);
    
    
    runOneButton.textContent=busy?'运行中…':'快速识别 · 随机1题';runAllButton.textContent=busy?'运行中…':'精准识别 · 3题全问';progressNode.textContent=state.progress||progress;
    if(state.result){resultNode.hidden=false;resultNode.dataset.level=state.result.status;resultModel.textContent=resultLabelOf(state.result);resultBadge.textContent=badgeTextOf(state.result);resultMetrics.textContent=`拟合 ${Number(state.result.signals.fit).toFixed(3)} · 分离 ${Number(state.result.signals.separation).toFixed(3)} · 家族 ${(Number(state.result.signals.family_probability)*100).toFixed(1)}% · 有效 ${state.result.used_outputs}/${samples} · 数字 ${Number.isFinite(Number(state.result.signals.evidence_numbers))?Number(state.result.signals.evidence_numbers):'—'}${state.result.signals.pooled?'（池化）':''} · 候选集 ${decisionOf(state.result)?.set_size??1}${decisionOf(state.result)?.off_reference?' · 混合/漂移提示':''} · Top3 ${topThreeOf(state.result)||'—'}`;resultBank.textContent=`${state.result.bank_source} · ${state.result.bank_models} 个候选 · ${localSummary()}`;compactText.textContent=`${resultBadge.textContent} · ${resultLabelOf(state.result)}`;}
    else{resultNode.hidden=true;compactText.textContent=state.draw.running?`抽卡 ${state.draw.round}/${state.draw.total}`:samples?`已捕获 ${samples}/3 条`:'模型探测';}
    const focused=root.activeElement;
    if(focused!==drawInput)drawInput.value=String(state.prefs.rounds);
    if(focused!==drawMode)drawMode.value=String(state.prefs.mode||'quick');
    if(focused!==drawMinPulse)drawMinPulse.value=String(state.prefs.minPulse);
    if(focused!==drawBlockThinking)drawBlockThinking.checked=!!state.prefs.blockThinking;
    if(focused!==drawAutoTopUp)drawAutoTopUp.checked=state.prefs.autoTopUp!==false;
    if(focused!==drawRenameAnyway)drawRenameAnyway.checked=state.prefs.renameAnyway===true;
    if(focused!==drawSceneChannel)drawSceneChannel.checked=state.prefs.sceneChannel!==false;
    drawStartButton.disabled=busy;drawStopButton.disabled=!state.draw.running;
    drawProgressNode.textContent=state.draw.note||'设定轮数后点击「开始抽卡」：每轮自动新建聊天、发送探针、识别模型并改名。';
    const entries=state.draw.results||[];const resultsSignature=entries.slice(0,6).map(entry=>String(entry.round)+'|'+entry.label+'|'+(entry.renamed?'1':'0')+'|'+entry.verdict).join(';');if(resultsSignature!==lastResultsSignature){lastResultsSignature=resultsSignature;
    drawResultsNode.replaceChildren(...entries.slice(0,6).map(entry=>{const row=el('div');row.append(el('span',null,`${entry.round}. ${entry.label}`),el('b',null,entry.renamed?'已改名':entry.verdict));return row;}));}
    balanceNode.textContent=state.balanceLoading?'读取中…':typeof state.balance?.pulse==='number'?pctText(state.balance.pulse):'—';
    if(traceNode){const tr=state.trace||{};const modelCount=Array.isArray(tr.models)?tr.models.length:0;const recent=Array.isArray(tr.recent)?tr.recent.slice(0,3).join(' | '):'';const pageUrls=Array.isArray(tr.scan?.urls)?tr.scan.urls.slice(0,2).join(' | '):'';const alive=tr.pageSnifferAt?new Date(tr.pageSnifferAt).toTimeString().slice(0,8):'未见信号';const scan=tr.scan||{};traceNode.textContent=`轨迹直读：${tr.text||'等待 public-access-token'} · 页面观测${tr.tokenSeen?'到':'不到'}token · 模型字段${modelCount} · 嗅探:${alive} · 扫描:${scan.req||0}req/${scan.body||0}体/${scan.chunks||0}片${pageUrls?` · 页面:${pageUrls}`:''}${recent?` · 最近:${recent}`:''}`;}
    balanceNote.textContent=state.balanceError?state.balanceError:(state.balance?.refreshedAt?`每日额度剩余 · 下次重置 ${clock(state.balance.refreshedAt)}`:'额度来自 arena.ai/api/me/pulse（百分比）');
    balanceButton.disabled=state.balanceLoading;

    const foldLabel=foldOn?'»':'«';
    for(const pair of toolButtons){if(pair.fold.textContent!==foldLabel)pair.fold.textContent=foldLabel;pair.fold.title=foldOn?'展开被折叠的旧消息':'一键折叠旧消息（只留最近 3 条；运行时自动展开）';}
    if(foldOn&&!busy&&!state.draw.running)applyFold();
  }

  chrome.runtime.onMessage.addListener((message,_sender,reply)=>{
    if(message?.type==='AMP_STATUS'){reply(publicStatus());return;}
    if(message?.type==='AMP_RUN_QUICK'||message?.type==='AMP_RUN_ONE'){draw.note='';void run('quick');reply(publicStatus());return;}
    if(message?.type==='AMP_RUN_PRECISE'||message?.type==='AMP_RUN_THREE'){draw.note='';void run('precise');reply(publicStatus());return;}
    if(message?.type==='AMP_RUN_APPEND'){draw.note='';void run('quick');reply(publicStatus());return;}
    if(message?.type==='AMP_STOP'){if(draw.running)stopDraw();else stop();reply(publicStatus());return;}
    if(message?.type==='AMP_CLEAR'){reply(clearCurrent());return;}
    if(message?.type==='AMP_DRAW_START'){void runDraw(message.rounds);reply(publicStatus());return;}
    if(message?.type==='AMP_DRAW_STOP'){stopDraw();reply(publicStatus());return;}
    if(message?.type==='AMP_DIAGNOSE'){void diagnose().then(text=>reply({...publicStatus(),diagnose:text}));return true;}
    if(message?.type==='AMP_PREFS_SET'){void savePrefs(message.patch||{}).then(()=>reply(publicStatus()));return true;}
    if(message?.type==='AMP_BALANCE_REFRESH'){void refreshBalance(true).then(()=>reply(publicStatus()));return true;}
  });
  /* v2.9.0 网络层嗅探中继（D）：MAIN world 的 network-sniffer.js 用 window.postMessage 送出
     模型字段与 public-access-token，这里原样转给 background（隔离世界拿不到页面上下文）。 */
  window.addEventListener('message',event=>{
    if(event.source!==window)return;
    const data=event.data;
    if(!data||data.source!=='amp-network-sniffer')return;
    try{
      void chrome.runtime.sendMessage({type:'AMP_NET',evidence:data.evidence||[],models:data.models||[],pageUrl:location.href}).then(response=>{
        if(response&&typeof response==='object'){globalThis.__ampNetwork=response;globalThis.__ampTrace=response.trace||response;paint();}
      }).catch(()=>{});
    }catch{}
  });
  window.addEventListener('pagehide',()=>{cancelled=true;});
  window.addEventListener('popstate',paint);window.navigation?.addEventListener('navigatesuccess',paint);
  new MutationObserver(()=>{if(host&&!host.isConnected)createHud();}).observe(document,{childList:true,subtree:true});
  try{document.documentElement.dataset.ampBuild='v2917M';}catch{} // 构建标记：验证页面注入的是最新脚本
  /* 页面性能：1s 无条件重画改事件驱动 —— 路由/历史变更与嗅探回包即时重画（它们正是 agentPage/explicit 状态变化的来源），
     另留 5s 低频兜底兜住其余不定期变化（显隐判断仍在 paint 内部，行为语义不变）。 */
  createHud();setInterval(paint,5000);
  setInterval(()=>{if(running||draw.running){try{chrome.runtime.sendMessage({type:'AMP_PING'}).catch(()=>{});}catch{}}},20000); // v2.9.15：运行期给 SW 保活，防止调试会话因 SW 挂起变孤儿
  void loadPrefs().then(()=>loadLocalState()).then(()=>{paint();void refreshBalance(false);});

})();

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
   v2.10.0：价格通道 —— 接入 arena.ai 公开的「每模型任务成本」（Agent Pareto 榜，见 price-channel.js 与 Arena价格接口调研.md）：
           评分结果附上候选的成本档位，嗅探器新增只读抓取 usage/cost 字段，自检里报告成本表状态与现场成本信号；
           网页版不下发每次请求的美元成本，故默认只作旁证（不参与指纹判定）；一旦抓到现场成本即自动做成本一致性核对。
           网关侧的真·按成本识别见 tools/arena-gateway-cost.mjs。
   v2.11.0：用量通道 —— CDP 实测确认 Arena 会下发每条消息的 token 用量（GET /api/evaluation/<sid> 的
           messages[].metadata.usage，见 usage-channel.js 与 Arena成本接口实测.md）：嗅探器只读抽取整个 usage 对象，
           浮层与自检报告「最近一次 / 累计」用量与形态签名（缓存写入 cw / 缓存读取 cr / 推理 token rz）；
           美元成本仍由前端自算（metadata.cost 为 null），故只报 token、绝不折算猜价。
   v2.12.0：单价通道 —— 找到「按价格反推模型」的真正方法（见 pricing-channel.js 与 Arena成本接口实测.md）：
           ① 单价是**公开**的：榜单 RSC 每行带 inputPricePerMillion / outputPricePerMillion（USD/百万 token），
              随包快照 arena-pricing-table.json（208 行，其中 193 个文本模型可参与反推，15 个图像/视频模型按张/秒计已剔除）；
           ② 公式：期望成本(模型) = Σ tokensᵢ/1e6 × priceᵢ(模型)；有真实按次成本时比值最接近 1 的就是它；
           ③ 指纹库基础 id（gpt-6-astra）与 Arena 变体 key（gpt-6-astra-max-agent）自动归一化匹配，含
              「点号版本号」与「前缀吞并」两个坑的消歧；
           ④ 真实按次成本走 GET /api/chat/:id/cost（Agent）与 GET /api/evaluation/:id/cost（Battle），
              实测按账号灰度：本机账号全部 403（非鉴权问题，带有效 Supabase JWT 亦 403），故浮层先报「价格区分度」，
              拿到成本后自动升级为按价排序。
   v2.13.1：补齐 Arena `/cost` 会话级聚合的**真实字段名** —— 旧字段表漏掉了
           actualTotalUsd / chargedTotalUsd / costMultiplier / marginMultiplier / totalChargedCredits
           与 9 个分项 *CostUsd，于是**正则兜底路径**只能兜到 base、拿不到实扣价与倍率
           （结构化解析路径本来就能拿到，但它硬依赖 JSON.parse）。现在四类字段
           （usd / credits / multiplier / tokens）都能抽，且实测确认：**实扣 = base × 2**
           （Arena 固定加价倍率），base 才是与「Σ token × 公开单价」同口径的那一半 → 按价反推用 base。
           自检新增「本账号能否读成本（/cost）」一行。
    2.9.24：性能与稳定性优化——轮询改 MutationObserver 变更唤醒（domTick，无变化低频兜底、有变化即时复查）；innerText 加 250ms 拍内读缓存；嗅探器 Worker 消息降耗（字符串直扫、跳过大字符串/二进制）；New Chat 链接与侧栏按钮改受信任点击兜底。
   额度端点 /api/me/pulse 的语义来自 Arena Trace Inspector 2.3.2，详见 billing.js 顶部注释。 */
(() => {
  const {probes,sceneProbes,sceneParseChoice,sceneParsePick,sceneVote,signatures,selectCandidate,isTaskSuccessText,isContinueWorkText,renameTitleForResult,planProbes,validateScene,findSceneSentence,sceneKeyOf,sceneClusterOf,TEXT_PROBES,TEXT_SCORE_PROBES,TEXT_BANK_TARGET}=globalThis.ArenaProbeRuntime;
  const records=new Map();
  const HOST_ID='arena-model-probe-standalone';
  const PREFS_KEY='amp.draw.prefs.v3';
  const LEGACY_PREFS_KEY='amp.draw.prefs.v2';
  const DEFAULTS=Object.freeze({rounds:5,mode:'price',minPulse:0,blockThinking:false,autoTopUp:true,renameAnyway:false,sceneChannel:true,priceChannel:false});
  const MODE_LABEL=Object.freeze({quick:'数字指纹',precise:'数字指纹 · 精准 3 题',price:'价格指纹',combined:'组合 · 数字 + 价格'});
  const draw={running:false,cancelled:false,total:0,round:0,completed:0,failed:0,renamed:0,blocked:0,deleted:0,phase:'idle',note:'',results:[]};
  let prefs={...DEFAULTS};
  let host=null,root=null,collapsed=false,autoCollapsed=false;
  /* v2.19.2 浮层拖动：拖标题栏把浮层挪走（记位置到 storage，重开仍在原处）。
     pos=null 表示用默认停靠（右下角）；一旦拖动过就转成 left/top 绝对定位。 */
  let pos=null,dragState=null;
  const POS_KEY='amp.hud.pos.v1';
  let runOneButton,runAllButton,runPriceButton,stopButton,clearButton,progressNode,resultNode,resultModel,resultBadge,resultMetrics,resultBank,traceNode,compactText;
  let drawInput,drawMode,drawMinPulse,drawBlockThinking,drawAutoTopUp,drawRenameAnyway,drawSceneChannel,drawStartButton,drawStopButton,drawProgressNode,drawResultsNode,balanceNode,balanceNote,balanceButton,diagnoseButton,appendButton;
  /* v2.13.2 花费账本节点 */
  let ledgerBox,ledgerSummary,ledgerRatio,ledgerTable,ledgerNote,ledgerButton,ledgerToggle;
  /* v2.19.1 Tab 布局：三个面板 + 页签按钮 + 价格指纹面板节点。 */
  let tabsBar,tabs={},panels={},panelNumeric,panelPrice,panelCost;
  let fpCard,fpName,fpBadge,fpLine,fpCaveat,fpMeta,costTableWrap,costTableBody,costTableFoot,costTableEmpty,costTableNote,costTableEl;
  /* v2.19.3：未唯一定名时把候选列出来（参考对手插件的呈现 —— 只报「不能定名」看不到候选，用户无从判断）。 */
  let fpCands,fpCandsList;
  let running=false,cancelled=false,sent=false,targetSession=null,phase='idle',progress='点击即发送真实探针，不再弹出确认';
  let pendingPrompt='';
  let balanceInfo=null,balanceError='',balanceLoading=false;
  /* v2.13.2 花费账本状态：data 来自后台 AMP_LEDGER；展开明细时才拉取。 */
  const ledgerState={data:null,error:'',loading:false,expanded:false,at:0,costProbe:null,requestId:0};
  /* v2.19.1：最近一次价格指纹裁决（价格模式 或 价格旁证通道）—— 供「价格指纹」页签展示。 */
  let lastPriceFingerprint=null;
  let hudSessionKey=null,hudEpoch=0;

  const visible=element=>{
    if(!element?.isConnected||!element.getClientRects().length)return false;
    if(['dialog','alertdialog','menu'].includes(element.getAttribute('role'))&&element.getAttribute('data-state')==='closed')return false;
    if(typeof getComputedStyle==='function'){const style=getComputedStyle(element);if(style.display==='none'||style.visibility==='hidden')return false;}
    return true;
  };
  const session=()=>{const match=location.pathname.match(/^\/[^\s]+\/([a-zA-Z0-9-]{8,128})\/?$/);return match&&!/^(?:code|text|webdev|image|search|vision|login|signup|settings)$/i.test(match[1])?match[1]:null;}; // 各模式会话统一取末段 ID（≥8 位，排除 code 等路由词）
  function syncHudSession(){
    const key=session()||location.pathname;
    if(key===hudSessionKey)return;
    const previous=hudSessionKey;hudSessionKey=key;hudEpoch++;
    unfoldAll();
    lastPriceFingerprint=null;
    Object.assign(ledgerState,{data:null,error:'',loading:false,expanded:false,at:0,costProbe:null,requestId:ledgerState.requestId+1});
    globalThis.__ampTrace=null;globalThis.__ampNetwork=null;
    if(previous!==null&&!running&&!draw.running){
      phase='idle';progress='新会话：请选择模式后开始识别';
      Object.assign(draw,{note:'',results:[],phase:'idle',round:0,total:0,completed:0,failed:0,renamed:0,blocked:0,deleted:0});
    }
    if(running&&targetSession&&session()!==targetSession)cancelled=true;
  }
  /* Arena 站点源：生产 arena.ai 与预发布 canary.arena.ai（同一产品；登录态/新功能常先在 canary）。 */
  const ARENA_ORIGIN_RE=/^https:\/\/(?:canary\.)?arena\.ai$/;
  const agentPage=()=>ARENA_ORIGIN_RE.test(location.origin); // arena.ai / canary.arena.ai 全站显示浮层（Battle 挂在首页路径，不再排除首页）
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
    const mode=['price','quick','combined'].includes(value?.mode)?value.mode:(value?.mode==='precise'||value?.probesPerChat===3?'quick':DEFAULTS.mode);
    return {rounds:clampInt(value?.rounds,1,100,DEFAULTS.rounds),mode,minPulse:clampInt(value?.minPulse,0,100,DEFAULTS.minPulse),blockThinking:value?.blockThinking===true,autoTopUp:value?.autoTopUp!==false,renameAnyway:value?.renameAnyway===true,sceneChannel:value?.sceneChannel!==false,priceChannel:value?.priceChannel===true};


  }
  const storageGet=key=>new Promise(resolve=>{try{chrome.storage.local.get(key,items=>resolve(items&&typeof items==='object'?items:{}));}catch{resolve({});}});
  const storageSet=value=>new Promise(resolve=>{try{chrome.storage.local.set(value,()=>resolve(true));}catch{resolve(false);}});
  /* ---------- v2.7.0 本机 scene 通道 + 本机标定（全部只存本机） ---------- */
  const SCENE_KEY='amp.scene.bank.v1';
  const STATS_KEY='amp.local.stats.v1';
  let sceneBank={clusters:[],byPrompt:{}},localStats={rounds:0,clear:0,fits:[],seps:[]};
  async function loadLocalState(){try{const items=await storageGet([SCENE_KEY,STATS_KEY,COST_TAB_KEY,POS_KEY]);const bank=items&&items[SCENE_KEY];const stats=items&&items[STATS_KEY];const tab=items&&items[COST_TAB_KEY];const savedPos=items&&items[POS_KEY];if(savedPos&&Number.isFinite(Number(savedPos.left))&&Number.isFinite(Number(savedPos.top)))pos={left:Number(savedPos.left),top:Number(savedPos.top)};if(tabs[tab])selectTab(tab);if(bank&&typeof bank==='object'){sceneBank={clusters:Array.isArray(bank.clusters)?bank.clusters.slice(0,60):[],byPrompt:bank.byPrompt&&typeof bank.byPrompt==='object'?bank.byPrompt:{}};}if(stats&&typeof stats==='object')localStats={rounds:Number(stats.rounds)||0,clear:Number(stats.clear)||0,fits:Array.isArray(stats.fits)?stats.fits.slice(-40):[],seps:Array.isArray(stats.seps)?stats.seps.slice(-40):[]};}catch{}}
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
  /* v2.17.0 价格指纹通道：把「花费反推」收窄到本轮的**识别候选集**内。
     与 scene 通道（只加提示、不改名）不同，价格指纹在候选集合内**可单独定名** ——
     但门槛由后台把关（唯一命中 + 比值贴合 + 无同价歧义），这里只消费 separable 判据，
     不自己重算阈值。识别结果里已带 price_fingerprint（AMP_SCORE 同轮算好），
     这里只在判定非 clear 时按需再拉一次（账单可能是识别之后才探测到的）。 */
  async function priceChannelFor(active,label,result){
    syncHudSession();const epoch=hudEpoch;
    if(prefs.priceChannel!==true)return null;
    /* 优先用本轮识别结果自带的价格指纹；没有再问后台要（此时候选人来自识别结果）。 */
    let fp=result?.price_fingerprint||null;
    if(!fp||fp.reason==='no-cands'||fp.reason==='no-candidates'){
      const candidates=[result?.nearest?.id,...((result?.top3)||[]).map(item=>item?.id)].filter((id,index,list)=>typeof id==='string'&&list.indexOf(id)===index);
      if(!candidates.length)return null;
      let probe=null;
      try{probe=await probeCostRoute(active);}catch{}
      try{
        fp=await chrome.runtime.sendMessage({type:'AMP_COST_REVERSE',candidates,costPayload:probe?.status===200&&!probe.reason?probe.payload:null});
        /* AMP_COST_REVERSE 返回的是全库/候选内的花费反推；这里再收窄到 separable 判据。 */
        if(fp&&!fp.blocked&&Array.isArray(fp.hits)&&fp.hits.length){
          /* v2.19.5：这段是 background.js `priceFingerprintBlock` 判据的**镜像** —— content script
             不能 import ES 模块，只能各存一份，**两边必须同步**（tests 有断言）。
             此前两处都写错了同一件事：① z 的除数用 Math.log(2)，而 pricing-channel 用
             ln(CONSISTENT_RATIO=1.6)，刻度差 1.47 倍 ⇒ 0.8 实际等效 1.18，比「相符界 1.0」还松；
             ② 只比 top1/top2 的 z 差，从没数窗口里有几个模型（实测有 14 个落在 ±15% 内）。 */
          const FP_WINDOW=1.10,FP_GAP_RATIO=1.25,FP_LN_CONSISTENT=Math.log(1.6);
          const fpZ=Math.log(FP_WINDOW)/FP_LN_CONSISTENT,fpGap=Math.log(FP_GAP_RATIO)/FP_LN_CONSISTENT;
          const best=fp.hits[0],runner=fp.hits[1]||null;
          const zOf=hit=>Math.abs(Math.log(Number(hit.ratio)||1))/FP_LN_CONSISTENT;
          const within=zOf(best)<=fpZ;
          const separated=!runner||zOf(runner)>zOf(best)+fpGap;
          const uniqueInWindow=fp.hits.filter(hit=>zOf(hit)<=fpZ).length===1;
          const ambiguous=(fp.same_price_groups||[]).some(group=>group.ambiguous&&group.ids.includes(best.model_key));
          const ok=within&&separated&&uniqueInWindow&&!ambiguous;
          fp={separable:ok,hit:best,runner_up:runner,reason:ok?'unique':'not-separable',
            text:`价格指纹: ${ok?`${best.label||best.model_key}（唯一命中 · 比值 ${best.ratio}）`:`不能唯一定名（候选 ${candidates.length} 个，价格切不开）`}`};
        }
      }catch{}
    }
    syncHudSession();if(epoch!==hudEpoch||active!==session()||!fp)return null;
    const text=fp.text||fp.note||'';
    lastPriceFingerprint=fp;   // v2.19.1：价格旁证结果也进价格面板
    return {fingerprint:fp,text,label:label||null};
  }
  /* v2.18.0「价格指纹」独立识别模式：不走数字候选集，直接请后台在全库模型里按价格裁决。
     用户选择这个模式 = 明确只用价格识别，所以候选范围是全部指纹库模型（scope:'full-bank'）。
     全库比价「无数个价格都贴近」的概率天然更高，判据一条不松 —— 切不到唯一就如实说不确定。
     v2.19.0：后台新增硬筛选腿（分项费用整数反推）并与软判据交叉验证 ——
     一致 → separable:true（evidence:'both'）；分歧 → separable:false（evidence:'conflict'）。 */
  async function priceModeFor(active){
    syncHudSession();const epoch=hudEpoch;
    lastPriceFingerprint=null;
    let probe=null;
    try{probe=await probeCostRoute(active);}catch{}
    syncHudSession();if(epoch!==hudEpoch||active!==session())return {fingerprint:null,text:'会话已切换，丢弃旧结果',label:null};
    if(probe?.status!==200||probe.reason||!Object.keys(probe.payload?.messages||{}).length){
      lastPriceFingerprint={separable:false,reason:'no-current-cost',text:'本会话尚无可用的逐条账单，价格识别待命'};
      return {fingerprint:lastPriceFingerprint,text:lastPriceFingerprint.text,label:null};
    }
    let fp=null;
    try{fp=await chrome.runtime.sendMessage({type:'AMP_PRICE_FULL',costPayload:probe?.status===200&&!probe.reason?probe.payload:null});}catch{}
    syncHudSession();if(epoch!==hudEpoch||active!==session())return {fingerprint:null,text:'会话已切换，丢弃旧结果',label:null};
    if(!fp||fp.error)return {fingerprint:null,text:fp?.error?`价格指纹: 查询失败（${fp.error}）`:'价格指纹: 未拿到结果',label:null};
    const text=fp.text||fp.note||'';
    lastPriceFingerprint=fp;   // v2.19.1：价格模式裁决结果进价格面板
    return {fingerprint:fp,text,label:fp.hit?(fp.hit.label||fp.hit.model_key):null};
  }
  function priceChoice(fp){
    const hit=fp?.hit;
    if(hit)return {label:hit.label||hit.model_key,id:hit.model_key,note:fp.separable?'价格唯一定名':'价格最接近（非确定识别）'};
    const tied=fp?.hard_filter?.candidates?.[0]||fp?.rate_family?.models?.[0];
    return tied?{label:tied.display||tied.model_key,id:tied.model_key,note:'只有整数整除候选，无法比较远近；并列取首项（非确定识别）'}:null;
  }
  async function recognitionFor(active,result,mode){
    syncHudSession();const epoch=hudEpoch;
    const raw=[result?.nearest,...(result?.top3||[])].filter((c,i,all)=>c?.id&&all.findIndex(other=>other?.id===c.id)===i);
    let candidates=[];
    if(mode!=='price'&&raw.length){
      try{
        const prices=await chrome.runtime.sendMessage({type:'AMP_PRICING',ids:raw.map(c=>c.id)});
        const arenaIds=new Set((prices?.candidates||[]).filter(c=>c.arena_listed===true).map(c=>c.id));
        candidates=raw.filter(c=>arenaIds.has(c.id));
      }catch{}
      syncHudSession();if(epoch!==hudEpoch||active!==session())return null;
    }
    const nearest=candidates[0];
    const numeric=nearest?{label:nearest.display_name||nearest.id,id:nearest.id,note:'Arena 模型池内数字最接近（候选排序，非确定识别）'}:null;
    if(mode!=='price'&&mode!=='combined')return numeric;
    if(mode==='price'||!numeric){
      const pm=await priceModeFor(active);
      const choice=priceChoice(pm?.fingerprint);
      if(choice&&pm?.fingerprint)pm.fingerprint.suggestion=choice;
      return choice?{...choice,note:[mode==='combined'?'组合模式缺少数字结果，退回价格排序':'',choice.note,pm?.text].filter(Boolean).join(' · ')}:null;
    }
    syncHudSession();if(epoch!==hudEpoch||active!==session())return null;
    let reverse=null;
    try{
      const probe=await probeCostRoute(active);
      syncHudSession();if(epoch!==hudEpoch||active!==session())return null;
      if(probe?.status===200&&!probe.reason&&Object.keys(probe.payload?.messages||{}).length)reverse=await chrome.runtime.sendMessage({type:'AMP_COST_REVERSE',candidates:candidates.map(c=>c.id),costPayload:probe?.status===200&&!probe.reason?probe.payload:null});
      else reverse={blocked:'no-current-cost',note:'本会话尚无可用的逐条账单'};
    }catch{}
    syncHudSession();if(epoch!==hudEpoch||active!==session())return null;
    const ranked=[];
    if(!reverse?.blocked&&!reverse?.error){
      for(const hit of reverse?.hits||[]){
        const candidate=candidates.find(c=>c.id===hit.model_key);
        const fit=Number(candidate?.fit??(candidate?.id===result.nearest.id?result.signals?.fit:null));
        if(!candidate||!Number.isFinite(fit)||!(Number(hit.ratio)>0))continue;
        const z=Math.log(Number(hit.ratio))/Math.log(1.6);
        const score=Math.max(0,Math.min(1,fit))*Math.exp(-0.5*z*z)*(hit.complete?1:0.6);
        ranked.push({candidate,hit,score});
      }
    }
    ranked.sort((a,b)=>b.score-a.score);
    if(!ranked.length){
      lastPriceFingerprint={separable:false,scope:'candidates',reason:'no-price',text:'组合模式：价格数据不可用，退回数字排序',note:reverse?.note||reverse?.error||'没有可联合排序的价格数据'};
      return {...numeric,note:`组合模式：价格数据不可用，退回数字排序 · ${reverse?.note||reverse?.error||''}`};
    }
    const best=ranked[0],runner=ranked[1];
    const choice={label:best.candidate.display_name||best.candidate.id,id:best.candidate.id,note:`Arena 模型池内组合最接近 · 数字拟合 × 价格贴合度 ${best.score.toFixed(4)}（启发式排序，非确定识别）`};
    lastPriceFingerprint={separable:false,scope:'candidates',reason:'combined-ranking',evidence_label:'组合排序',hit:{...best.hit,label:choice.label},runner_up:runner?.hit||null,hard_filter:reverse?.hard_filter,rate_family:reverse?.rate_family,suggestion:choice,text:choice.note,note:'在数字候选中联合排序；缺失单价的模型不参与组合评分'};
    return choice;
  }
  async function finishRecognition(active,record,mode,index=null){
    syncHudSession();const epoch=hudEpoch;
    const choice=await recognitionFor(active,record.result,mode);
    syncHudSession();if(epoch!==hudEpoch||active!==session())return {sessionId:active,label:'会话已切换',verdict:'旧结果已丢弃',status:'stale',renamed:false,renameNote:'会话已切换',fit:null,separation:null};
    record.recognition={mode,label:choice?.label||null,id:choice?.id||null,note:choice?.note||'Arena 官方价目内没有可用候选'};
    const result=record.result;
    const verdict=choice?.note||'没有可用候选';
    let renamed=false,renameNote=prefs.renameAnyway?'无可用候选，未改名':'未勾选改名';
    const announce=(phase,text)=>index===null?publish(phase,text,record):publishDraw(phase,`第 ${index} 轮：${text}`);
    if(choice?.label&&active&&prefs.renameAnyway&&!cancelled){
      announce('renaming',`按最接近候选重命名为 ${choice.label}…`);
      try{
        const done=await globalThis.ArenaProbeRename.rename({sessionId:active,title:choice.label,isCurrent:()=>!cancelled&&session()===active});
        renamed=true;record.renameTitle=done.title;record.renameError='';renameNote=done.unchanged?'名称已一致':`已重命名为 ${done.title}`;
      }catch(error){record.renameError=error?.message||'重命名失败';renameNote=`重命名失败：${record.renameError}`;}
    }
    announce('done',`${MODE_LABEL[mode]||MODE_LABEL.quick}：${choice?.label||'暂无候选'} · ${verdict} · ${renameNote}`);
    return {sessionId:active,label:choice?.label||'暂无候选',verdict,status:mode==='price'?'price':mode==='combined'?'combined':result?.status||'none',renamed,renameNote,fit:Number.isFinite(Number(result?.signals?.fit))?Number(result.signals.fit):null,separation:Number.isFinite(Number(result?.signals?.separation))?Number(result.signals.separation):null,top3:topThreeOf(result),byPrice:mode==='price'};
  }
  /* v2.19.0：价格指纹结论的**披露附注** —— 借鉴参考扩展 cost-browser-extension 的保守措辞。
     三件事必须说清：① 硬筛选结果与来源；② 单次调用口径未验证；③ 缓存费率非官方口径。 */
  function priceFingerprintCaveat(fp){
    if(!fp||typeof fp!=='object')return '';
    const bits=[];
    const hard=fp.hard_filter;
    if(hard){
      if(hard.state==='unique')bits.push(`硬筛选：${hard.checked_models} 个模型里只此一个能整除分项账单`);
      else if(hard.state==='multiple')bits.push(`硬筛选：${hard.candidates?.length||0} 个模型都能整除分项账单（切不开）`);
      else if(hard.state==='none')bits.push('硬筛选：没有模型能整除分项账单');
      else if(hard.state==='partial-only')bits.push(`硬筛选：${hard.partial||0} 个模型费率不全，只能进待定`);
      if(hard.partial>0&&hard.state!=='partial-only')bits.push(`${hard.partial} 个变体缺费率待定`);
      if(hard.uses_batch_rate)bits.push('⚠️ 命中的缓存费率取自 :batch 半价条目');
    }
    if(fp.evidence==='both')bits.push('硬筛选与软判据同指一个模型');
    else if(fp.evidence==='conflict'){
      const c=fp.conflict||{};
      bits.push(`⚠️ 两条证据分歧：整数反推指向 ${c.hard_label||c.hard||'—'}，比值判据指向 ${c.soft_label||c.soft||'—'} —— 故不定名`);
    }
    else if(fp.evidence==='hard-hint')bits.push('硬筛选给出唯一解，但软判据未确认，仅作旁证');
    if(fp.cache_rates?.applied)bits.push(`缓存费率补自 OpenRouter 公开价目（${fp.cache_rates.applied} 条），非 Arena 官方口径`);
    bits.push('汇总成本可能包含多次调用，单次调用口径未验证');
    return bits.join(' · ');
  }  async function loadPrefs(){const items=await storageGet([PREFS_KEY,LEGACY_PREFS_KEY]);prefs=sanitizePrefs(items[PREFS_KEY]||items[LEGACY_PREFS_KEY]);}
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
    syncHudSession();
    const id=session(),record=id?records.get(id)||null:null;
    return {
      running:running||draw.running,
      phase:running?phase:(draw.running?draw.phase:(record?.phase||phase)),
      progress:running?progress:(draw.note||record?.progress||progress),
      sessionId:id,
      samples:record?.samples.length||0,
      continueClicks:record?.continueClicks||0,
      result:record?.result||null,
      recognition:record?.recognition||null,
      check:record?.lastCheck||null,
      trace:globalThis.__ampTrace||null,
      draw:{running:draw.running,phase:draw.phase,note:draw.note,round:draw.round,total:draw.total,completed:draw.completed,failed:draw.failed,renamed:draw.renamed,results:draw.results.slice(0,10)},
      prefs:{...prefs},
      balance:balanceInfo,balanceError,balanceLoading,
      /* v2.13.2 花费账本摘要（给弹窗用，行数截断保持轻量）。 */
      ledger:ledgerState.data?{
        mode:ledgerState.data.mode||null,
        text:ledgerState.data.text||'',
        token_ratio:ledgerState.data.token_ratio||'',
        note:ledgerState.data.note||'',
        totals:ledgerState.data.totals||null,
        rows:(ledgerState.data.rows||[]).slice(0,12),
        same_price_groups:(ledgerState.data.same_price_groups||[]).filter(group=>group.ambiguous),
      }:null,
      ledgerError:ledgerState.error,ledgerLoading:ledgerState.loading,
      /* v2.19.1：价格指纹面板的数据源 —— 最近一次价格裁决结果（含 hard_filter / evidence / hit）。 */
      price_fingerprint:lastPriceFingerprint,
    };
  }
  function publish(nextPhase,text,record=null){if(record&&session()&&records.get(session())!==record)return;phase=nextPhase;progress=text;if(record){record.phase=nextPhase;record.progress=text;}paint();}
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
  async function run(mode=prefs.mode){if(foldOn)unfoldAll();
    if(running||draw.running)return publicStatus();
    await ensureDebug(true);
    const precise=mode==='precise';
    const priceMode=mode==='price',combinedMode=mode==='combined';
    guard();draw.note='';let active=session(),record=active?records.get(active)||newRecord():newRecord();
    if(active&&!records.has(active))records.set(active,record);
    record.recognition=null;
    const first=planFor(record,precise?'precise':'quick');
    if(!first.length&&!priceMode&&!combinedMode){publish('done','当前聊天三道题都已问过；清除结果或新建聊天后可重新探测',record);return publicStatus();}
    const goal=priceMode?record.samples.length+1:(precise?3:(prefs.autoTopUp?3:record.samples.length+1));
    running=true;cancelled=false;sent=false;targetSession=active;
    if(foldOn)unfoldAll();
    publish('checking',priceMode?'价格指纹模式：发 1 题只取官方账单，在全库模型里按价格裁决（勾选改名时采用最接近候选）':(combinedMode?'组合模式：数字候选按数字拟合 × 价格贴合度联合排序；勾选改名时采用最接近候选':precise?'精准模式：依次问完三道题（3 条回复）':prefs.autoTopUp?'快速模式：随机 1 题；判定不是“清晰匹配”时自动补题加强证据（最多 3 题）':`快速模式：随机发第 ${first[0]+1} 题（1 条回复）`),record);
    try{
      while(record.samples.length<goal){
        const plan=planFor(record,priceMode?'quick':(precise?'precise':'quick'));
        if(!plan.length)break;
        const label=priceMode?'价格指纹 · ':(precise?`精准 ${record.samples.length+1}/3 · `:'快速 · ');
        let step;
        try{step=await captureProbe({record,probeIndex:plan[0],expectedSession:active,label});}
        catch(error){
          // 补题（第 2/3 条）失败时保住已有证据，直接用第一条的结果判定。
          if(precise||priceMode||!record.samples.length||error?.thinkingBlocked||error?.fatal)throw error;
          publish('waiting',`补题失败（${error?.message||'未知原因'}），用已有 ${record.samples.length} 条证据判定`,record);break;
        }
        record=step.record;active=step.sessionId;targetSession=active;
        if(priceMode)break;   // 价格模式只发 1 题，拿完账单即裁决
        if(!precise&&prefs.autoTopUp&&record.result?.status==='clear'){publish('waiting',`判定清晰（${record.result.nearest.display_name}），提前收工：不再补题`,record);break;}
        if(record.samples.length<goal){publish('waiting',`已捕获 ${record.samples.length} 条证据，准备下一题…`,record);await sleep(1200);}
      }
      let textNote='';
      if(active&&!cancelled){try{textNote=await textBankScoreActive(active,'文本通道');}catch{}}
      await finishRecognition(active,record,mode);
      if(textNote)publish('done',`${progress}${textNote}`,record);
    }catch(error){publish(cancelled?'stopped':'error',error?.message||'自动探测失败',record);}
    finally{running=false;sent=false;targetSession=null;paint();}
    return publicStatus();
  }
  function stop(){if(running){cancelled=true;publish('stopping','正在停止；不会再发送下一条');}return publicStatus();}
  function clearCurrent(){if(running||draw.running)return publicStatus();const id=session();if(id)records.delete(id);phase='idle';draw.note='';lastPriceFingerprint=null;progress='当前聊天的内存结果已清除；可重新选择模式并开始识别';paint();return publicStatus();}

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
        if(!ARENA_ORIGIN_RE.test(url.origin)||!isNewChatPath(url.pathname))return false;
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
  /* v2.13.2 花费账本：向后台要一份逐条花费明细。
     候选取自最近一次指纹结果，用于「同价筛选」提示（价格区分不开的模型得靠指纹或人工指定）。 */
  /* v2.13.4：主动探测 Arena 的成本路由。**Agent 模式（/api/chat/<sid>）的会话包不下发
     token 用量**（前端 zod 的 metadata 字段表里就没有 usage），所以 /cost 是唯一可能的金额来源：
       · 200 → 把服务端金额交给后台摊成逐条明细（无需 token）
       · 403 → 记下来，用来解释「为什么这里没有数字」
     只读：GET，带 cookie，不改任何状态。 */
  /* v2.16.0 官方成本通道打通：/cost 的 403 灰度门禁是**服务端读 PostHog flag override cookie**
     `ph-toolbar-overrides`。临时写 {"credit-system-m1":"cost-shown"}（Path=/; Max-Age=60;
     SameSite=Lax; Secure）即可放行 —— 2026-10-12 CDP 实测：无 cookie 403 Unauthorized、
     带 cookie 200 完整账单（逐条 actual/base/charged/credits）。礼貌策略：
       · 用户已有该 cookie 且值不同 → **不覆盖**，本通道待命（让网站自己的设置赢）
       · 值相同 → 直接用，读完不删
       · Absent → 临时写，读完必删并校验，删不掉就不认这份数据
     403 分型：{"error":"Unauthorized"} = 门禁未过；{"error":"User does not own session"} =
     cookie 生效但会话不归当前账号（78B），与门禁未过（24B）是两回事，别混。
     注：content script 在 ISOLATED world，但 cookie jar 按源共享，读写与页面主世界完全一致。 */
  const PH_OVERRIDE_KEY='ph-toolbar-overrides';
  /* 注意：这里必须是**字符串**。曾经写成 JSON.parse(decodeURIComponent(编码值))，拿到对象后
     encodeURIComponent 会序列化成 [object Object]（%5Bobject%20Object%5D）—— cookie 值是坏的，
     服务端解析不出 override，门永远不放行。单测（tests/official-cost.test.mjs）盯这个形态。 */
  const PH_COST_SHOWN=JSON.stringify({'credit-system-m1':'cost-shown'});
  const readPhOverride=()=>{
    try{
      const raw=document.cookie.split(';').map(part=>part.trim()).find(part=>part.startsWith(PH_OVERRIDE_KEY+'='));
      return raw?decodeURIComponent(raw.slice(PH_OVERRIDE_KEY.length+1)):null;
    }catch{return null;}
  };
  const writePhOverride=value=>{
    try{document.cookie=PH_OVERRIDE_KEY+'='+encodeURIComponent(value)+'; Path=/; Max-Age=60; SameSite=Lax; Secure';return true;}
    catch{return false;}
  };
  const clearPhOverride=()=>{
    try{document.cookie=PH_OVERRIDE_KEY+'=; Path=/; Max-Age=0; SameSite=Lax; Secure';
      return readPhOverride()===null;}
    catch{return false;}
  };
  /* 带 cookie 门禁的 /cost 探测。返回 {status, path, payload?, reason?}；
     payload 只在 200 时带给后台摊明细。
     reason 语义：'bad-json' 响应 200 但不可解析；'cookie-stuck' 临时 cookie 删不掉
     （数据可能已不可信 —— 调用方必须按无数据处理，绝不上送）；网络类同理。 */
  async function fetchCostPath(path){
    const existing=readPhOverride();
    let temporary=false;
    if(existing===null){
      if(!writePhOverride(PH_COST_SHOWN))return {status:0,path,reason:'cookie-write-failed'};
      temporary=true;
    }else if(existing!==PH_COST_SHOWN){
      return {status:403,path,reason:'user-override-exists'};
    }
    let result;
    try{
      const response=await fetch(path,{credentials:'include'});
      if(response.ok){
        const payload=await response.json().catch(()=>null);
        result=payload&&typeof payload==='object'
          ?{status:200,path,payload}
          :{status:response.status,path,reason:'bad-json'};
      }else if(response.status===403){
        /* 分型：门禁未过 vs 会话不归当前账号（读 body，两种错误字节数不同）。 */
        const body=await response.text().catch(()=>'');
        result={status:403,path,reason:/does not own session/i.test(body)?'not-owner':'unauthorized'};
      }else result={status:response.status,path};
    }catch{result={status:0,path,reason:'network'};}
    /* 清理失败：这份数据不可信 —— 标进 reason，调用方按无数据处理（注释不办事，标记才办事）。 */
    if(temporary&&!clearPhOverride()&&result.status===200)result.reason='cookie-stuck';
    return result;
  }
  async function probeCostRoute(id){
    if(!id)return null;
    const paths=battleMode()
      ?[`/api/evaluation/${id}/cost`]
      :[`/api/chat/${id}/cost?includeSession=true`,`/api/evaluation/${id}/cost`];
    for(const path of paths){
      const probe=await fetchCostPath(path);
      if(probe.status===200&&!probe.reason)return probe;               // 完整账单才收
      if(probe.status===403)return probe;                               // 门禁/归属已定，换路径也一样
      if(probe.status===404||probe.reason==='bad-json')continue;        // 路径不对/响应不可解析，换下一个
      return probe;                                                     // network / cookie-stuck：换路径也没用
    }
    return null;
  }
  async function refreshLedger(){
    syncHudSession();
    if(ledgerState.loading)return;
    const id=session(),epoch=hudEpoch,requestId=++ledgerState.requestId;
    const isCurrent=()=>{syncHudSession();return epoch===hudEpoch&&requestId===ledgerState.requestId&&id===session();};
    if(!id){ledgerState.at=Date.now();return;}
    ledgerState.loading=true;paint();
    try{
      const record=records.get(id)||null,result=record?.result||null;
      const candidates=[result?.nearest?.id,...((result?.top3)||[]).map(item=>item?.id)].filter(item=>typeof item==='string');
      const decision=result?.signals?.decision||null;
      const model=result?.status==='clear'&&Number(decision?.set_size)===1&&result?.nearest?.id?String(result.nearest.id):null;
      const probe=await probeCostRoute(id);
      if(!isCurrent())return;
      ledgerState.costProbe=probe?{status:probe.status,path:probe.path,reason:probe.reason||null}:null;
      if(probe?.status!==200||probe.reason||!probe.payload){
        ledgerState.data=null;ledgerState.error=ledgerBlockedReason();return;
      }
      if(!Object.keys(probe.payload.messages||{}).length){
        ledgerState.data={mode:'official',text:'本会话暂无逐条账单',rows:[],totals:null};ledgerState.error='';return;
      }
      try{
        void chrome.runtime.sendMessage({type:'AMP_COST_PAYLOAD',route:'cost-api',path:probe.path,
          session:probe.payload.session&&typeof probe.payload.session==='object'?probe.payload.session:null,
          messages:probe.payload.messages,at:Date.now()}).catch(()=>{});
      }catch{}
      const response=await chrome.runtime.sendMessage({type:'AMP_LEDGER',candidates,model,costPayload:probe.payload});
      if(!isCurrent())return;
      if(response?.error)ledgerState.error=response.error;
      else{ledgerState.data=response||null;ledgerState.error='';ledgerState.at=Date.now();}
    }catch(error){if(isCurrent())ledgerState.error=error?.message||'未知原因';}
    finally{if(isCurrent()){ledgerState.loading=false;ledgerState.at=Date.now();paint();}}
  }
  /* 金额显示，与 cost-ledger.formatUsd 同口径（浮层不引模块，保持轻量）。 */
  const ledgerUsd=value=>{
    const number=Number(value);
    if(!Number.isFinite(number))return '—';
    if(number===0)return '$0';
    if(Math.abs(number)<0.0001)return `$${number.toExponential(2)}`;
    return number<1?`$${Number(number.toFixed(6))}`:`$${Number(number.toFixed(4))}`;
  };
  /* ---------- v2.19.1 Tab 布局与价格指纹面板 ---------- */
  let activeTab='price';
  const COST_TAB_KEY='amp.hud.tab.v1';
  /* persist=false：createHud() 初次点亮默认页签时用 —— 别把默认值写进存储，
     否则 loadLocalState() 的「恢复上次页签」就永远读到的是它自己写的默认值。 */
  function selectTab(key,persist=true){
    if(key==='numeric')key='price';
    if(!tabs[key])return;
    activeTab=key;
    for(const [name,button] of Object.entries(tabs))button.classList.toggle('active',name===key);
    for(const [name,panel] of Object.entries(panels))panel.classList.toggle('active',name===key);
    if(persist){try{void chrome.storage.local.set({[COST_TAB_KEY]:key});}catch{}}
    paint();
  }
  /* 页签上的「有新结果」小圆点：数字 / 价格 / 花费各自有无数据。 */
  function updateTabDots(state){
    const price=state?.price_fingerprint||ledgerState.data?.cost_reverse||null;
    const dots={
      numeric:!!(state?.result||state?.samples),
      price:!!(price||state?.result||state?.samples),
      cost:!!ledgerState.data,
    };
    for(const [key,button] of Object.entries(tabs)){
      const dot=button.querySelector('.dot');
      if(dot)dot.classList.toggle('on',!!dots[key]);
    }
  }
  /* ---------- v2.19.2 浮层拖动 ----------
     交互约定（对齐参考插件的「拖标题栏」）：按住 .head 拖动整个浮层；
     从右下角默认停靠切成 left/top 绝对定位后记入 storage，重开仍在原处。
     边界：始终至少留 40px 在视口内，避免拖出屏幕后找不回来。 */
  function applyHudPos(){
    if(!host)return;
    if(!pos){host.style.left='';host.style.top='';host.style.right='16px';host.style.bottom='16px';return;}
    const width=host.offsetWidth||340,height=host.offsetHeight||400;
    const maxLeft=Math.max(0,window.innerWidth-width-4),maxTop=Math.max(0,window.innerHeight-height-4);
    const left=Math.min(Math.max(-width+40,pos.left),Math.max(40,maxLeft));
    const top=Math.min(Math.max(0,pos.top),Math.max(40,maxTop));
    host.style.right='auto';host.style.bottom='auto';host.style.left=`${left}px`;host.style.top=`${top}px`;
  }
  function saveHudPos(next){
    pos=next;applyHudPos();
    try{void chrome.storage.local.set({[POS_KEY]:next});}catch{}
  }
  function installDrag(node){
    if(!node||node.__ampDrag)return;node.__ampDrag=true;
    node.addEventListener('pointerdown',(event)=>{
      if(event.button!==0||event.target?.closest('button'))return;
      /* 拖拽起点用 host 当前视口矩形，避免 host 还没定位时算错。 */
      const rect=host.getBoundingClientRect();
      dragState={id:event.pointerId,dx:event.clientX-rect.left,dy:event.clientY-rect.top,x0:event.clientX,y0:event.clientY,moved:false};
      try{node.setPointerCapture(event.pointerId);}catch{}
      event.preventDefault();
    });
    node.addEventListener('pointermove',(event)=>{
      if(!dragState||dragState.id!==event.pointerId)return;
      /* 死区 3px：单纯点击标题栏（比如点「—」收起）不该被当成拖动。 */
      if(!dragState.moved&&Math.abs(event.clientX-dragState.x0)<3&&Math.abs(event.clientY-dragState.y0)<3)return;
      dragState.moved=true;
      pos={left:Math.round(event.clientX-dragState.dx),top:Math.round(event.clientY-dragState.dy)};
      applyHudPos();
    });
    const finish=(event)=>{
      if(!dragState||dragState.id!==event.pointerId)return;
      const moved=dragState.moved;dragState=null;
      try{node.releasePointerCapture(event.pointerId);}catch{}
      if(moved&&pos)saveHudPos(pos);
    };
    node.addEventListener('pointerup',finish);
    node.addEventListener('pointercancel',finish);
  }
  /* 四项分项 → 表格一行；缺项记 '—'（与 0 区分）。 */
  const costCell=(value)=>{
    if(value===null||value===undefined)return '—';
    const number=Number(value);
    if(!Number.isFinite(number))return '—';
    if(number===0)return '$0';
    if(Math.abs(number)<0.0001)return `$${number.toExponential(2)}`;
    return number<1?`$${number.toFixed(6)}`:`$${number.toFixed(4)}`;
  };
  function renderCostTable(){
    if(!costTableBody)return;
    costTableBody.textContent='';costTableFoot.textContent='';
    const rows=Array.isArray(ledgerState.data?.rows)?ledgerState.data.rows:[];
    /* 只展示带四项分项的官方行（没有分项的老口径行不进这张表）。 */
    const withBreakdown=rows.filter(row=>row&&row.breakdown);
    if(!withBreakdown.length){
      costTableWrap.hidden=false;costTableEmpty.hidden=false;
      if(costTableEl)costTableEl.hidden=true;
      return;
    }
    costTableEmpty.hidden=true;
    if(costTableEl)costTableEl.hidden=false;
    const sum={input_usd:0,output_usd:0,cache_write_usd:0,cache_read_usd:0,total:0};
    let hasTotal=false;
    for(const row of withBreakdown){
      const b=row.breakdown;
      const lineTotal=['input_usd','output_usd','cache_write_usd','cache_read_usd']
        .reduce((acc,key)=>acc+(Number.isFinite(Number(b[key]))?Number(b[key]):0),0);
      const tr=el('tr');
      tr.append(el('td','c-name',`#${row.index}`));
      for(const key of ['input_usd','output_usd','cache_write_usd','cache_read_usd']){
        const value=b[key];
        const text=costCell(value);
        tr.append(el('td',value===0?'c-zero':(value==null?'c-zero':'c-usd'),text));
        if(Number.isFinite(Number(value)))sum[key]+=Number(value);
      }
      /* v2.19.8：「合计」列此前优先取 `row.base_usd`（**Arena 基础价**），跟左边四列
         （**上游 actual 分项费用**）不是同一口径 —— 实测出现「合计 $0.005981 却远小于四项之和 $0.073684」，
         一列叫「合计」却不等于同排四项之和，本身就是错的。改成四项之和；
         base / 实扣在「花费」页签的账本里另有逐条展示，不在这张表里混口径。 */
      const totalText=costCell(lineTotal);
      tr.append(el('td','c-usd',totalText));
      costTableBody.append(tr);
      sum.total+=lineTotal;
      hasTotal=true;
    }
    if(hasTotal){
      const foot=el('tr');
      foot.append(el('td','c-name','合计'));
      for(const key of ['input_usd','output_usd','cache_write_usd','cache_read_usd'])foot.append(el('td','c-usd',costCell(sum[key])));
      foot.append(el('td','c-usd',costCell(sum.total)));
      costTableFoot.append(foot);
    }
  }
  /* 价格指纹结果卡：显示裁决结果 + 依据 + 披露（数字通道结论也一并展示，两者不互相顶替）。 */
  function renderPricePanel(state){
    if(!fpCard)return;
    const fp=state?.price_fingerprint||null;
    const cr=ledgerState.data?.cost_reverse||null;
    if(!fp&&!cr){
      fpName.textContent='尚未识别';fpName.dataset.tone='muted';
      fpBadge.textContent='待运行';fpBadge.dataset.tone='muted';
      fpCard.dataset.level='none';
      fpLine.textContent='下拉选择价格指纹、数字指纹或组合后点「开始识别」；勾选改名时使用最接近候选（不代表确定识别）。';
      fpMeta.textContent='';fpCaveat.textContent='';fpCands.hidden=true;
      renderCostTable();
      return;
    }
    const view=fp||cr;
    const separable=view.separable===true&&!!view.hit;
    /* v2.19.7：定不了名但有**费率族**时，标题直接报族（如「Claude Haiku 5.5 / GPT Luna」），
       别只写「未唯一定名」—— 用户要的是能用的结论。费率族 = 费率完全相同的模型集合，
       单凭账单永远切不开，只能报到这一级。 */
    const fam=view.rate_family||null;
    const famNames=fam?fam.models.map(m=>m.display||m.model_key):[];
    const name=separable?(view.hit?.label||view.hit?.model_key||'—')
      :view.suggestion?`${view.suggestion.label}（最接近候选）`:fam?(famNames.slice(0,2).join(' / ')+(famNames.length>2?` 等 ${famNames.length} 个`:''))
      :'未唯一定名';
    fpName.textContent=name;
    fpName.dataset.tone=separable?'ok':'warn';
    const evLabel=view.evidence_label||'';
    fpBadge.textContent=separable?(evLabel||'唯一定名'):(view.suggestion?'候选排序':view.reason==='conflict'?'证据分歧':(fam?'费率族':'不能定名'));
    fpBadge.dataset.tone=separable?'ok':(view.reason==='conflict'?'warn':(fam?'warn':'muted'));
    fpCard.dataset.level=separable?'ok':(view.reason==='conflict'?'conflict':(fam?'conflict':'none'));
    fpLine.textContent=view.text||view.note||'';
    /* 依据：范围 / 命中比值 / 硬筛选统计 */
    const metaBits=[];
    if(view.scope)metaBits.push(`范围 ${view.arena_only?'Arena 官方模型池':view.scope==='full-bank'?'全库':'候选集'}`);
    if(separable&&view.hit)metaBits.push(`比值 ${view.hit.ratio} · 隐含 $${view.implied_usd_per_mtok??'—'}/Mtok · ${view.n_pairs||0} 对配对`);
    if(view.hard_filter)metaBits.push(`硬筛选 ${view.hard_filter.checked_models||0} 个模型里 ${view.hard_filter.state==='unique'?1:(view.hard_filter.candidates?.length||0)} 个能整除`);
    fpMeta.textContent=metaBits.join(' · ');
    fpCaveat.textContent=priceFingerprintCaveat(view);
    renderPriceCandidates(view,separable);
    renderCostTable();
  }
  /* 未唯一定名时列出候选（v2.19.3）。
     动机：只报「不能定名」用户看不到任何线索 —— 对手插件会把并列候选摆出来并标来源。
     候选来源优先级：硬筛选能整除的（最硬）> 软判据 top 名单 > 同价等价类。
     每行标「官方榜单 / 公开补充」与「:batch」等口径提示，避免把并列候选误读成已确认型号。 */
  function renderPriceCandidates(view,separable){
    if(!fpCands)return;
    const rows=[];
    if(separable){fpCands.hidden=true;fpCandsList.textContent='';return;}
    const hard=view?.hard_filter;
    const list=Array.isArray(hard?.candidates)?hard.candidates:[];
    if(list.length){
      rows.push(['整数整除',`硬筛选：${hard.checked_models||0} 个模型里 ${list.length} 个能整除这份账单`]);
      for(const c of list){
        const bits=[];
        const counts=c.counts||{};
        bits.push(`O=${counts.O??'—'} R=${counts.R??'—'}`);
        if(c.cache_rate_source)bits.push(`缓存费率 ${String(c.cache_rate_source).replace('openrouter-public','OpenRouter 公开')}`);
        if(c.cache_rate_batch)bits.push('⚠️ :batch 半价');
        rows.push([c.display||c.model_key,bits.join(' · ')]);
      }
    }
    const hit=view?.hit,runner=view?.runner_up;
    if(hit||runner){
      const soft=[];
      if(hit)soft.push([hit.label||hit.model_key,`软判据最贴近 · 比值 ${hit.ratio}${hit.implied_usd_per_mtok?` · 隐含 $${hit.implied_usd_per_mtok}/Mtok`:''}`]);
      if(runner)soft.push([runner.label||runner.model_key,`第二名 · 比值 ${runner.ratio}`]);
      rows.push(['log 比值',runner?'比值拉不开距离（两条腿都没切开）':'仅一条腿成立']);
      rows.push(...soft);
    }
    for(const group of (view?.same_price_groups||[]).filter(g=>g.ambiguous).slice(0,3)){
      const cw=group.cache_write_usd_per_mtok==null?'—':`$${group.cache_write_usd_per_mtok}`;
      const cr2=group.cache_read_usd_per_mtok==null?'—':`$${group.cache_read_usd_per_mtok}`;
      rows.push([group.ids.join(' / '),`四项价格完全相同（in $${group.input_usd_per_mtok} / out $${group.output_usd_per_mtok} / w ${cw} / r ${cr2}）—— 单价区分不开`]);
    }
    const partial=Number(hard?.partial||0);
    if(partial)rows.push(['费率不全',`${partial} 个变体缺计价字段（多为 cache 读），尚不能排除`]);
    if(!rows.length){fpCands.hidden=true;fpCandsList.textContent='';return;}
    const frag=document.createDocumentFragment();
    for(const [label,meta] of rows){
      const isSep=label==='整数整除'||label==='log 比值'||label==='费率不全';
      const row=el('div','fp-cand');
      row.append(el('b',isSep?'fp-cand-sep':'fp-cand-name',String(label)));
      row.append(el('span','fp-cand-meta',String(meta)));
      frag.append(row);
    }
    fpCandsList.textContent='';fpCandsList.append(frag);
    fpCands.hidden=false;
  }
  function renderLedger(){
    if(!ledgerBox)return;
    ledgerToggle.textContent=ledgerState.expanded?'明细 ▾':'明细 ▸';
    ledgerTable.hidden=!ledgerState.expanded;
    if(ledgerState.error){ledgerSummary.textContent='读取失败';ledgerNote.textContent=ledgerState.error;ledgerRatio.textContent='';ledgerTable.textContent='';return;}
    const data=ledgerState.data;
    if(!data){ledgerSummary.textContent=ledgerState.loading?'读取中…':'尚未读取（点「刷新」）';ledgerRatio.textContent='';ledgerTable.textContent='';return;}
    ledgerSummary.textContent=data.text||'—';
    ledgerRatio.textContent=data.token_ratio||'';
    const rows=Array.isArray(data.rows)?data.rows:[];
    const frag=document.createDocumentFragment();
    if(!rows.length){
      frag.append(el('div','ledger-empty',data.mode==='blocked'
        ?'没有可用的花费数据 —— 原因见下方说明'
        :'还没有逐条用量记录 —— 在页面上真实发一条消息后再点「刷新」'));
    }else{
      for(const row of rows){
        const line=el('div','ledger-row'),head=el('div','ledger-row-head');
        /* v2.16.0：/cost 官方行没有模型名（服务端不下发），但金额是权威值 ——
           标「官方计费」而不是「模型未揭晓」，别让人误以为缺数据。 */
        const official=String(row.source||'').startsWith('cost-route');
        head.append(el('b',null,`#${row.index}`));
        head.append(el('span',null,String(row.message_id||'—').slice(0,8)));
        head.append(el('span',null,row.model?String(row.model).replace(/-agent$/,''):(official?'官方计费':'模型未揭晓')));
        head.append(el('span',null,official?'服务端口径':`${row.tokens||0}t${row.estimate?'（估算）':''}`));
        head.append(el('span','ledger-usd',ledgerUsd(row.base_usd)));
        line.append(head);
        const sub=[];
        if(row.actual_usd!==null&&row.actual_usd!==undefined&&row.actual_usd!==row.base_usd)sub.push(`上游 ${ledgerUsd(row.actual_usd)}`);
        if(row.charged_usd!==null&&row.charged_usd!==undefined){
          sub.push(`实扣 ${ledgerUsd(row.charged_usd)}`);
          if(row.multiplier)sub.push(`×${row.multiplier}`);
          if(row.credits)sub.push(`${Number(row.credits.toFixed(2))} 积分`);
        }
        if(sub.length)line.append(el('div','ledger-row-sub',sub.join(' · ')));
        frag.append(line);
      }
    }
    ledgerTable.textContent='';ledgerTable.append(frag);
    const groups=(data.same_price_groups||[]).filter(group=>group.ambiguous);
    /* v2.16.1 花费反推腿：官方逐条 base ÷ 同消息估算 token（消息 id 对齐，Agent 模式无用量时的
       反推来路）。与 v2.13.3 的「按价反推」（Battle 有服务端用量）互补 —— 两个口径都展示、不互相顶替。 */
    const cr=data.cost_reverse;
    const crText=cr?.text||cr?.note||'';
    const baseNote=groups.length
      ? `同价候选（四项价格完全相同，价格区分不开）：${groups.map(group=>{
          const cw=group.cache_write_usd_per_mtok==null?'—':`$${group.cache_write_usd_per_mtok}`;
          const cr=group.cache_read_usd_per_mtok==null?'—':`$${group.cache_read_usd_per_mtok}`;
          return `${group.ids.join(' / ')}（输入 $${group.input_usd_per_mtok} / 输出 $${group.output_usd_per_mtok} / 缓存写 ${cw} / 缓存读 ${cr} 每 Mtok）`;
        }).join('；')} · 更多费用记录仍无法仅凭单价区分`
      : (data.mode==='blocked'?ledgerBlockedReason():(data.note||'基准价 = Σ token × 公开单价；实扣 = 页面下发的真实成本。'));
    ledgerNote.textContent=crText?`${crText} · ${baseNote}`:baseNote;
  }
  /* v2.13.4：账本空白的**真实原因** —— 别再说「发一条消息后才有」，Agent 模式发多少条都不会有。
     v2.16.0：门禁机制已查明并可绕过 —— 服务端读 PostHog flag override cookie
     `ph-toolbar-overrides`，本扩展现在会临时写 {"credit-system-m1":"cost-shown"} 再读 /cost
     （读完必删）。所以 403 只剩三种：cookie 写失败 / 会话不归当前账号 / 用户已有别的覆写值。 */
  const ledgerBlockedReason=()=>{
    const probe=ledgerState.costProbe;
    if(battleMode())return 'Battle 会话应带逐条 token 用量（GET /api/evaluation/<sid> 的 messages[].metadata.usage）—— 没抓到说明还没结算，发一条消息后再点「刷新」。';
    const gate=probe?.status===403
      ?(probe.reason==='not-owner'
        ?'/api/chat/:id/cost 返回 403 "User does not own session" —— 灰度门已过（cookie 生效），但这个会话不归当前登录账号，换个自己的会话即可'
        :(probe.reason==='user-override-exists'
          ?'浏览器里已有别的 ph-toolbar-overrides 覆写值 —— 按礼貌策略不覆盖它，所以 /cost 仍 403；清掉该 cookie 或先在网站上打开费用显示即可'
          :'/api/chat/:id/cost 返回 403 Unauthorized —— 临时覆写 cookie 没能放行（cookie 被禁或门禁策略变了）'))
      :(probe?`/api/chat/:id/cost 返回 ${probe.status}`:'没能请求到 /api/chat/:id/cost');
    return `Agent 模式：Arena 不下发 token 用量 —— 会话包 messages[].metadata、session 顶层字段、以及实时流（/ai-proxy/realtime/…/out）的 finish / finish-step 事件里都没有 usage。成本走 /cost 路由（临时写 PostHog 覆写 cookie 放行灰度门，读完即删）：${gate}。`;
  };
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
    /* v2.10.0 价格通道自检：成本表是否加载 + 页面有没有下发成本/用量字段（不发消息、不耗额度）。 */
    try{
      const price=await chrome.runtime.sendMessage({type:'AMP_PRICE'});
      if(price?.error)mark('价格通道（Arena 成本表）','读取失败：'+price.error);
      else{
        mark('价格通道（Arena 成本表）',`${price.info?.models||0} 个模型有成本（${price.info?.source||'—'} · 抓取于 ${price.info?.fetched_at||'—'}）`);
        /* v2.13.1：成本字段表已补上 Arena `/cost` 的真实字段名（`basePriceUsd` / `chargedTotalUsd` /
           `costMultiplier` …）。这里直接报「本账号能否读到真实成本」——
           这是唯一决定能否用成本反推模型的开关（字段对不上 = 抓不到；账号没开计费 = 不下发）。 */
        const detail=price.observed_detail;
        if(detail){
          const bits=[];
          if(Number.isFinite(Number(detail.base_usd)))bits.push(`base $${Number(detail.base_usd).toFixed(6)}`);
          if(Number.isFinite(Number(detail.charged_usd)))bits.push(`实扣 $${Number(detail.charged_usd).toFixed(6)}`);
          if(Number.isFinite(Number(detail.multiplier)))bits.push(`×${Number(detail.multiplier).toFixed(4)}`);
          mark('本账号能否读成本（/cost）',`能 —— 已抓到真实按次成本${bits.length?`：${bits.join(' · ')}`:'（字段已抓到）'}`);
        }else{
          /* v2.16.0：/cost 的灰度门可临时覆写 cookie 放行；仍读不到时如实说明三种可能。 */
          const probe=ledgerState.costProbe;
          const why=probe?.status===403
            ?(probe.reason==='not-owner'?'（门已过，但会话不归当前账号）':(probe.reason==='user-override-exists'?'（已有别的覆写 cookie，按礼貌策略不覆盖）':'（临时覆写 cookie 未能放行）'))
            :(probe?`（/cost 返回 ${probe.status}）`:'（未能请求 /cost）');
          mark('本账号能否读成本（/cost）',`不能 —— 页面未下发成本字段${why}`);
        }
        const signals=(price.cost_signals||[]).map(item=>`${item.field}=${item.value}${item.unit==='usd'?'$':''}`).slice(0,3).join(' ');
        mark('页面下发的成本/用量字段',signals?`已抓到 ${signals}`:'未抓到任何成本字段（美元价由前端按 token×单价自算）');
        /* v2.11.0 用量通道：token 用量是 CDP 实测确认已下发的，单独报一行。 */
        const usage=price.usage||{};
        if(usage.latest)mark('页面下发的 token 用量',`${usage.latest.text}${Array.isArray(usage.signatures)&&usage.signatures.length?` · 形态 ${usage.signatures.join('/')}`:''}${usage.total?` · 累计 ${usage.total.text}`:''}`);
        else mark('页面下发的 token 用量',usage.note||'未捕获（发一条消息后 GET /api/evaluation/<sid> 才带）');
      }
    }catch(error){mark('价格通道（Arena 成本表）','探测失败：'+(error?.message||'未知原因'));}
    /* v2.12.0 单价通道自检：token 单价表是否加载 + 指纹库 id 能否对上 Arena 变体 key。 */
    try{
      const pricing=await chrome.runtime.sendMessage({type:'AMP_PRICING',ids:['gpt-6-astra','claude-opus-5-5','claude-sonnet-5','claude-sonnet-5-5']});
      if(pricing?.error)mark('单价通道（token 单价表）','读取失败：'+pricing.error);
      else{
        const info=pricing.info||{};
        mark('单价通道（token 单价表）',`${info.text_models||0} 个文本模型有 token 单价（${info.media_models||0} 个图像/视频模型按张/秒计已排除 · 单位 USD/百万 token · 抓取于 ${info.fetched_at||'—'}）`);
        const mapped=(pricing.candidates||[]).map(item=>`${item.id}→${item.priced?`${item.keys.length}档`:'无价'}`).join(' · ');
        mark('指纹库 id → Arena 变体 key',mapped||'未映射');
      }
    }catch(error){mark('单价通道（token 单价表）','探测失败：'+(error?.message||'未知原因'));}
    /* v2.13.2 花费账本自检：逐条消息 base = Σ token × 公开单价；有真实成本时叠加实扣/积分/倍率。 */
    try{
      const costProbe=await probeCostRoute(session());
      const ledger=await chrome.runtime.sendMessage({type:'AMP_LEDGER',limit:60,costPayload:costProbe?.status===200?costProbe.payload:null});
      if(ledger?.error)mark('花费账本（base = Σ token × 公开单价）','读取失败：'+ledger.error);
      else{
        const totals=ledger.totals||{};
        mark('花费账本（base = Σ token × 公开单价）',ledger.text||'暂无数据（发一条消息后才有逐条用量）');
        mark('账本数据来源',ledger.mode==='cost-route'
          ?'Arena /cost 路由（服务端权威金额 · 临时覆写 PostHog cookie 放行灰度门）'
          :ledger.mode==='usage'
            ?`逐条 token 用量 × 公开单价（${ledger.usage_rows||0} 条）`
            :ledger.mode==='estimate'
              ?`Agent 转录字数估算（正文+thinking）× 公开单价（${ledger.estimate_rows||0} 条 · 估算值，非服务端数字）`
              :`没有数据 —— ${costProbe?.status===403?(costProbe.reason==='not-owner'?'/cost 403：门已过但会话不归当前账号':(costProbe.reason==='user-override-exists'?'/cost 403：已有别的 ph-toolbar-overrides，不覆盖':'/cost 403：临时覆写 cookie 未能放行')):costProbe?`/cost 返回 ${costProbe.status}`:'既没有 token 用量、也没有 /cost 金额'}`);
        mark('账本明细行',`已计价 ${totals.priced||0} 条 / 未计价 ${totals.unpriced||0} 条 · 共 ${(ledger.rows||[]).length} 行`);
        if(ledger.token_ratio)mark('token 比例（输出:缓存写:缓存读）',ledger.token_ratio);
        const groups=ledger.same_price_groups||[];
        const ambiguous=groups.filter(group=>group.ambiguous);
        mark('同价候选（价格区分不开）',ambiguous.length?ambiguous.map(group=>`${group.ids.join('/')}（入 $${group.input_usd_per_mtok}/出 $${group.output_usd_per_mtok} 每百万）`).join(' · '):'无');
        /* v2.13.3 按价反推自检：最近一条的 base 成本 × 用量对全库排序；没有真实成本时直说原因。 */
        const rv=ledger.reverse;
        if(rv?.text)mark('按价反推（base 成本 × 用量）',rv.text+((rv.same_price_groups||[]).some(g=>g.ambiguous)?` · 同价不可分：${rv.same_price_groups.filter(g=>g.ambiguous).map(g=>g.ids.join('/')).join('、')}`:''));
        else if(rv?.note)mark('按价反推（base 成本 × 用量）',rv.note);
        /* v2.16.1 花费反推自检：官方逐条 base ÷ 同消息估算 token（消息 id 对齐）对全库排序。
           Agent 会话没有服务端 token 用量，这是「用花费反推模型」的唯一起点。 */
        const cr=ledger.cost_reverse;
        if(cr?.text)mark('花费反推（官方 base ÷ 估算 token）',cr.text+((cr.same_price_groups||[]).some(g=>g.ambiguous)?` · 同价不可分：${cr.same_price_groups.filter(g=>g.ambiguous).map(g=>g.ids.join('/')).join('、')}`:''));
        else if(cr?.note)mark('花费反推（官方 base ÷ 估算 token）',cr.note);
        else if(cr?.error)mark('花费反推（官方 base ÷ 估算 token）','读取失败：'+cr.error);
        if(ledger.note)mark('账本说明',ledger.note);
      }
    }catch(error){mark('花费账本（base = Σ token × 公开单价）','探测失败：'+(error?.message||'未知原因'));}
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
  /* v2.10.0 价格通道：把 Arena 公开的「每模型任务成本」显示出来（详见 Arena价格接口调研.md）。
     网页版不下发每次请求的美元成本，所以默认只展示候选的成本档位；一旦嗅探器抓到现场成本，
     就同时显示成本一致性核对。 */
  const fmtUsd=usd=>{const value=Number(usd);return Number.isFinite(value)&&value>0?`$${value>=1?value.toFixed(2):value.toFixed(3).replace(/0$/,'')}`:'—';};
  const costNoteOf=result=>{
    const price=result?.price;
    if(!price)return '';
    if(price.error)return `成本表不可用（${price.error}）`;
    const parts=[];
    const nearest=price.nearest;
    if(nearest)parts.push(`成本 ${fmtUsd(nearest.cost_p50)}/task（${nearest.tier_label||nearest.tier||'—'}）`);
    const check=price.cross_check;
    if(check)parts.push(`现场成本 ${fmtUsd(check.observed_usd)} · ${check.consistency?.note||'已核对'}${check.agree?' · 与成本排序一致':''}`);
    else if(Number.isFinite(Number(price.observed_usd)))parts.push(`现场成本 ${fmtUsd(price.observed_usd)}`);
    return parts.join(' · ');
  };
  /* v2.11.0 用量通道：显示 Arena 实测下发的 token 用量与形态签名（只报 token，不折算美元）。
     形态签名 cw=缓存写入 / cr=缓存读取 / rz=推理 token —— 这三者是厂商与模型类别的强旁证。 */
  const usageNoteOf=usage=>{
    if(!usage||!usage.signals)return '';
    const latest=usage.latest;
    if(!latest)return ` · 用量:${usage.signals}条`;
    const sig=Array.isArray(usage.signatures)&&usage.signatures.length?`[${usage.signatures.join('/')}]`:'';
    return ` · 用量:${latest.text}${sig}`;
  };
  /* v2.12.0 单价通道：Arena 公开每个模型的 token 单价（USD/百万 token），
     于是「按价格反推」有了可算的一半——候选的期望成本。这里只报区分度：
     价格能把这些候选切开，才谈得上用成本定模型；切不开就直说切不开。 */
  const pricingNoteOf=result=>{
    const pricing=result?.pricing;
    if(!pricing)return '';
    if(pricing.error)return `单价表不可用（${pricing.error}）`;
    /* v2.13.0 每条消息的期望成本：本条 token 用量 × 识别模型单价（Arena 不下发美元，按公开单价估算）。 */
    const mc=pricing.message_cost;
    const costLine=mc?` · 本条 ≈ ${fmtUsd(mc.min_usd)}${mc.max_usd>mc.min_usd?`~${fmtUsd(mc.max_usd)}`:''}${mc.complete?'':'（下界）'}`:'';
    /* v2.13.1：本账号能读到真实成本时，直接显示 `base / 实扣 / ×倍率`。
       base 才是与公开单价同口径的那一半，实扣 = base × Arena 的加价倍率（实测 ×2）。 */
    const realLine=pricing.observed_text?` · 真实成本 ${pricing.observed_text}`:'';
    /* v2.13.3 按价反推通道：base 成本 × 本次用量对全库排序；同价等价类之间价格区分不开。 */
    const rv=pricing.reverse;
    const reverseLine=rv?.text?` · ${rv.text}${Array.isArray(rv.same_price_groups)&&rv.same_price_groups.some(g=>g.ambiguous)?`（同价不可分：${rv.same_price_groups.filter(g=>g.ambiguous).map(g=>g.ids.join('/')).join('、')}）`:''}`:'';
    /* v2.17.0 价格指纹：候选集内价格能否唯一切开（唯一命中 + 比值贴合 + 无同价歧义）。
       开启「价格指纹」开关后，separable 为真即可单独定名。 */
    const pf=pricing.price_fingerprint;
    const fpLine=pf?.text?` · ${pf.text}`:'';
    const d=pricing.discrimination;
    if(!d)return (pricing.usage_source?costLine:` · 单价:等待 token 用量${costLine}`)+realLine+reverseLine+fpLine;
    const verdict=d.separable?'价格可区分':'价格不可区分';
    return ` · 单价区分度 ${d.span}×（${verdict}：${d.min.label} ${fmtUsd(d.min.min_usd)} ~ ${d.max.label} ${fmtUsd(d.max.max_usd)}）${costLine}${realLine}${reverseLine}${fpLine}`;
  };
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
    /* 价格指纹模式：探针仍要发一道（账单与估算 token 都来自模型真实回复），
       但只用它换数据，不靠它定名；所以按「快速」发 1 题，且不自动补题。 */
    const priceMode=prefs.mode==='price';
    const plan=planProbes(mode,[],cryptoRandom);
    let active=await mathWarmup(index);
    let record=newRecord(),lastResult=null;
    if(active)records.set(active,record);
    for(const [order,probeIndex] of plan.entries()){
      const label=`第 ${index} 轮 · ${priceMode?'价格指纹 · ':(mode==='precise'?`精准 ${order+1}/${plan.length} · `:'快速 · ')}`;
      const step=await captureProbe({record,probeIndex,expectedSession:active,label});
      record=step.record;active=step.sessionId;targetSession=active;lastResult=record.result;
      if(order+1<plan.length)await sleep(1200);
    }
    if(prefs.autoTopUp&&mode==='quick'&&!priceMode){
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
    const sceneNote=prefs.mode!=='price'&&lastResult?await sceneChannelFor(index,active,lastResult.nearest.display_name):'';
    const summary=await finishRecognition(active,record,prefs.mode,index);
    summary.renameNote+=sceneNote+textNote;
    return summary;
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
    if(foldOn)unfoldAll();
    let consecutive=0,halted=false;
    publishDraw('checking',`准备连续抽卡：共 ${count} 轮 · ${MODE_LABEL[prefs.mode]||MODE_LABEL.quick} · 每轮先发随机数学题过人机验证${prefs.autoTopUp&&prefs.mode==='quick'?' · 判定不清自动补题':''}${prefs.blockThinking?' · 拦截 thinking':''}${prefs.renameAnyway?' · 按最接近候选改名（非确定识别）':' · 未勾选改名，只识别'}${prefs.minPulse>0?` · 额度低于 ${prefs.minPulse}% 自动停止`:''}`);
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
  const FOLD_KEEP=3;let foldOn=false,foldApplied=new Map(),foldRoot=null,foldTimer=null,foldFeedback='',lastResultsSignature='';const toolButtons=[];
  const MESSAGE_SELECTOR='[data-message-id],[data-message-author-role],[data-message-role],[data-role="user"],[data-role="assistant"],[data-testid="user-message"],[data-testid="assistant-message"],[data-testid="chat-message"],[data-testid="message"]';
  const MESSAGE_BODY_SELECTOR='.prose,[class*="markdown"],[data-streamdown],.whitespace-pre-wrap';
  function foldProtected(node){
    return !node||node===host||node.contains(host)||!!node.closest('aside,nav,header,footer,textarea,[contenteditable="true"],[role="textbox"]')||!!node.querySelector('textarea,[contenteditable="true"],[role="textbox"],nav,aside');
  }
  function foldEligible(node){
    return !!node?.isConnected&&!foldProtected(node)&&(foldApplied.has(node)||node.dataset.ampFold==='1'||visible(node));
  }
  function transcriptRoot(){
    if(foldRoot?.isConnected&&visible(foldRoot))return foldRoot;
    for(const selector of ['[role="log"]','[data-testid="chat-messages"]','[data-testid="message-list"]','[data-chat-messages]','main']){
      const found=[...document.querySelectorAll(selector)].find(node=>visible(node)&&node!==host&&!node.closest('aside,nav'));
      if(found){foldRoot=found;return found;}
    }
    return null;
  }
  function messageRoots(){
    const root=transcriptRoot();
    if(!root)return [];
    const marked=[...root.querySelectorAll(MESSAGE_SELECTOR)].filter(foldEligible);
    if(marked.length){
      const selected=new Set(marked);
      return marked.filter(node=>{for(let parent=node.parentElement;parent&&parent!==root;parent=parent.parentElement){if(selected.has(parent))return false;}return true;});
    }
    /* 无消息标记时，只选择带正文的重复容器；不把 main 的布局块/输入框当消息。 */
    let best=[],bestScore=0;
    const queue=[{node:root,depth:0}];
    for(let i=0;i<queue.length&&i<240;i++){
      const {node,depth}=queue[i];
      if(node!==root&&node.closest(MESSAGE_BODY_SELECTOR))continue;
      const containers=[...node.children].filter(child=>/^(DIV|SECTION|ARTICLE)$/.test(child.tagName)&&child.isConnected&&child!==host&&!child.closest('aside,nav,header,footer,textarea,[contenteditable="true"],[role="textbox"]')&&(foldApplied.has(child)||visible(child)));
      const children=containers.filter(child=>foldEligible(child)&&child.textContent.trim());
      if(children.length>1){
        const bodies=children.filter(child=>child.matches(MESSAGE_BODY_SELECTOR)||child.querySelector(MESSAGE_BODY_SELECTOR)).length;
        if(bodies||node.getAttribute('role')==='log'||children.every(child=>child.tagName==='ARTICLE')){
          const score=children.length*4+bodies*8-depth;
          if(score>bestScore){bestScore=score;best=children;}
        }
      }
      if(depth<12)for(const child of containers){if(!foldApplied.has(child))queue.push({node:child,depth:depth+1});}
    }
    return best;
  }
  function chatScroller(start=null){
    let node=start||messageRoots()[0]?.parentElement||transcriptRoot();
    for(let hop=0;hop<16&&node;hop+=1){
      const style=getComputedStyle(node);
      if(node.scrollHeight>node.clientHeight+4&&/(auto|scroll|overlay)/.test(style.overflowY))return node;
      node=node.parentElement;
    }
    return document.scrollingElement||transcriptRoot();
  }
  function jumpBottom(){
    const scroller=chatScroller();
    if(scroller){try{scroller.scrollTo({top:scroller.scrollHeight,behavior:'smooth'})}catch{scroller.scrollTop=scroller.scrollHeight}return;}
    try{window.scrollTo({top:document.body.scrollHeight,behavior:'smooth'})}catch{window.scrollTo(0,document.body.scrollHeight)}
  }
  function restoreFoldNode(node,saved){
    if(saved?.display)node.style.setProperty('display',saved.display,saved.priority||'');else node.style.removeProperty('display');
    delete node.dataset.ampFold;foldApplied.delete(node);
  }
  function updateFoldButtons(){
    const count=[...foldApplied.keys()].filter(node=>node.isConnected).length;
    const title=!foldOn?'折叠旧消息：保留最近 3 条，不删除内容':running||draw.running?'识别/抽卡期间自动展开，结束后恢复折叠':count?`已折叠 ${count} 条旧消息，保留最近 3 条；点击全部展开`:(foldFeedback||'暂无可折叠的旧消息');
    const label=foldOn?`»${count}`:'«';
    for(const {fold} of toolButtons){if(fold.textContent!==label)fold.textContent=label;fold.title=title;fold.setAttribute('aria-label',title);fold.setAttribute('aria-pressed',String(foldOn));fold.style.width=foldOn?'auto':'';}
  }
  function applyFold(){
    if(!foldOn||running||draw.running){updateFoldButtons();return;}
    const roots=messageRoots();
    const targets=new Set(roots.slice(0,Math.max(0,roots.length-FOLD_KEEP)));
    const scroller=roots.length?chatScroller(roots[0].parentElement):null;
    const oldTop=scroller?.scrollTop||0,oldHeight=scroller?.scrollHeight||0;
    const atBottom=scroller?oldHeight-scroller.clientHeight-oldTop<80:false;
    let changed=false;
    for(const [node,saved] of foldApplied){if(!node.isConnected||!targets.has(node)){restoreFoldNode(node,saved);changed=true;}}
    for(const node of targets){
      if(foldApplied.has(node))continue;
      foldApplied.set(node,{display:node.style.getPropertyValue('display'),priority:node.style.getPropertyPriority('display')});
      node.dataset.ampFold='1';node.style.setProperty('display','none','important');changed=true;
    }
    if(changed&&scroller)scroller.scrollTop=atBottom?scroller.scrollHeight:Math.max(0,oldTop-(oldHeight-scroller.scrollHeight));
    foldFeedback=roots.length?`只有 ${roots.length} 条消息，保留最近 ${FOLD_KEEP} 条，暂不需要折叠`:'未找到安全的消息容器，暂未折叠（不会隐藏输入框）';
    updateFoldButtons();
  }
  function unfoldAll(){
    if(foldTimer!==null){clearTimeout(foldTimer);foldTimer=null;}
    for(const [node,saved] of foldApplied)restoreFoldNode(node,saved);
    for(const node of document.querySelectorAll('[data-amp-fold]')){node.style.removeProperty('display');delete node.dataset.ampFold;}
    foldRoot=null;foldFeedback='已展开全部消息';updateFoldButtons();
  }
  function scheduleFold(){
    if(!foldOn||running||draw.running||foldTimer!==null)return;
    foldTimer=setTimeout(()=>{foldTimer=null;if(foldOn&&!running&&!draw.running){applyFold();paint();}},250);
  }
  function toggleFold(){foldOn=!foldOn;if(foldOn)applyFold();else unfoldAll();paint();}
  function makeTools(){
    const bottom=el('button','mini','↓');bottom.title='一键回到底部';bottom.addEventListener('click',jumpBottom);
    const fold=el('button','mini','«');fold.title='折叠旧消息：保留最近 3 条，不删除内容';fold.addEventListener('click',toggleFold);
    toolButtons.push({bottom,fold});return [bottom,fold];
  }  function createHud(){
    document.getElementById(HOST_ID)?.remove();host=el('div');host.id=HOST_ID;host.style.cssText='position:fixed;right:16px;bottom:16px;z-index:2147483647';root=host.attachShadow({mode:'closed'});
    const style=el('style');style.textContent=`:host{all:initial}.box{box-sizing:border-box;width:340px;max-width:calc(100vw - 24px);max-height:min(84vh,760px);display:flex;flex-direction:column;border:1px solid #3d5e51;border-radius:14px;background:#101a20;color:#e7f1ed;box-shadow:0 16px 50px #0008;font:12px/1.5 system-ui,sans-serif;overflow:hidden}.box *{box-sizing:border-box}[hidden]{display:none!important}.head{flex:none;display:flex;align-items:center;gap:8px;padding:11px 12px;border-bottom:1px solid #2a3d40;background:#142329;cursor:move;user-select:none;touch-action:none}
.head button,.head .title{cursor:pointer}
.head .title{cursor:move}.mark{display:grid;place-items:center;width:23px;height:23px;border:1px solid #56816d;border-radius:7px;background:#224639;color:#bdf0d4;font:700 12px ui-monospace,monospace}.title{flex:1}.title b,.title small{display:block}.title b{font-size:11px}.title small{font-size:8px;color:#84a39c;letter-spacing:.8px}.collapse{width:25px;height:25px;padding:0}.mini{min-width:24px;height:24px;padding:0 5px;font:11px system-ui;line-height:1}.body{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:11px}.warning{margin:0 0 9px;padding:7px 8px;border-left:2px solid #b48645;background:#251f15;color:#d9c18e;font-size:9px}.controls{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px}.minor{display:flex;gap:6px;margin-top:6px}.minor button{flex:1}button{border:1px solid #466257;border-radius:7px;padding:7px 8px;background:#172823;color:#cfe9dc;font:10px system-ui,sans-serif;cursor:pointer}button:hover:not(:disabled){filter:brightness(1.15)}button:disabled{opacity:.4;cursor:default}.primary{background:#286149;border-color:#559174;color:#f0fff7;font-weight:650}.all{background:#23453a}.stop{color:#efb1ab;border-color:#744b49}.progress{min-height:31px;margin:8px 1px 0;color:#9eb7b0;font-size:9px;line-height:1.55;overflow-wrap:anywhere}.result{margin-top:8px;padding:9px;border:1px solid #416a56;border-radius:9px;background:#173127}.result-top{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}.model{font:650 14px/1.3 ui-monospace,Consolas,monospace;color:#b8efd2;overflow-wrap:anywhere}.badge{white-space:nowrap;border:1px solid #55816b;border-radius:999px;padding:2px 6px;color:#bfead5;font-size:8px}.result[data-level=close]{border-color:#735f39;background:#2a2418}.result[data-level=close] .model{color:#ecd49a}.result[data-level=weak]{border-color:#704946;background:#2d2021}.result[data-level=weak] .model{color:#e9b0aa}.metrics{margin-top:6px;color:#9fb8b1;font:9px/1.55 ui-monospace,Consolas,monospace}.bank{margin-top:4px;color:#748f89;font-size:8px}.draw{margin-top:9px;padding:9px;border:1px solid #35544a;border-radius:9px;background:#12211c}.draw-title{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;font-size:10px;color:#d6ece2;font-weight:650}.draw-grid{display:grid;grid-template-columns:auto 1fr;gap:5px 7px;align-items:center;font-size:9px;color:#9eb7b0}.draw-grid input,.draw-grid select{width:100%;border:1px solid #466257;border-radius:6px;background:#0d1714;color:#dff3e9;padding:4px 6px;font:10px system-ui,sans-serif}.draw-actions{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:7px}.draw-minor{margin-top:6px}.draw-minor button{width:100%}.draw-note{margin:7px 0 0;color:#9eb7b0;font-size:9px;line-height:1.5;overflow-wrap:anywhere}.results{margin-top:6px;display:grid;gap:3px;max-height:108px;overflow:auto}.results div{display:flex;justify-content:space-between;gap:6px;font:9px ui-monospace,Consolas,monospace;color:#a8c3bb}.results b{color:#c8efd9;font-weight:600}.balance{margin-top:8px;padding:7px 8px;border:1px solid #35544a;border-radius:9px;background:#12211c}.balance-row{display:flex;align-items:center;justify-content:space-between;gap:7px;font-size:9px;color:#9eb7b0}.balance-row b{color:#c8efd9;font:600 12px ui-monospace,Consolas,monospace}.balance-note{margin:4px 0 0;color:#7d968f;font-size:8px;line-height:1.5;overflow-wrap:anywhere}.ledger{margin-top:8px;padding:7px 8px;border:1px solid #35544a;border-radius:9px;background:#12211c}.ledger-head{display:flex;align-items:center;gap:6px;font-size:9px;color:#d6ece2}.ledger-head b{font-weight:650}.ledger-sum{flex:1;min-width:0;color:#9eb7b0;font:9px ui-monospace,Consolas,monospace;overflow-wrap:anywhere}.ledger-head button{padding:3px 6px;font-size:8px}.ledger-ratio{margin-top:4px;color:#8fb0a7;font:8px ui-monospace,Consolas,monospace;overflow-wrap:anywhere}.ledger-table{margin-top:5px;display:grid;gap:3px;max-height:150px;overflow:auto}.ledger-row{padding:4px 5px;border:1px solid #2c4a41;border-radius:6px;background:#0f1d19}.ledger-row-head{display:flex;align-items:center;gap:5px;font:9px ui-monospace,Consolas,monospace;color:#a8c3bb}.ledger-row-head b{color:#c8efd9;font-weight:650}.ledger-row-head span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ledger-usd{margin-left:auto;color:#bdf0d4}.ledger-row-sub{margin-top:2px;color:#84a39c;font:8px ui-monospace,Consolas,monospace}.ledger-empty{color:#7d968f;font-size:8px;line-height:1.5}.ledger-note{margin:5px 0 0;color:#7d968f;font-size:8px;line-height:1.5;overflow-wrap:anywhere}.compact{flex:none;display:flex;align-items:center;gap:7px;padding:8px 10px;border-top:1px solid #2a3d40;background:#142329}.compact-text{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#b8e9d1;font:600 11px system-ui}.expand{width:24px;height:24px;padding:0}.byline{margin:8px 1px 0;color:#6d8a83;font-size:8px;text-align:center}`+`
/* v2.19.1 Tab 布局（按用户截图）：顶部页签切换「数字指纹 / 价格指纹 / 花费」三个面板。 */
.tabs{flex:none;display:flex;gap:2px;padding:0 8px;border-bottom:1px solid #2a3d40;background:#101a20}
.tab{flex:1;border:0;border-bottom:2px solid transparent;border-radius:0;background:transparent;padding:8px 4px;color:#84a39c;font:600 10px system-ui,sans-serif;cursor:pointer}
.tab:hover:not(.active){color:#c8efd9}
.tab.active{color:#bdf0d4;border-bottom-color:#559174}
.tab .dot{display:inline-block;width:5px;height:5px;margin-left:4px;border-radius:50%;background:#4f7f68;vertical-align:middle}
.tab .dot.on{background:#5fd39a}
.panel{display:none}
.panel.active{display:block}
/* 价格指纹面板：消费级明细表格。 */
.price-panel .fp-card{margin-top:8px;padding:9px;border:1px solid #416a56;border-radius:9px;background:#173127}
.price-panel .fp-card[data-level=conflict]{border-color:#735f39;background:#2a2418}
.price-panel .fp-card[data-level=none]{border-color:#35544a;background:#12211c}
.fp-title{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:5px}
.fp-name{font:650 13px/1.3 ui-monospace,Consolas,monospace;color:#b8efd2;overflow-wrap:anywhere}
.fp-name[data-tone=warn]{color:#ecd49a}
.fp-name[data-tone=muted]{color:#9eb7b0}
.fp-badge{white-space:nowrap;border:1px solid #55816b;border-radius:999px;padding:2px 7px;color:#bfead5;font-size:8px}
.fp-badge[data-tone=warn]{border-color:#735f39;color:#ecd49a}
.fp-badge[data-tone=muted]{border-color:#3d5e51;color:#9eb7b0}
.fp-line{margin-top:4px;color:#9eb7b0;font:9px/1.55 ui-monospace,Consolas,monospace;overflow-wrap:anywhere}
.fp-caveat{margin-top:5px;color:#d9c18e;font-size:8px;line-height:1.55;overflow-wrap:anywhere}
/* v2.19.3 未唯一定名的候选列表 */
.fp-cands{margin-top:8px;border:1px solid #35544a;border-radius:9px;background:#12211c;overflow:hidden}
.fp-cands-head{padding:7px 8px;border-bottom:1px solid #2c4a41;color:#9eb7b0;font-size:9px}
.fp-cands-list{max-height:190px;overflow:auto}
.fp-cand{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;padding:5px 8px;border-bottom:1px solid #1d332b;font:9px ui-monospace,Consolas,monospace}
.fp-cand:last-child{border-bottom:0}
.fp-cand-sep{flex:none;color:#7d968f;font-weight:600;white-space:nowrap}
.fp-cand-name{flex:none;max-width:150px;color:#c8efd9;font-weight:600;overflow-wrap:anywhere}
.fp-cand-meta{flex:1;min-width:0;text-align:right;color:#84a39c;overflow-wrap:anywhere}
.cost-table-wrap{margin-top:8px;border:1px solid #35544a;border-radius:9px;background:#12211c;overflow:hidden}
.cost-table-head{display:flex;align-items:center;justify-content:space-between;gap:6px;padding:7px 8px;border-bottom:1px solid #2c4a41;font-size:9px;color:#d6ece2}
.cost-table-head b{font-weight:650}
.cost-table-head small{color:#7d968f;font:8px ui-monospace,Consolas,monospace}
.cost-scroll{max-height:210px;overflow:auto}
table.cost-table{width:100%;border-collapse:collapse;font:9px ui-monospace,Consolas,monospace;color:#a8c3bb}
table.cost-table th{position:sticky;top:0;z-index:1;padding:5px 6px;text-align:right;background:#162924;border-bottom:1px solid #2c4a41;color:#9eb7b0;font-weight:600;white-space:nowrap}
table.cost-table th:first-child,table.cost-table td:first-child{text-align:left}
table.cost-table td{padding:4px 6px;text-align:right;border-bottom:1px solid #1d332b;white-space:nowrap}
table.cost-table tr:last-child td{border-bottom:0}
table.cost-table td.c-name{color:#c8efd9;max-width:104px;overflow:hidden;text-overflow:ellipsis}
table.cost-table td.c-usd{color:#bdf0d4}
table.cost-table td.c-zero{color:#5f7a73}
table.cost-table tfoot td{background:#162924;color:#d6ece2;font-weight:650;border-top:1px solid #35544a}
.cost-empty{padding:9px;color:#7d968f;font-size:8px;line-height:1.55}
`;
    const box=el('section','box'),head=el('header','head'),mark=el('span','mark','V'),title=el('div','title');title.append(el('b','','Vodka-Arena-Model'),el('small','','MODEL INTELLIGENCE · v2.19.9'));const collapse=el('button','collapse','—');collapse.title='收起';collapse.addEventListener('click',()=>{collapsed=true;paint();});const headTools=makeTools();head.append(mark,title,headTools[0],headTools[1],collapse);
    style.textContent+=`
/* Vodka-Arena-Model · deep-space / ice-blue interface */
.box{--vam-bg:#090e1a;--vam-panel:#10192c;--vam-border:#253756;--vam-text:#e5edff;--vam-muted:#91a4c7;--vam-accent:#67deff;width:368px;border-color:#304767;border-radius:16px;background:radial-gradient(ellipse at top right,#233c652e,transparent 55%),var(--vam-bg);color:var(--vam-text);box-shadow:0 20px 64px #020611b3,0 0 0 1px #67deff0c;font:12px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;color-scheme:dark}
.head{gap:9px;padding:13px 12px;background:linear-gradient(110deg,#11213a,#13152c);border-color:var(--vam-border)}
.mark{width:28px;height:28px;flex:none;border:1px solid #64d8fb75;border-radius:9px;background:linear-gradient(135deg,#153951,#25244b);color:#8ce9ff;box-shadow:inset 0 0 12px #6bdfff12;font:800 15px ui-monospace,Consolas,monospace}
.title{min-width:0}.title b{font-size:11px;letter-spacing:.1px;color:#edf4ff;white-space:nowrap}.title small{margin-top:3px;color:#8da7d2;font-size:8px;letter-spacing:1.1px}
.head .mini,.collapse{width:24px;min-width:24px;height:26px;padding:0;border-color:#314769;background:#0d1729;color:#a2b8db}
.body{padding:12px;scrollbar-color:#355075 transparent;scrollbar-width:thin}
.tabs{gap:6px;padding:5px;margin-bottom:12px;background:#0d1628;border:1px solid var(--vam-border);border-radius:10px}
.tab{padding:8px 5px;border:1px solid transparent;border-radius:7px;color:#8da4c7;font-size:10px;letter-spacing:.3px}
.tab.active{border-color:#3c728f;background:linear-gradient(110deg,#15364b,#202441);color:#9beaff;box-shadow:inset 0 0 14px #67deff08}
.tab:hover:not(.active){color:#dbe7ff;background:#15213a}.tab .dot{background:#304966}.tab .dot.on{background:#67deff;box-shadow:0 0 7px #67deff66}
.warning{padding:8px 10px;margin-bottom:12px;border:1px solid #3c3447;border-left:2px solid #b6a1ee;border-radius:8px;background:#171525;color:#b6abc9;font-size:9px;line-height:1.65}
.draw-grid{gap:8px 10px;color:var(--vam-muted);font-size:10px}
.draw-grid input,.draw-grid select{min-height:29px;padding:5px 8px;border-color:#2d4265;border-radius:7px;background:#0b1426;color:#e4edff;font-size:10px}
.draw-grid input[type=checkbox]{min-height:0;width:14px;height:14px;accent-color:#67deff}
.controls{display:flex;gap:7px;margin-top:12px}.controls button{flex:1}
button{border-color:#2e4569;border-radius:8px;background:#14213a;color:#b8cbea;font-size:10px;transition:background .15s,border-color .15s,box-shadow .15s}
button:hover:not(:disabled){filter:none;background:#1b3050;border-color:#527aa0;box-shadow:0 0 12px #67deff0b}
button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid #67deff;outline-offset:2px}
button.primary{border-color:#5ca8cd;background:linear-gradient(110deg,#195572,#343468);color:#eafdff;font-weight:700;box-shadow:inset 0 1px #ffffff14}
button.primary:hover:not(:disabled){background:linear-gradient(110deg,#216581,#41407b);border-color:#8de7ff}
button.all{background:#192740;border-color:#354e73}.stop{border-color:#754656;color:#ffb4c8;background:#2a1726}
button:disabled{opacity:.38;box-shadow:none}.minor{margin-top:7px}.progress{margin:10px 1px 0;padding:7px 8px;border-left:2px solid #3b5c82;border-radius:3px;background:#10182a;color:#9eafd0;font-size:9px;min-height:32px}
.draw,.balance,.ledger{padding:10px;border-color:var(--vam-border);border-radius:11px;background:linear-gradient(140deg,#111d32,#0d1526)}
.draw-title,.ledger-head{color:#dce8ff;letter-spacing:.4px}.draw-note,.balance-row,.ledger-sum,.ledger-ratio{color:#96add0}
.balance-row b,.results b,.ledger-usd{color:#8ae4ff}.results div,.ledger-row{color:#a4b8d9}.balance-note,.ledger-note,.bank,.byline,.ledger-row-sub{color:#7289ad}
.result,.price-panel .fp-card{padding:11px;border-color:#355a79;border-radius:11px;background:linear-gradient(135deg,#102b3b,#161c35)}
.model,.fp-name{color:#8ee7ff;font-size:14px}.metrics,.fp-line{color:#9eb4d5}.fp-caveat{color:#bea9d6;line-height:1.6}
.badge,.fp-badge{border-color:#3c6987;background:#122a3a;color:#94e6ff}
.result[data-level=close],.price-panel .fp-card[data-level=conflict]{border-color:#625270;background:#201c31}
.result[data-level=close] .model,.fp-name[data-tone=warn]{color:#d2b8ff}.result[data-level=weak]{border-color:#75475e;background:#261b2c}.result[data-level=weak] .model{color:#f3adc9}
.price-panel .fp-card[data-level=none]{border-color:var(--vam-border);background:#101a2d}.fp-name[data-tone=muted]{color:#91a4c7}
.fp-badge[data-tone=warn]{border-color:#68537f;color:#d5b8ff;background:#231d35}.fp-badge[data-tone=muted]{border-color:#344965;color:#91a4c7;background:#101a2b}
.fp-cands,.cost-table-wrap{border-color:var(--vam-border);border-radius:11px;background:#0e172a}.fp-cands-head,.cost-table-head{border-color:#253756;background:#121e34;color:#a0b7db}
.fp-cand{border-color:#1f2e49}.fp-cand-name{color:#b7d9f3}.fp-cand-meta,.fp-cand-sep,.cost-empty{color:#859cbe}
.cost-table th{color:#91add0;background:#101c30;border-color:#243755}.cost-table td{color:#b7ccec;border-color:#1e2d46}.cost-table tfoot td{background:#16243c;color:#8fe1fc}
.cost-table-head small,.cost-table-note{color:#7e99be}.cost-table .c-name{color:#92a9cd}.cost-table .c-usd{font-variant-numeric:tabular-nums}
.compact{border-color:#304767;background:linear-gradient(110deg,#102038,#181b33);gap:8px;padding:9px 10px}.compact-text{color:#a8c9ee}.compact .mark{width:24px;height:24px;font-size:13px}.expand{border-color:#426384;background:#142b43;color:#8fe6ff}
.box ::-webkit-scrollbar{width:5px;height:5px}.box ::-webkit-scrollbar-thumb{background:#2c4469;border-radius:8px}.box ::-webkit-scrollbar-track{background:transparent}
@media(prefers-reduced-motion:reduce){button{transition:none}}
`;
    head.title='按住拖动可移动浮层';installDrag(head);
    const body=el('div','body'),warning=el('p','warning','点击即发送真实消息：下拉可选价格指纹、数字指纹或组合。价格发 1 题取账单；数字可自动补题；组合在数字候选中结合价格排序。勾选改名时采用最接近候选，不代表确定识别；未勾选只识别。'),controls=el('div','controls');runOneButton=el('button','primary','快速识别 · 随机1题');runAllButton=el('button','all','精准识别 · 3题全问');runPriceButton=el('button','all','价格识别 · 1题按价');controls.style.gridTemplateColumns='1fr 1fr';controls.append(runOneButton,runAllButton);const minor=el('div','minor');appendButton=el('button','','再补 1 题');stopButton=el('button','stop','停止');clearButton=el('button','','清除结果');minor.append(appendButton,stopButton,clearButton);progressNode=el('p','progress');progressNode.setAttribute('role','status');
    resultNode=el('section','result');const resultTop=el('div','result-top');resultModel=el('div','model');resultBadge=el('span','badge');resultTop.append(resultModel,resultBadge);resultMetrics=el('div','metrics');resultBank=el('div','bank');resultNode.append(resultTop,resultMetrics,resultBank);
    /* 轨迹直读不再是独立卡片（用户要求不展示）：并入数字指纹面板底部一行小字。 */
    traceNode=el('div','bank');traceNode.textContent='轨迹直读：等待 public-access-token（页面自身请求的响应头）';
    const drawBox=el('section','draw'),drawHead=el('div','draw-title');drawHead.append(el('b','','自动抽卡'),el('span','','New Chat 循环'));
    const drawGrid=el('div','draw-grid');
    drawInput=el('input');drawInput.type='number';drawInput.min='1';drawInput.max='100';drawInput.title='抽卡轮数（1–100）';
    drawMode=el('select');for(const [value,label] of [['price','价格指纹'],['quick','数字指纹'],['combined','组合 · 数字 + 价格']]){const option=el('option',null,label);option.value=value;drawMode.append(option);}drawMode.title='单次识别和抽卡共用此模式；组合在数字候选中联合数字拟合与价格贴合度排序';
    drawMinPulse=el('input');drawMinPulse.type='number';drawMinPulse.min='0';drawMinPulse.max='100';drawMinPulse.title='额度下限百分比；低于它就停止抽卡，0 表示不限制';
    drawBlockThinking=el('input');drawBlockThinking.type='checkbox';drawBlockThinking.style.cssText='width:auto;height:13px;padding:0;justify-self:start;margin:0';drawBlockThinking.title='开启后：一旦检测到模型开始 thinking，立即截断并进入下一轮（本轮不识别、不改名）';
    drawAutoTopUp=el('input');drawAutoTopUp.type='checkbox';drawAutoTopUp.style.cssText='width:auto;height:13px;padding:0;justify-self:start;margin:0';drawAutoTopUp.title='默认开启：快速模式下若判定不是“清晰匹配”，自动补发剩余探针（最多 3 题）加强证据；判定清晰时只问 1 题，更快';
    drawRenameAnyway=el('input');drawRenameAnyway.type='checkbox';drawRenameAnyway.style.cssText='width:auto;height:13px;padding:0;justify-self:start;margin:0';drawRenameAnyway.title='勾选后：单次识别和抽卡都按当前模式最接近的候选改名（可能不准）；不勾选仅识别，不改名';
    drawSceneChannel=el('input');drawSceneChannel.type='checkbox';drawSceneChannel.style.cssText='width:auto;height:13px;padding:0;justify-self:start;margin:0';drawSceneChannel.title='默认开启：每轮再多问 1 道 scene 题（6 道循环：12 字句 / 只回一个字母的单选 / 自选「动物-交通工具」），本机按模型累积答案分布，用 Jensen-Shannon 相似度投票，与数字通道交叉验证。嫌慢可以关掉'
    /* v2.18.0：「价格指纹」已上移为**识别模式**的第三项（全库按价裁决）。
       v2.17.0 那个独立勾选框（价格作数字通道的旁证）已合并进模式选择：
       选「价格指纹」模式即启用价格定名；其余模式不再挂价格旁证，避免一处功能两个开关。 */
    drawGrid.append(el('label',null,'轮数'),drawInput,el('label',null,'额度下限%'),drawMinPulse,el('label',null,'拦截 thinking'),drawBlockThinking,el('label',null,'自动补题'),drawAutoTopUp,el('label',null,'scene 通道'),drawSceneChannel);
    drawStartButton=el('button','primary','开始抽卡');drawStopButton=el('button','stop','停止抽卡');
    const drawActions=el('div','draw-actions');drawActions.append(drawStartButton,drawStopButton);
    const drawMinor=el('div','draw-minor');diagnoseButton=el('button',null,'自检（只检查，不发送）');drawMinor.append(diagnoseButton);
    drawProgressNode=el('p','draw-note');drawResultsNode=el('div','results');
    drawBox.append(drawHead,drawGrid,drawActions,drawMinor,drawProgressNode,drawResultsNode);
    const balanceBox=el('section','balance'),balanceRow=el('div','balance-row');balanceNode=el('b','','—');balanceButton=el('button',null,'刷新额度');balanceButton.title='重新读取每日额度';balanceRow.append(el('span',null,'每日额度剩余'),balanceNode,balanceButton);balanceNote=el('p','balance-note','额度来自 arena.ai/api/me/pulse（百分比）');balanceBox.append(balanceRow,balanceNote);
    /* v2.13.2 花费账本：累计 + 逐条明细。
       base 由「公开单价 × 实测 token 用量」算出 —— **不需要计费账号**；
       已开通计费的账号会额外带上实扣价与倍率（实测 ×2）。 */
    ledgerBox=el('section','ledger');
    const ledgerHead=el('div','ledger-head');
    ledgerSummary=el('span','ledger-sum','读取中…');
    ledgerButton=el('button',null,'刷新');ledgerButton.title='重新读取花费账本';
    ledgerToggle=el('button',null,'明细 ▸');ledgerToggle.title='展开/收起逐条明细';
    ledgerHead.append(el('b',null,'花费'),ledgerSummary,ledgerButton,ledgerToggle);
    ledgerRatio=el('div','ledger-ratio');
    ledgerTable=el('div','ledger-table');ledgerTable.hidden=true;
    ledgerNote=el('p','ledger-note','基准价 = Σ token × 公开单价（不需计费账号）；实扣 = 页面下发的真实成本。');
    ledgerBox.append(ledgerHead,ledgerRatio,ledgerTable,ledgerNote);
    const byline=el('p','byline','Vodka-Arena-Model · 由 Vodka 制作 · 本机存数字计数与少量节奏特征，不存其他聊天正文');
    /* v2.19.1 Tab 布局：三个面板共用一个 body 滚动区，顶部页签切换。
       · 数字指纹 = 探针进度 + 数字通道结果 + 抽卡 + 额度（轨迹直读降级为底部一行小字）
       · 价格指纹 = 价格指纹裁决结果 + 消费级明细表（四项分项费用，参考用户截图）
       · 花费     = 花费账本（汇总 + 逐条明细） */
    tabsBar=el('nav','tabs');
    const TAB_DEFS=[['price','模型识别'],['cost','花费']];
    for(const [key,label] of TAB_DEFS){
      const button=el('button','tab');button.dataset.tab=key;button.append(el('span',null,label));
      button.append(el('span','dot'));
      button.addEventListener('click',()=>selectTab(key));
      tabs[key]=button;tabsBar.append(button);
    }
    panelNumeric=el('section','numeric-results');panelPrice=el('section','price-panel');panelCost=el('section','panel');
    const panelRecognition=el('section','panel');
    panels={price:panelRecognition,cost:panelCost};
    /* —— 数字指纹面板 —— */
    panelNumeric.append(resultNode,traceNode);
    /* —— 花费面板 —— */
    panelCost.append(ledgerBox);
    /* —— 价格指纹面板：裁决结果卡 + 消费级明细表 —— */
    fpCard=el('section','fp-card');
    const fpTitle=el('div','fp-title');fpName=el('div','fp-name','尚未识别');fpBadge=el('span','fp-badge','待运行');fpTitle.append(fpName,fpBadge);
    fpLine=el('div','fp-line','选择价格指纹或组合后点「开始识别」；最接近候选不代表确定识别。');
    fpCaveat=el('div','fp-caveat');
    fpMeta=el('div','fp-line');
    fpCard.append(fpTitle,fpLine,fpMeta,fpCaveat);
    /* 未唯一定名时的候选列表（默认隐藏）：每一行 = 候选名 + 依据来源。 */
    fpCands=el('section','fp-cands');fpCands.hidden=true;
    fpCandsList=el('div','fp-cands-list');
    fpCands.append(el('div','fp-cands-head','未唯一定名 —— 以下候选彼此无法区分'),fpCandsList);
    costTableWrap=el('section','cost-table-wrap');
    const costHead=el('div','cost-table-head');
    const costHeadLeft=el('div');costHeadLeft.append(el('b',null,'消费级明细'),el('small',null,' · 官方 /cost 四项分项费用'));
    costTableNote=el('small',null,'USD');
    costHead.append(costHeadLeft,costTableNote);
    const costScroll=el('div','cost-scroll');
    costTableEl=el('table','cost-table');
    const thead=el('thead'),thr=el('tr');
    for(const label of ['#','Input','Output','Cache写','Cache读','合计'])thr.append(el('th',null,label));
    thead.append(thr);
    costTableBody=el('tbody');costTableFoot=el('tfoot');
    costTableEl.append(thead,costTableBody,costTableFoot);costScroll.append(costTableEl);
    costTableEmpty=el('div','cost-empty','还没有官方账单分项 —— 先跑一次价格指纹识别（需要 /cost 能读到四项分项费用）。');
    costTableWrap.append(costHead,costScroll,costTableEmpty);
    panelPrice.append(fpCard,fpCands,costTableWrap,byline);
    const recognitionGrid=el('div','draw-grid');recognitionGrid.append(el('label',null,'识别模式'),drawMode,el('label',null,'改名（最接近）'),drawRenameAnyway);
    panelRecognition.append(recognitionGrid,drawBox,warning,controls,minor,progressNode,panelPrice,panelNumeric,balanceBox);
    body.append(tabsBar,panelRecognition,panelCost);
    const compact=el('div','compact');compactText=el('div','compact-text','模型探测');const expand=el('button','expand','↗');expand.title='展开';expand.addEventListener('click',()=>{collapsed=false;paint();});const compactTools=makeTools();compact.append(mark.cloneNode(true),compactText,compactTools[0],compactTools[1],expand);
    runOneButton.addEventListener('click',()=>void run(prefs.mode));runAllButton.addEventListener('click',()=>void run('precise'));runPriceButton.addEventListener('click',()=>void run('price'));appendButton.addEventListener('click',()=>void run(prefs.mode));stopButton.addEventListener('click',()=>{if(draw.running)stopDraw();else stop();});clearButton.addEventListener('click',clearCurrent);
    drawStartButton.addEventListener('click',()=>void runDraw(Number(drawInput.value)));
    drawStopButton.addEventListener('click',stopDraw);
    diagnoseButton.addEventListener('click',()=>void diagnose());
    balanceButton.addEventListener('click',()=>void refreshBalance(true));
    ledgerButton.addEventListener('click',()=>void refreshLedger());
    ledgerToggle.addEventListener('click',()=>{ledgerState.expanded=!ledgerState.expanded;if(ledgerState.expanded&&!ledgerState.data)void refreshLedger();else paint();});
    drawInput.addEventListener('change',()=>void savePrefs({rounds:Number(drawInput.value)}));
    drawMode.addEventListener('change',()=>void savePrefs({mode:drawMode.value}));
    drawMinPulse.addEventListener('change',()=>void savePrefs({minPulse:Number(drawMinPulse.value)}));
    drawBlockThinking.addEventListener('change',()=>void savePrefs({blockThinking:!!drawBlockThinking.checked}));
    drawAutoTopUp.addEventListener('change',()=>void savePrefs({autoTopUp:!!drawAutoTopUp.checked}));
    drawRenameAnyway.addEventListener('change',()=>void savePrefs({renameAnyway:!!drawRenameAnyway.checked}));
    drawSceneChannel.addEventListener('change',()=>void savePrefs({sceneChannel:!!drawSceneChannel.checked}));
    box.append(head,body,compact);root.append(style,box);document.documentElement.append(host);
    /* v2.19.4 修复：DOM 建好后必须立刻点亮当前页签。此前只有在 loadLocalState() 读到
       存储值时才 selectTab() —— 首次安装（存储为空）时三个 .panel 全是 display:none，
       用户看到的是「只有页签栏、下面一片空白」。persist=false 避免把默认值写回存储。 */
    selectTab(activeTab,false);
    paint();
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
    runOneButton.disabled=busy||state.draw.running||((prefs.mode==='quick'||prefs.mode==='precise')&&samples>=3);runAllButton.disabled=busy||samples>=3;runPriceButton.disabled=busy;stopButton.disabled=!busy;
    appendButton.disabled=busy||samples===0||samples>=3;
    appendButton.textContent=samples>=3?'3 题已问完':`再补 1 题（已 ${samples}/3）`;
    clearButton.disabled=busy||(!samples&&!state.result);
    
    
    runOneButton.textContent=busy?'运行中…':'开始识别';runAllButton.textContent=busy?'运行中…':'精准识别 · 3题全问';runPriceButton.textContent=busy?'运行中…':'价格识别 · 1题按价';progressNode.textContent=state.progress||progress;
    if(state.result){resultNode.hidden=false;resultNode.dataset.level=state.recognition?'close':state.result.status;resultModel.textContent=state.recognition?(state.recognition.label||'Arena 模型池内暂无候选'):resultLabelOf(state.result);resultBadge.textContent=state.recognition?'Arena 候选排序':badgeTextOf(state.result);resultMetrics.textContent=`拟合 ${Number(state.result.signals.fit).toFixed(3)} · 分离 ${Number(state.result.signals.separation).toFixed(3)} · 家族 ${(Number(state.result.signals.family_probability)*100).toFixed(1)}% · 有效 ${state.result.used_outputs}/${samples} · 数字 ${Number.isFinite(Number(state.result.signals.evidence_numbers))?Number(state.result.signals.evidence_numbers):'—'}${state.result.signals.pooled?'（池化）':''} · 候选集 ${decisionOf(state.result)?.set_size??1}${decisionOf(state.result)?.off_reference?' · 混合/漂移提示':''} · Top3 ${topThreeOf(state.result)||'—'}`;resultBank.textContent=`${state.result.bank_source} · ${state.result.bank_models} 个候选 · ${localSummary()}${(()=>{const note=costNoteOf(state.result);return note?' · '+note:'';})()}${pricingNoteOf(state.result)}`;compactText.textContent=`${resultBadge.textContent} · ${resultModel.textContent}`;}
    else{resultNode.hidden=true;compactText.textContent=state.draw.running?`抽卡 ${state.draw.round}/${state.draw.total}`:samples?`已捕获 ${samples}/3 条`:'模型探测';}
    if((state.prefs.mode==='price'||state.prefs.mode==='combined')&&state.price_fingerprint?.suggestion)compactText.textContent=`最接近 · ${state.price_fingerprint.suggestion.label}`;
    const focused=root.activeElement;
    if(focused!==drawInput)drawInput.value=String(state.prefs.rounds);
    if(focused!==drawMode)drawMode.value=String(state.prefs.mode||'price');
    drawMode.disabled=busy||state.draw.running;drawRenameAnyway.disabled=busy||state.draw.running;
    panelNumeric.hidden=state.prefs.mode==='price';panelPrice.hidden=state.prefs.mode==='quick'||state.prefs.mode==='precise';
    runAllButton.hidden=state.prefs.mode!=='quick'&&state.prefs.mode!=='precise';runPriceButton.hidden=true;
    appendButton.hidden=state.prefs.mode==='price';
    if(focused!==drawMinPulse)drawMinPulse.value=String(state.prefs.minPulse);
    if(focused!==drawBlockThinking)drawBlockThinking.checked=!!state.prefs.blockThinking;
    if(focused!==drawAutoTopUp)drawAutoTopUp.checked=state.prefs.autoTopUp!==false;
    if(focused!==drawRenameAnyway)drawRenameAnyway.checked=state.prefs.renameAnyway===true;
    if(focused!==drawSceneChannel)drawSceneChannel.checked=state.prefs.sceneChannel!==false;
    drawStartButton.disabled=busy;drawStopButton.disabled=!state.draw.running;
    drawProgressNode.textContent=state.draw.note||'设定轮数后点击「开始抽卡」：每轮自动新建聊天、发送探针、识别模型；勾选改名时按最接近候选改名。';
    const entries=state.draw.results||[];const resultsSignature=entries.slice(0,6).map(entry=>String(entry.round)+'|'+entry.label+'|'+(entry.renamed?'1':'0')+'|'+entry.verdict).join(';');if(resultsSignature!==lastResultsSignature){lastResultsSignature=resultsSignature;
    drawResultsNode.replaceChildren(...entries.slice(0,6).map(entry=>{const row=el('div');row.append(el('span',null,`${entry.round}. ${entry.label}`),el('b',null,entry.renamed?'已改名':entry.verdict));return row;}));}
    balanceNode.textContent=state.balanceLoading?'读取中…':typeof state.balance?.pulse==='number'?pctText(state.balance.pulse):'—';
    if(traceNode){const tr=state.trace||{};const modelCount=Array.isArray(tr.models)?tr.models.length:0;const recent=Array.isArray(tr.recent)?tr.recent.slice(0,3).join(' | '):'';const pageUrls=Array.isArray(tr.scan?.urls)?tr.scan.urls.slice(0,2).join(' | '):'';const alive=tr.pageSnifferAt?new Date(tr.pageSnifferAt).toTimeString().slice(0,8):'未见信号';const scan=tr.scan||{};traceNode.textContent=`轨迹直读：${tr.text||'等待 public-access-token'} · 页面观测${tr.tokenSeen?'到':'不到'}token · 模型字段${modelCount} · 嗅探:${alive} · 扫描:${scan.req||0}req/${scan.body||0}体/${scan.chunks||0}片${pageUrls?` · 页面:${pageUrls}`:''}${recent?` · 最近:${recent}`:''}${tr.cost?.signals?` · 成本信号:${tr.cost.signals}${Number.isFinite(Number(tr.cost.observed_usd))?`(≈$${Number(tr.cost.observed_usd).toFixed(4)})`:''}`:''}${usageNoteOf(tr.usage)}${tr.pricing?.text_models?` · 单价:${tr.pricing.text_models}模型`:''}`;}
    balanceNote.textContent=state.balanceError?state.balanceError:(state.balance?.refreshedAt?`每日额度剩余 · 下次重置 ${clock(state.balance.refreshedAt)}`:'额度来自 arena.ai/api/me/pulse（百分比）');
    balanceButton.disabled=state.balanceLoading;

    /* v2.13.2 花费账本：渲染与余额同为每拍刷新（数据靠 refreshLedger 拉，这里只画）。
       自动刷新 30 秒节流；失败也更新时间戳，避免每拍重试。 */
    ledgerButton.disabled=ledgerState.loading;
    ledgerButton.textContent=ledgerState.loading?'读取中…':'刷新';
    renderLedger();
    /* v2.19.1：价格面板与页签圆点随每拍刷新（数据源为 lastPriceFingerprint + ledgerState.data）。 */
    renderPricePanel(state);
    updateTabDots(state);
    applyHudPos();
    if(!ledgerState.loading&&Date.now()-ledgerState.at>30000)void refreshLedger();

    if(foldOn&&!busy&&!state.draw.running)applyFold();
    else updateFoldButtons();
  }

  chrome.runtime.onMessage.addListener((message,_sender,reply)=>{
    if(message?.type==='AMP_STATUS'){if(!ledgerState.data&&!ledgerState.loading)void refreshLedger();reply(publicStatus());return;}
    if(message?.type==='AMP_LEDGER_REFRESH'){void refreshLedger().then(()=>reply(publicStatus()));return true;}
    if(message?.type==='AMP_RUN_SELECTED'){draw.note='';void run(prefs.mode);reply(publicStatus());return;}
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
    syncHudSession();const epoch=hudEpoch,key=hudSessionKey;
    try{
      void chrome.runtime.sendMessage({type:'AMP_NET',evidence:data.evidence||[],models:data.models||[],pageUrl:location.href}).then(response=>{
        syncHudSession();if(epoch===hudEpoch&&key===hudSessionKey&&response&&typeof response==='object'){globalThis.__ampNetwork=response;globalThis.__ampTrace=response.trace||response;paint();}
      }).catch(()=>{});
    }catch{}
  });
  window.addEventListener('pagehide',()=>{cancelled=true;});
  const onSessionNavigation=()=>{syncHudSession();paint();};
  window.addEventListener('popstate',onSessionNavigation);window.navigation?.addEventListener('navigatesuccess',onSessionNavigation);
  new MutationObserver(mutations=>{
    if(host&&!host.isConnected)createHud();
    if(foldOn&&mutations.some(change=>!foldRoot||foldRoot.contains(change.target)||change.target.contains?.(foldRoot)))scheduleFold();
  }).observe(document,{childList:true,subtree:true});
  try{document.documentElement.dataset.ampBuild='v2199';}catch{} // 构建标记：验证页面注入的是最新脚本
  /* 页面性能：1s 无条件重画改事件驱动 —— 路由/历史变更与嗅探回包即时重画（它们正是 agentPage/explicit 状态变化的来源），
     另留 5s 低频兜底兜住其余不定期变化（显隐判断仍在 paint 内部，行为语义不变）。 */
  createHud();setInterval(paint,5000);
  /* 测试钩子：仅当宿主显式提供 __ampTestHook 时导出内部函数（生产环境不挂载）。
     必须放在 createHud() 之后 —— 面板节点是那时才赋值的；用 getter 保证 createHud() 重建后仍取到最新引用。 */
  try{if(globalThis.__ampTestHook){globalThis.__ampTest={ledgerState,renderCostTable,renderPricePanel,renderPriceCandidates,selectTab,setPrice:(fp)=>{lastPriceFingerprint=fp;},applyHudPos,get panels(){return panels;},get tabs(){return tabs;},get costTableBody(){return costTableBody;},get costTableFoot(){return costTableFoot;},get costTableEmpty(){return costTableEmpty;},get fpCands(){return fpCands;},get fpCandsList(){return fpCandsList;},get activeTab(){return activeTab;},get pos(){return pos;},get host(){return host;}};}}catch{}
  setInterval(()=>{if(running||draw.running){try{chrome.runtime.sendMessage({type:'AMP_PING'}).catch(()=>{});}catch{}}},20000); // v2.9.15：运行期给 SW 保活，防止调试会话因 SW 挂起变孤儿
  void loadPrefs().then(()=>loadLocalState()).then(()=>{paint();void refreshBalance(false);});

})();

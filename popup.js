import {formatPulse} from './billing.js';

const $=id=>document.getElementById(id);
let tabId=null,available=false,timer=null;

const ARENA_ORIGIN_RE=/^https:\/\/(?:canary\.)?arena\.ai$/; // 生产 + 预发布 canary
function agentUrl(value){try{const url=new URL(value);return ARENA_ORIGIN_RE.test(url.origin)&&/^\/(?:agent|work)(?:\/|$)/.test(url.pathname);}catch{return false;}}
function clock(iso){const date=iso?new Date(iso):null;return date&&Number.isFinite(date.getTime())?`${date.getMonth()+1}-${date.getDate()} ${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`:'—';}

// v2.8.1：置信集 >1 时显示「家族 + 候选集」，混合/漂移时挂提示，弱匹配显示「未定」，不再无条件报单一模型名。
function decisionOf(result){return result?.signals?.decision||null;}
function resultLabel(result){
  const nearest=result?.nearest?.display_name||'—',d=decisionOf(result);
  if(!result)return '—';
  if(result.status==='weak')return `未定（最近 ${nearest}）`;
  if(d&&d.set_size>1)return `${result.nearest?.family_name||nearest} 家族 · 候选 ${d.set_names.join(' / ')}`;
  if(d&&d.mixture)return `${nearest}（疑似近亲混合路由或参考库漂移 ${d.mixture.names.join('+')}）`;
  return nearest;
}
function badgeText(result){return {clear:'清晰匹配',close:'同族近似',weak:'弱匹配'}[result?.status]||result?.status||'';}

function render(state){
  if(!state)return;const samples=Number(state.samples)||0,draw=state.draw||{},prefs=state.prefs||{};
  $('progress').textContent=state.progress||'等待操作';
  $('run-quick').disabled=!available||state.running||draw.running||(prefs.mode==='quick'&&samples>=3);
  $('run-precise').disabled=!available||state.running||samples>=3;
  $('stop').disabled=!state.running;
  $('clear').disabled=state.running||(!samples&&!state.result);
  $('run-quick').textContent=state.running?'运行中…':'开始识别';
  $('run-precise').textContent=state.running?'运行中…':'精准识别 · 3题全问';
  $('run-precise').hidden=prefs.mode!=='quick';$('append').hidden=prefs.mode==='price';
  $('append').disabled=!available||state.running||samples===0||samples>=3;
  $('append').textContent=samples>=3?'3 题已问完':`再补 1 题（已 ${samples}/3）`;
  if(state.result&&prefs.mode!=='price'){
    const result=state.result;$('result').hidden=false;$('result').dataset.level=state.recognition?'close':result.status;$('model').textContent=state.recognition?(state.recognition.label||'Arena 模型池内暂无候选'):resultLabel(result);
    $('badge').textContent=state.recognition?'Arena 候选排序':badgeText(result);
    $('metrics').textContent=`拟合 ${Number(result.signals.fit).toFixed(3)} · 分离 ${Number(result.signals.separation).toFixed(3)} · 家族 ${(Number(result.signals.family_probability)*100).toFixed(1)}% · 有效 ${result.used_outputs}/${samples} · 数字 ${Number.isFinite(Number(result.signals.evidence_numbers))?Number(result.signals.evidence_numbers):'—'}${result.signals.pooled?'（池化）':''}`;
    $('bank').textContent=`${result.bank_source} · ${result.bank_models} 个候选`;
  }else $('result').hidden=true;
  if(document.activeElement!==$('rounds'))$('rounds').value=String(prefs.rounds??5);
  if(document.activeElement!==$('mode'))$('mode').value=String(prefs.mode||'price');
  if(document.activeElement!==$('min-pulse'))$('min-pulse').value=String(prefs.minPulse??0);
  if(document.activeElement!==$('block-thinking'))$('block-thinking').checked=!!prefs.blockThinking;
  if(document.activeElement!==$('auto-topup'))$('auto-topup').checked=prefs.autoTopUp!==false;
  if(document.activeElement!==$('rename-nearest'))$('rename-nearest').checked=prefs.renameAnyway===true;
  $('mode').disabled=!!(state.running||draw.running);$('rename-nearest').disabled=!!(state.running||draw.running);
  $('draw-start').disabled=!available||state.running;
  $('draw-stop').disabled=!draw.running;
  $('draw-diagnose').disabled=!available||state.running;
  $('draw-progress').textContent=draw.note||'设定轮数后点击「开始抽卡」：每轮自动新建聊天、发送探针、识别模型；勾选改名时按最接近候选改名。';
  $('draw-results').replaceChildren(...(draw.results||[]).slice(0,6).map(entry=>{
    const row=document.createElement('div'),left=document.createElement('span'),right=document.createElement('b');
    left.textContent=`${entry.round}. ${entry.label}`;right.textContent=entry.renamed?'已改名':entry.verdict;row.append(left,right);return row;
  }));
  $('balance-value').textContent=state.balanceLoading?'读取中…':typeof state.balance?.pulse==='number'?formatPulse(state.balance.pulse):'—';
  $('balance-note').textContent=state.balanceError||(state.balance?.refreshedAt?`每日额度剩余 · 下次重置 ${clock(state.balance.refreshedAt)}`:'额度来自 arena.ai/api/me/pulse（百分比）');
  renderLedger(state);
}
/* v2.13.2 花费账本：摘要一行 + 可展开的逐条明细。数据由 content.js 计算后随状态下发。 */
let ledgerExpanded=false;
const ledgerUsd=value=>{
  const number=Number(value);
  if(!Number.isFinite(number))return '—';
  if(number===0)return '$0';
  if(Math.abs(number)<0.0001)return `$${number.toExponential(2)}`;
  return number<1?`$${Number(number.toFixed(6))}`:`$${Number(number.toFixed(4))}`;
};
function renderLedger(state){
  const data=state.ledger,table=$('ledger-table');
  $('ledger-toggle').textContent=ledgerExpanded?'明细 ▾':'明细 ▸';
  table.hidden=!ledgerExpanded;
  if(state.ledgerLoading&&!data){$('ledger-value').textContent='读取中…';$('ledger-ratio').textContent='';table.replaceChildren();$('ledger-note').textContent='';return;}
  if(state.ledgerError){$('ledger-value').textContent='读取失败';$('ledger-ratio').textContent='';table.replaceChildren();$('ledger-note').textContent=state.ledgerError;return;}
  if(!data){$('ledger-value').textContent='—';$('ledger-ratio').textContent='';table.replaceChildren();$('ledger-note').textContent='尚未读取；在页面上真实发一条消息后点「刷新」。';return;}
  $('ledger-value').textContent=data.text||'—';
  $('ledger-ratio').textContent=data.token_ratio||'';
  const rows=Array.isArray(data.rows)?data.rows:[];
  table.replaceChildren(...rows.map(row=>{
    const line=document.createElement('div'),head=document.createElement('div'),sub=document.createElement('div');
    /* v2.16.0：/cost 官方行没有模型名，但金额是服务端权威值 —— 标「官方计费」。 */
    const official=String(row.source||'').startsWith('cost-route');
    head.className='ledger-line';
    head.textContent=`#${row.index} · ${String(row.message_id||'—').slice(0,8)} · ${row.model?String(row.model).replace(/-agent$/,''):(official?'官方计费':'模型未揭晓')} · ${official?'服务端口径':`${row.tokens||0}t${row.estimate?'（估算）':''}`} · ${ledgerUsd(row.base_usd)}`;
    line.append(head);
    const bits=[];
    if(row.actual_usd!==null&&row.actual_usd!==undefined&&row.actual_usd!==row.base_usd)bits.push(`上游 ${ledgerUsd(row.actual_usd)}`);
    if(row.charged_usd!==null&&row.charged_usd!==undefined){
      bits.push(`实扣 ${ledgerUsd(row.charged_usd)}`);
      if(row.multiplier)bits.push(`×${row.multiplier}`);
      if(row.credits)bits.push(`${Number(row.credits.toFixed(2))} 积分`);
    }
    if(bits.length){sub.className='ledger-sub';sub.textContent=bits.join(' · ');line.append(sub);}
    return line;
  }));
  const groups=(data.same_price_groups||[]).filter(group=>group.ambiguous);
  /* v2.13.3 按价反推进弹窗：最近一条的 base 成本 × 用量对全库排序；没有真实成本时直说原因。 */
  const rv=data.reverse;
  const reverseText=rv?.text?`${rv.text}${(rv.same_price_groups||[]).some(g=>g.ambiguous)?`（同价不可分：${rv.same_price_groups.filter(g=>g.ambiguous).map(g=>g.ids.join('/')).join('、')}）`:''}`:(rv?.note||'');
  /* v2.16.1 花费反推腿：官方逐条 base ÷ 同消息估算 token（Agent 模式无用量时的反推来路），
     与上面的按价反推（Battle 有服务端用量）互补，两个口径都展示。 */
  const cr=data.cost_reverse;
  const crText=cr?.text?`${cr.text}${(cr.same_price_groups||[]).some(g=>g.ambiguous)?`（同价不可分：${cr.same_price_groups.filter(g=>g.ambiguous).map(g=>g.ids.join('/')).join('、')}）`:''}`:(cr?.note||'');
  const baseNote=groups.length
    ? `同价候选（四项价格完全相同，价格区分不开）：${groups.map(group=>{
        const cw=group.cache_write_usd_per_mtok==null?'—':`$${group.cache_write_usd_per_mtok}`;
        const cr=group.cache_read_usd_per_mtok==null?'—':`$${group.cache_read_usd_per_mtok}`;
        return `${group.ids.join(' / ')}（输入 $${group.input_usd_per_mtok} / 输出 $${group.output_usd_per_mtok} / 缓存写 ${cw} / 缓存读 ${cr} 每 Mtok）`;
      }).join('；')} · 更多费用记录仍无法仅凭单价区分`
    : (data.mode==='blocked'
      ?'Agent 模式：Arena 不下发 token 用量（会话包 metadata 里没有 usage 字段），成本走 /api/chat/:id/cost —— 扩展会临时写 PostHog 覆写 cookie 放行灰度门再读（读完即删）；仍读不到时原因见页面浮层。Battle 模式才有逐条明细。'
      :(data.note||'基准价 = Σ token × 公开单价；实扣 = 页面下发的真实成本。'));
  $('ledger-note').textContent=[crText,reverseText].filter(Boolean).join(' · ')?`${[crText,reverseText].filter(Boolean).join(' · ')} · ${baseNote}`:baseNote;
}
async function message(type,extra={}){
  if(!available||!Number.isInteger(tabId))return null;
  try{const state=await chrome.tabs.sendMessage(tabId,{type,...extra});render(state);return state;}
  catch{available=false;$('unavailable').hidden=false;$('controls').hidden=true;return null;}
}
/* v2.9.23：debugger 是可选权限，而弹窗按钮的点击本身就是用户手势 —— 首次在这里申请授权。 */
async function withDebug(type,extra={}){
  try{
    if(chrome.permissions&&!await chrome.permissions.contains({permissions:['debugger']}))await chrome.permissions.request({permissions:['debugger']});
  }catch{}
  return message(type,extra);
}
$('run-quick').addEventListener('click',()=>void withDebug('AMP_RUN_SELECTED'));
$('run-precise').addEventListener('click',()=>void withDebug('AMP_RUN_PRECISE'));
$('append').addEventListener('click',()=>void withDebug('AMP_RUN_APPEND'));
$('stop').addEventListener('click',()=>void message('AMP_STOP'));
$('clear').addEventListener('click',()=>void message('AMP_CLEAR'));
$('draw-start').addEventListener('click',()=>void withDebug('AMP_DRAW_START',{rounds:Number($('rounds').value)}));
$('draw-stop').addEventListener('click',()=>void message('AMP_DRAW_STOP'));
$('draw-diagnose').addEventListener('click',()=>void message('AMP_DIAGNOSE'));
$('balance-refresh').addEventListener('click',()=>void message('AMP_BALANCE_REFRESH'));
$('ledger-refresh').addEventListener('click',()=>void message('AMP_LEDGER_REFRESH'));
$('ledger-toggle').addEventListener('click',()=>{ledgerExpanded=!ledgerExpanded;void message('AMP_STATUS');});
for(const [id,key] of [['rounds','rounds'],['min-pulse','minPulse']]){
  $(id).addEventListener('change',()=>void message('AMP_PREFS_SET',{patch:{[key]:Number($(id).value)}}));
}
$('mode').addEventListener('change',()=>void message('AMP_PREFS_SET',{patch:{mode:$('mode').value}}));
$('block-thinking').addEventListener('change',()=>void message('AMP_PREFS_SET',{patch:{blockThinking:$('block-thinking').checked}}));
$('auto-topup').addEventListener('change',()=>void message('AMP_PREFS_SET',{patch:{autoTopUp:$('auto-topup').checked}}));
$('rename-nearest').addEventListener('change',()=>void message('AMP_PREFS_SET',{patch:{renameAnyway:$('rename-nearest').checked}}));

try{
  const [tab]=await chrome.tabs.query({active:true,currentWindow:true});tabId=tab?.id??null;available=Number.isInteger(tabId)&&agentUrl(tab?.url);
  $('unavailable').hidden=available;$('controls').hidden=!available;
  if(available){await message('AMP_STATUS');timer=setInterval(()=>void message('AMP_STATUS'),1000);}
}catch{$('unavailable').hidden=false;$('controls').hidden=true;}
window.addEventListener('unload',()=>clearInterval(timer));

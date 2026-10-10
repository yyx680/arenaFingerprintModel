import {formatPulse} from './billing.js';

const $=id=>document.getElementById(id);
let tabId=null,available=false,timer=null;

function agentUrl(value){try{const url=new URL(value);return url.origin==='https://arena.ai'&&/^\/(?:agent|work)(?:\/|$)/.test(url.pathname);}catch{return false;}}
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
  $('run-quick').disabled=!available||state.running||samples>=3;
  $('run-precise').disabled=!available||state.running||samples>=3;
  $('stop').disabled=!state.running;
  $('clear').disabled=state.running||(!samples&&!state.result);
  $('run-quick').textContent=state.running?'运行中…':'快速识别 · 随机1题';
  $('run-precise').textContent=state.running?'运行中…':'精准识别 · 3题全问';
  $('append').disabled=!available||state.running||samples===0||samples>=3;
  $('append').textContent=samples>=3?'3 题已问完':`再补 1 题（已 ${samples}/3）`;
  if(state.result){
    const result=state.result;$('result').hidden=false;$('result').dataset.level=result.status;$('model').textContent=resultLabel(result);
    $('badge').textContent=badgeText(result);
    $('metrics').textContent=`拟合 ${Number(result.signals.fit).toFixed(3)} · 分离 ${Number(result.signals.separation).toFixed(3)} · 家族 ${(Number(result.signals.family_probability)*100).toFixed(1)}% · 有效 ${result.used_outputs}/${samples} · 数字 ${Number.isFinite(Number(result.signals.evidence_numbers))?Number(result.signals.evidence_numbers):'—'}${result.signals.pooled?'（池化）':''}`;
    $('bank').textContent=`${result.bank_source} · ${result.bank_models} 个候选`;
  }else $('result').hidden=true;
  if(document.activeElement!==$('rounds'))$('rounds').value=String(prefs.rounds??5);
  if(document.activeElement!==$('mode'))$('mode').value=String(prefs.mode||'quick');
  if(document.activeElement!==$('min-pulse'))$('min-pulse').value=String(prefs.minPulse??0);
  if(document.activeElement!==$('block-thinking'))$('block-thinking').checked=!!prefs.blockThinking;
  if(document.activeElement!==$('auto-topup'))$('auto-topup').checked=prefs.autoTopUp!==false;
  $('draw-start').disabled=!available||state.running;
  $('draw-stop').disabled=!draw.running;
  $('draw-diagnose').disabled=!available||state.running;
  $('draw-progress').textContent=draw.note||'设定轮数后点击「开始抽卡」：每轮自动新建聊天、发送探针、识别模型并改名。';
  $('draw-results').replaceChildren(...(draw.results||[]).slice(0,6).map(entry=>{
    const row=document.createElement('div'),left=document.createElement('span'),right=document.createElement('b');
    left.textContent=`${entry.round}. ${entry.label}`;right.textContent=entry.renamed?'已改名':entry.verdict;row.append(left,right);return row;
  }));
  $('balance-value').textContent=state.balanceLoading?'读取中…':typeof state.balance?.pulse==='number'?formatPulse(state.balance.pulse):'—';
  $('balance-note').textContent=state.balanceError||(state.balance?.refreshedAt?`每日额度剩余 · 下次重置 ${clock(state.balance.refreshedAt)}`:'额度来自 arena.ai/api/me/pulse（百分比）');
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
$('run-quick').addEventListener('click',()=>void withDebug('AMP_RUN_QUICK'));
$('run-precise').addEventListener('click',()=>void withDebug('AMP_RUN_PRECISE'));
$('append').addEventListener('click',()=>void withDebug('AMP_RUN_APPEND'));
$('stop').addEventListener('click',()=>void message('AMP_STOP'));
$('clear').addEventListener('click',()=>void message('AMP_CLEAR'));
$('draw-start').addEventListener('click',()=>void withDebug('AMP_DRAW_START',{rounds:Number($('rounds').value)}));
$('draw-stop').addEventListener('click',()=>void message('AMP_DRAW_STOP'));
$('draw-diagnose').addEventListener('click',()=>void message('AMP_DIAGNOSE'));
$('balance-refresh').addEventListener('click',()=>void message('AMP_BALANCE_REFRESH'));
for(const [id,key] of [['rounds','rounds'],['min-pulse','minPulse']]){
  $(id).addEventListener('change',()=>void message('AMP_PREFS_SET',{patch:{[key]:Number($(id).value)}}));
}
$('mode').addEventListener('change',()=>void message('AMP_PREFS_SET',{patch:{mode:$('mode').value}}));
$('block-thinking').addEventListener('change',()=>void message('AMP_PREFS_SET',{patch:{blockThinking:$('block-thinking').checked}}));
$('auto-topup').addEventListener('change',()=>void message('AMP_PREFS_SET',{patch:{autoTopUp:$('auto-topup').checked}}));

try{
  const [tab]=await chrome.tabs.query({active:true,currentWindow:true});tabId=tab?.id??null;available=Number.isInteger(tabId)&&agentUrl(tab?.url);
  $('unavailable').hidden=available;$('controls').hidden=!available;
  if(available){await message('AMP_STATUS');timer=setInterval(()=>void message('AMP_STATUS'),1000);}
}catch{$('unavailable').hidden=false;$('controls').hidden=true;}
window.addEventListener('unload',()=>clearInterval(timer));

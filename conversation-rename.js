/* Rename the current Arena conversation through Arena's visible UI only. */
(() => {
  let busy=false,busySince=0;
  /* Arena 站点源：生产 arena.ai 与预发布 canary.arena.ai（同一产品；登录态/新功能常先在 canary）。 */
  const ARENA_ORIGIN_RE=/^https:\/\/(?:canary\.)?arena\.ai$/;
  const sessionFromPath=path=>path.match(/^\/(?:agent|work)\/([a-zA-Z0-9-]{1,128})\/?$/)?.[1]||null;
  const text=element=>(element?.textContent||'').trim();
  const exact=(element,words)=>words.includes(text(element));
  const visible=element=>{
    if(!element?.isConnected||!element.getClientRects().length)return false;
    if(['menu','dialog','alertdialog'].includes(element.getAttribute('role'))&&element.getAttribute('data-state')==='closed')return false;
    if(typeof getComputedStyle==='function'){const style=getComputedStyle(element);if(style.display==='none'||style.visibility==='hidden')return false;}
    return true;
  };
  function validate(sessionId,title){
    if(typeof sessionId!=='string'||!/^[a-zA-Z0-9-]{1,128}$/.test(sessionId))throw Error('当前 Arena 会话尚未建立，无法重命名');
    if(typeof title!=='string'||!title.trim())throw Error('没有可用于重命名的模型名');
    const clean=title.trim();
    if(clean.length>100||/[\u0000-\u001f\u007f]/.test(clean))throw Error('模型名不符合 Arena 标题限制');
    return clean;
  }
  async function rename({sessionId,title,isCurrent=()=>true}){
    const nextTitle=validate(sessionId,title);
    if(busy&&Date.now()-busySince<60000)throw Error('已有重命名/清理正在进行，请稍候');busy=false; // v2.5.3：超过 60 秒的忙锁视为失效，避免卡住后续操作
    const guard=()=>{if(!ARENA_ORIGIN_RE.test(location.origin)||sessionFromPath(location.pathname)!==sessionId||!isCurrent())throw Error('当前会话已变化，停止重命名');};
    const wait=(check,message,timeout=8000)=>new Promise((resolve,reject)=>{
      let observer,timer,interval,done=false;
      const finish=(error,value)=>{if(done)return;done=true;observer?.disconnect();clearTimeout(timer);clearInterval(interval);error?reject(error):resolve(value);};
      const tick=()=>{try{guard();const value=check();if(value)finish(null,value);}catch(error){finish(error);}};
      observer=new MutationObserver(tick);observer.observe(document,{subtree:true,childList:true,attributes:true,characterData:true});
      interval=setInterval(tick,100);timer=setTimeout(()=>finish(Error(message)),timeout);tick();
    });
    const links=()=>[...document.querySelectorAll('a[data-sidebar="menu-button"][href]')].filter(link=>{try{const url=new URL(link.href);return ARENA_ORIGIN_RE.test(url.origin)&&sessionFromPath(url.pathname)===sessionId;}catch{return false;}});
    const currentLink=()=>links().find(link=>visible(link)&&!link.closest?.('[data-state="collapsed"][data-collapsible]'))||null;
    guard();busy=true;busySince=Date.now();let menu=null,dialog=null,submitted=false,oldTitle='';
    try{
      if([...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')].some(visible))throw Error('页面仍有对话框，无法安全重命名');
      if(!currentLink()){
        const buttons=[...document.querySelectorAll('button[aria-label]')].filter(button=>visible(button)&&!button.disabled);
        const opener=buttons.find(button=>['Open sidebar','展开侧栏','打开侧边栏','展开侧边栏'].includes(button.getAttribute('aria-label')))
          ||buttons.find(button=>['Toggle Sidebar','Toggle sidebar','切换侧栏'].includes(button.getAttribute('aria-label'))&&button.closest?.('[data-state="collapsed"]'));
        if(opener){guard();opener.click();}
      }
      const link=await wait(currentLink,'未找到当前会话的侧栏标签，无法自动重命名');
      link.scrollIntoView?.({block:'nearest',inline:'nearest',behavior:'instant'});oldTitle=text(link);
      if(oldTitle===nextTitle)return {title:nextTitle,previousTitle:oldTitle,unchanged:true};
      const row=link.closest('[data-sidebar="menu-item"]');
      const trigger=row?.querySelector('button[data-sidebar="menu-action"][aria-haspopup="menu"]');
      if(!trigger?.id||trigger.disabled)throw Error('当前会话菜单不可用，无法自动重命名');
      const getMenu=()=>[...document.querySelectorAll('[role="menu"]')].find(element=>element.getAttribute('aria-labelledby')===trigger.id&&visible(element));
      if(!getMenu()){
        guard();
        trigger.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerType:'mouse',button:0,buttons:1,isPrimary:true}));
        trigger.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerType:'mouse',button:0,buttons:0,isPrimary:true}));
        trigger.click();
      }
      menu=await wait(getMenu,'无法打开当前会话菜单');
      const items=[...menu.querySelectorAll('[role="menuitem"]')].filter(element=>exact(element,['Rename','重命名','重命名对话'])&&!element.hasAttribute('data-disabled'));
      if(items.length!==1)throw Error('没有找到唯一的重命名入口');
      guard();items[0].click();
      dialog=await wait(()=>[...document.querySelectorAll('[role="dialog"]')].find(element=>visible(element)&&exact(element.querySelector('h2'),['Rename chat','Rename conversation','重命名对话','重命名聊天'])),'没有出现 Arena 重命名对话框');
      const inputs=[...dialog.querySelectorAll('input')].filter(element=>visible(element)&&!element.disabled&&['text',''].includes(element.getAttribute('type')||''));
      if(inputs.length!==1)throw Error('重命名输入框不明确，未提交');
      const input=inputs[0];
      if(input.value!==oldTitle||text(currentLink())!==oldTitle)throw Error('会话标题已被其他操作修改，未提交');
      if(input.maxLength>0&&nextTitle.length>input.maxLength)throw Error('模型名超过页面允许的标题长度');
      guard();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,nextTitle);
      input.dispatchEvent(new Event('input',{bubbles:true,composed:true}));input.dispatchEvent(new Event('change',{bubbles:true,composed:true}));
      const submit=await wait(()=>[...dialog.querySelectorAll('button[type="submit"]')].find(button=>visible(button)&&!button.disabled&&exact(button,['Rename','重命名','保存'])),'Arena 没有接受新的会话名称');
      guard();if(input.value!==nextTitle||text(currentLink())!==oldTitle)throw Error('提交前会话标题发生变化，已取消');
      submitted=true;submit.click();
      await wait(()=>text(currentLink())===nextTitle&&!visible(dialog),'未能确认会话重命名成功',10000);
      return {title:nextTitle,previousTitle:oldTitle,unchanged:false};
    }finally{
      if(!submitted&&sessionFromPath(location.pathname)===sessionId){
        if(visible(dialog)){
          const input=dialog.querySelector('input');
          if(input&&[nextTitle,oldTitle].includes(input.value)){const cancel=[...dialog.querySelectorAll('button[type="button"]')].find(button=>exact(button,['Cancel','取消']));cancel?.click();}
        }else if(visible(menu))menu.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',bubbles:true}));
      }
      busy=false;
    }
  }
  /* 归档/删除会话：按参考实现（arena-trace-inspector 2.3.2 conversation-rename.js 的 archive）逐条对齐 ——
     侧栏行 a[data-sidebar="menu-button"] → 该行内 button[data-sidebar="menu-action"][aria-haspopup="menu"]
     → 菜单必须是 [role="menu"][aria-labelledby=按钮 id] → 只点唯一的 Archive 项（归档文案精确匹配）
     → 出现确认框时按归档文案点名点按钮 → 侧栏该行消失、侧栏仍在，稳定 ≥1000 毫秒才算成功。
     菜单里没有唯一归档项时退到唯一的 Delete 项；两者都没有就报错，绝不点别的条目。 */
  async function deleteConversation({sessionId,isCurrent=()=>true}={}){
    if(typeof sessionId!=='string'||!/^[a-zA-Z0-9-]{1,128}$/.test(sessionId))throw Error('会话尚未建立，无法归档对话');
    if(busy&&Date.now()-busySince<60000)throw Error('已有重命名/清理正在进行，请稍候');busy=false; // v2.5.3：超过 60 秒的忙锁视为失效
    // v2.5.7：归档依赖的是「侧栏里的那一行」，与当前打开的是哪个聊天无关 ——
    // 抽卡会立刻新建下一个对话、页面已经翻页，旧守卫硬要求路径==sessionId，清理会被误判成「当前聊天已变化」而放弃。
    const guard=()=>{if(!ARENA_ORIGIN_RE.test(location.origin)||!isCurrent())throw Error('页面已离开 Arena 或抽卡已停止，未归档');};
    const sidebarExpanded=element=>visible(element)&&!element.closest?.('[data-state="collapsed"][data-collapsible]');
    const links=()=>[...document.querySelectorAll('a[data-sidebar="menu-button"][href]')].filter(link=>{try{const url=new URL(link.href);return ARENA_ORIGIN_RE.test(url.origin)&&sessionFromPath(url.pathname)===sessionId;}catch{return false;}});
    const wait=(check,message,timeout=15000)=>new Promise((resolve,reject)=>{
      let timer,interval,done=false;
      const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);clearInterval(interval);error?reject(error):resolve(value);};
      const tick=()=>{try{const value=check();if(value)finish(null,value);}catch(error){finish(error);}};
      timer=setTimeout(()=>finish(Error(message)),timeout);interval=setInterval(tick,100);tick();
    });
    guard();busy=true;busySince=Date.now();let menu=null,dialog=null,submitted=false;
    try{
      if([...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')].some(visible))throw Error('请先关闭页面上已打开的对话框，再重试');
      if(!links().find(sidebarExpanded)){
        const buttons=[...document.querySelectorAll('button[aria-label]')].filter(button=>visible(button)&&!button.disabled);
        const opener=buttons.find(button=>['Open sidebar','展开侧栏','打开侧边栏','展开侧边栏'].includes(button.getAttribute('aria-label')))
          ||buttons.find(button=>['Toggle Sidebar','Toggle sidebar','切换侧栏'].includes(button.getAttribute('aria-label'))&&button.closest?.('[data-state="collapsed"]'));
        if(opener){guard();opener.click();}
      }
      const a=await wait(()=>{guard();return links().find(sidebarExpanded);},'自动展开侧栏后仍未找到该聊天；未作修改');
      a.scrollIntoView?.({block:'nearest',inline:'nearest',behavior:'instant'});
      const sidebar=a.closest('[data-sidebar="sidebar"]')||a.closest('[data-sidebar="content"]');
      if(!sidebar)throw Error('无法确认聊天侧栏，未作修改');
      const trigger=a.closest('[data-sidebar="menu-item"]')?.querySelector('button[data-sidebar="menu-action"][aria-haspopup="menu"]');
      if(!trigger?.id||trigger.disabled)throw Error('当前聊天菜单不可用，未作修改');
      const getMenu=()=>[...document.querySelectorAll('[role="menu"]')].find(element=>element.getAttribute('aria-labelledby')===trigger.id&&visible(element));
      if(!getMenu()){
        guard();
        trigger.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerType:'mouse',button:0,buttons:1,isPrimary:true}));
        trigger.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerType:'mouse',button:0,buttons:0,isPrimary:true}));
        trigger.click();
      }
      menu=await wait(()=>{guard();return getMenu();},'无法打开聊天菜单，未归档');
      const items=[...menu.querySelectorAll('[role="menuitem"]')].filter(element=>!element.hasAttribute('data-disabled'));
      const archives=items.filter(element=>exact(element,['Archive','归档','归档聊天','归档对话']));
      const deletes=items.filter(element=>exact(element,['Delete','Delete chat','Delete conversation','删除','删除对话','删除聊天']));
      let action=null,item=null;
      if(archives.length===1){action='archive';item=archives[0];}
      else if(archives.length>1)throw Error('Archive 入口不唯一；不会以其他操作代替归档');
      else if(deletes.length===1){action='delete';item=deletes[0];}
      else if(deletes.length>1)throw Error('删除入口不唯一；未作修改');
      else throw Error(`没找到归档/删除入口，菜单里看到的条目：${(items.map(element=>text(element).slice(0,26)).join(' / ')||'（菜单为空）').slice(0,160)}`);
      guard();submitted=true;item.click();
      const words=action==='archive'
        ?{h2:['Archive chat','Archive conversation','归档聊天','归档对话'],button:['Archive','归档']}
        :{h2:['Delete chat','Delete conversation','删除对话','删除聊天'],button:['Delete','删除']};
      let stableSince=0;
      await wait(()=>{
        if(!ARENA_ORIGIN_RE.test(location.origin))throw Error('页面已离开 Arena，无法确认结果；本地记录保留');
        const dialogs=[...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')].filter(visible);
        if(dialogs.length){
          guard();
          if(dialogs.length!==1||!exact(dialogs[0].querySelector('h2'),words.h2))throw Error('出现未识别的确认框，请手动处理；本地记录保留');
          if(!dialog){
            dialog=dialogs[0];
            const buttons=[...dialog.querySelectorAll('button')].filter(button=>!button.disabled&&exact(button,words.button));
            if(buttons.length!==1)throw Error('确认按钮不明确');
            guard();buttons[0].click();
          }
          stableSince=0;return false;
        }
        if((visible(sidebar)||[...document.querySelectorAll('[data-sidebar="sidebar"]')].some(sidebarExpanded))&&!links().length&&!getMenu()){
          if(!stableSince)stableSince=Date.now();
          return Date.now()-stableSince>=1000;
        }
        stableSince=0;return false;
      },action==='archive'?'未能确认归档成功；请检查 Arena，本地记录未删除':'未能确认删除成功；请检查 Arena，本地记录未删除');
      return {deleted:true,archived:action==='archive',sessionId};
    }finally{
      if(!submitted&&visible(menu))menu.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',bubbles:true}));
      busy=false;
    }
  }
  globalThis.ArenaProbeRename=Object.freeze({rename,deleteConversation,isBusy:()=>busy,sessionFromPath});
})();

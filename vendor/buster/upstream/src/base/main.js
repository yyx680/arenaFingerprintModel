import storage from 'storage/storage';
import {busterStorage} from 'storage/isolated';
import {meanSleep, pingClientApp} from 'utils/app';
import {
  getText,
  findNode,
  getRandomFloat,
  runOnce,
  sleep,
  getBrowserVersion
} from 'utils/common';
import {targetEnv, clientAppVersion} from 'utils/config';

function main() {
  const parents=Array.from(self.location.ancestorOrigins||[]);
  if(!parents.some(origin=>/^https:\/\/(?:canary\.)?arena\.ai$/.test(origin)))return;
  let solverWorking = false;
  let solverButton = null;

  function setSolverState({working = true} = {}) {
    solverWorking = working;
    if (solverButton) {
      if (working) {
        solverButton.classList.add('working');
      } else {
        solverButton.classList.remove('working');
      }
    }
  }

  function resetCaptcha() {
    return browser.runtime.sendMessage({
      id: 'resetCaptcha',
      challengeUrl: window.location.href
    });
  }

  function syncUI() {
    if (isBlocked()) {
      if (!document.querySelector('.solver-controls')) {
        const div = document.createElement('div');
        div.classList.add('solver-controls');

        const button = document.createElement('button');
        button.classList.add('rc-button');
        button.setAttribute('tabindex', '0');
        button.setAttribute('title', getText('buttonLabel_reset'));
        button.id = 'reset-button';

        button.addEventListener('click', resetCaptcha);

        div.appendChild(button);
        document.querySelector('.rc-footer').appendChild(div);
      }
      return;
    }

    const helpButton = document.querySelector('#recaptcha-help-button');
    if (helpButton) {
      helpButton.remove();

      const helpButtonHolder = document.querySelector('.help-button-holder');
      helpButtonHolder.tabIndex = document.querySelector('audio#audio-source')
        ? 0
        : 2;

      const shadow = helpButtonHolder.attachShadow({
        mode: 'closed',
        delegatesFocus: true
      });

      const link = document.createElement('link');
      link.setAttribute('rel', 'stylesheet');
      link.setAttribute(
        'href',
        browser.runtime.getURL('/buster/src/base/solver-button.css')
      );
      shadow.appendChild(link);

      solverButton = document.createElement('button');
      solverButton.setAttribute('tabindex', '0');
      solverButton.id = 'solver-button';
      if (solverWorking) {
        solverButton.classList.add('working');
      }
      setSolverButtonTooltip(solverButton);

      solverButton.addEventListener('click', solveChallenge);

      shadow.appendChild(solverButton);
    }
  }

  async function setSolverButtonTooltip(button) {
    if (targetEnv === 'firefox') {
      let {speechService} = await storage.get('speechService');
      if (speechService === 'managed') {
        speechService = 'witSpeechApi';
      }

      button.setAttribute(
        'data-tooltip',
        getText(
          'buttonTooltip_solve',
          getText(`optionValue_speechService_${speechService}`)
        )
      );
    } else {
      button.setAttribute('title', getText('buttonLabel_solve'));
    }
  }

  function isBlocked({timeout = 0} = {}) {
    const selector = '.rc-doscaptcha-body';
    if (timeout) {
      return new Promise(resolve => {
        findNode(selector, {timeout, throwError: false}).then(result =>
          resolve(Boolean(result))
        );
      });
    }

    return Boolean(document.querySelector(selector));
  }

  function dispatchEnter(node) {
    const keyEvent = {
      code: 'Enter',
      key: 'Enter',
      keyCode: 13,
      which: 13,
      view: window,
      bubbles: true,
      composed: true,
      cancelable: true
    };

    node.focus();
    node.dispatchEvent(new KeyboardEvent('keydown', keyEvent));
    node.dispatchEvent(new KeyboardEvent('keypress', keyEvent));
    node.click();
  }

  async function navigateToElement(node, {forward = true} = {}) {
    if (document.activeElement === node) {
      return;
    }

    if (!forward) {
      await messageClientApp({command: 'pressKey', data: 'shift'});
      await meanSleep(300);
    }

    while (document.activeElement !== node) {
      await messageClientApp({command: 'tapKey', data: 'tab'});
      await meanSleep(300);
    }

    if (!forward) {
      await messageClientApp({command: 'releaseKey', data: 'shift'});
      await meanSleep(300);
    }
  }

  async function tapEnter(node, {navigateForward = true} = {}) {
    await navigateToElement(node, {forward: navigateForward});
    await meanSleep(200);
    await messageClientApp({command: 'tapKey', data: 'enter'});
  }

  async function clickElement(node, browserBorder, osScale) {
    const targetPos = await getClickPos(node, browserBorder, osScale);
    await messageClientApp({command: 'moveMouse', ...targetPos});
    await meanSleep(100);
    await messageClientApp({command: 'clickMouse'});
  }

  async function messageClientApp(message) {
    const rsp = await browser.runtime.sendMessage({
      id: 'messageClientApp',
      message
    });

    if (!rsp.success) {
      throw new Error(`Client app response: ${rsp.text}`);
    }

    return rsp;
  }

  async function getOsScale() {
    return browser.runtime.sendMessage({id: 'getOsScale'});
  }

  async function getBrowserBorder(clickEvent, osScale) {
    const framePos = await getFrameClientPos();
    const scale = window.devicePixelRatio;

    let evScreenPropScale = osScale;
    if (targetEnv === 'firefox' && (await getBrowserVersion()) >= 99) {
      // https://bugzilla.mozilla.org/show_bug.cgi?id=1753836

      evScreenPropScale = scale;
    }

    return {
      left:
        clickEvent.screenX * evScreenPropScale -
        clickEvent.clientX * scale -
        framePos.x -
        window.screenX * scale,
      top:
        clickEvent.screenY * evScreenPropScale -
        clickEvent.clientY * scale -
        framePos.y -
        window.screenY * scale
    };
  }

  async function getFrameClientPos() {
    if (window !== window.top) {
      let frameIndex;
      const siblingWindows = window.parent.frames;
      for (let i = 0; i < siblingWindows.length; i++) {
        if (siblingWindows[i] === window) {
          frameIndex = i;
          break;
        }
      }

      return await browser.runtime.sendMessage({id: 'getFramePos', frameIndex});
    }

    return {x: 0, y: 0};
  }

  async function getElementScreenRect(node, browserBorder, osScale) {
    let {left: x, top: y, width, height} = node.getBoundingClientRect();

    const data = await getFrameClientPos();
    const scale = window.devicePixelRatio;

    x *= scale;
    y *= scale;
    width *= scale;
    height *= scale;

    x += data.x + browserBorder.left + window.screenX * scale;
    y += data.y + browserBorder.top + window.screenY * scale;

    const {os} = await browser.runtime.sendMessage({id: 'getPlatform'});
    if (['windows', 'macos'].includes(os)) {
      x /= osScale;
      y /= osScale;
      width /= osScale;
      height /= osScale;
    }

    return {x, y, width, height};
  }

  async function getClickPos(node, browserBorder, osScale) {
    let {x, y, width, height} = await getElementScreenRect(
      node,
      browserBorder,
      osScale
    );

    return {
      x: Math.round(x + width * getRandomFloat(0.4, 0.6)),
      y: Math.round(y + height * getRandomFloat(0.4, 0.6))
    };
  }

  async function solve(simulateUserInput, clickEvent, automatic=null) {
    await validateAutomatic(automatic);
    if (isBlocked()) {
      return;
    }

    const {navigateWithKeyboard} = await storage.get('navigateWithKeyboard');

    let browserBorder;
    let osScale;
    let useMouse = true;
    if (simulateUserInput) {
      if (!navigateWithKeyboard && (clickEvent.clientX || clickEvent.clientY)) {
        osScale = await getOsScale();
        browserBorder = await getBrowserBorder(clickEvent, osScale);
      } else {
        useMouse = false;
      }
    }

    const audioElSelector = 'audio#audio-source';
    let audioEl = document.querySelector(audioElSelector);
    if (!audioEl) {
      const audioButton = document.querySelector('#recaptcha-audio-button');
      if(automatic&&(!audioButton||audioButton.disabled))throw Error('当前挑战没有可用音频，请手动处理');
      await validateAutomatic(automatic);
      if (simulateUserInput) {
        if (useMouse) {
          await clickElement(audioButton, browserBorder, osScale);
        } else {
          audioButton.focus();
          await tapEnter(audioButton);
        }
      } else {
        dispatchEnter(audioButton);
      }

      const result = await Promise.race([
        new Promise(resolve => {
          findNode(audioElSelector, {timeout: 10000, throwError: false}).then(
            el => {
              meanSleep(500).then(() => resolve({audioEl: el}));
            }
          );
        }),
        new Promise(resolve => {
          isBlocked({timeout: 10000}).then(blocked => resolve({blocked}));
        })
      ]);

      if (result.blocked) {
        return;
      }

      audioEl = result.audioEl;
    }

    if (simulateUserInput) {
      const muteAudio = function () {
        audioEl.muted = true;
      };
      const unmuteAudio = function () {
        removeCallbacks();
        audioEl.muted = false;
      };

      audioEl.addEventListener('playing', muteAudio, {
        capture: true,
        once: true
      });
      audioEl.addEventListener('ended', unmuteAudio, {
        capture: true,
        once: true
      });

      const removeCallbacks = function () {
        window.clearTimeout(timeoutId);
        audioEl.removeEventListener('playing', muteAudio, {
          capture: true,
          once: true
        });
        audioEl.removeEventListener('ended', unmuteAudio, {
          capture: true,
          once: true
        });
      };

      const timeoutId = window.setTimeout(unmuteAudio, 10000); // 10 seconds

      const playButton = document.querySelector(
        '.rc-audiochallenge-play-button > button'
      );
      if (useMouse) {
        await clickElement(playButton, browserBorder, osScale);
      } else {
        await tapEnter(playButton);
      }
    }

    if(automatic&&(!audioEl||!audioEl.src))throw Error('未取得挑战音频，本框不自动重试');
    await validateAutomatic(automatic);
    const audioUrl = audioEl.src;
    const lang = document.documentElement.lang;

    const solution = await browser.runtime.sendMessage({
      id: 'transcribeAudio',
      audioUrl,
      lang,
      ...(automatic?{automatic:true,autoClaim:automatic.autoClaim}:{})
    });

    if (!solution) {
      return;
    }

    await validateAutomatic(automatic);
    if(automatic&&document.querySelector(audioElSelector)?.src!==audioUrl)throw Error('挑战音频已更新，停止本次自动辅助');
    const input = document.querySelector('#audio-response');
    if(automatic&&(!input||input.value.trim()))throw Error('没有可用空输入框，自动辅助不覆盖手动内容');
    if (simulateUserInput) {
      if (useMouse) {
        await clickElement(input, browserBorder, osScale);
      } else {
        await navigateToElement(input);
      }
      await meanSleep(200);

      await messageClientApp({command: 'typeText', data: solution});
    } else {
      input.value = solution;
    }

    const submitButton = document.querySelector('#recaptcha-verify-button');
    if (simulateUserInput) {
      if (useMouse) {
        await clickElement(submitButton, browserBorder, osScale);
      } else {
        await tapEnter(submitButton);
      }
    } else {
      dispatchEnter(submitButton);
    }

    browser.runtime.sendMessage({id: 'captchaSolved'});
    return true; // Submission only, not proof that verification succeeded.
  }

  let autoEnabled=false,autoAttempted=false,autoPending=false,autoViewportVisible=false;
  let autoTimer=null,autoObserver=null;
  const autoNotice=message=>browser.runtime.sendMessage({id:'notification',message:'Buster 自动辅助：'+message}).catch(()=>{});
  function stopAutoWatch(){if(autoTimer!==null){window.clearInterval(autoTimer);autoTimer=null;}autoObserver?.disconnect();autoObserver=null;}
  function localAutoVisible(){
    if(document.visibilityState!=='visible'||!autoViewportVisible)return false;
    return Array.from(document.querySelectorAll('#recaptcha-audio-button,#audio-response,#rc-imageselect,.rc-doscaptcha-body')).some(node=>{const rect=node.getBoundingClientRect(),style=getComputedStyle(node);return rect.width>0&&rect.height>0&&style.visibility!=='hidden'&&style.display!=='none';});
  }
  async function validateAutomatic(automatic){
    if(!automatic)return;
    if(document.visibilityState!=='visible'||!autoViewportVisible||isBlocked())throw Error('挑战框已隐藏或受限，停止本次自动辅助');
    const state=await browser.runtime.sendMessage({id:'busterAutoValidate',autoClaim:automatic.autoClaim});
    if(!state?.allowed)throw Error('自动辅助已关闭或挑战状态变化，请手动处理');
  }
  async function checkAutomatic(){
    if(!autoEnabled||autoAttempted||autoPending||solverWorking||!localAutoVisible())return;
    autoPending=true;
    let ownsSolver=false;
    try{
      if(isBlocked()||document.querySelector('#audio-response')?.value.trim()){autoAttempted=true;stopAutoWatch();return;}
      // Wait for the controls before consuming this document's one automatic attempt.
      const audioEl=document.querySelector('audio#audio-source');
      if(audioEl){if(!audioEl.src)return;}
      else{
        const audioButton=document.querySelector('#recaptcha-audio-button');
        if(!audioButton||audioButton.disabled||audioButton.getAttribute('aria-disabled')==='true')return;
        const rect=audioButton.getBoundingClientRect(),style=getComputedStyle(audioButton);
        if(rect.width<=0||rect.height<=0||style.visibility==='hidden'||style.display==='none'||Number(style.opacity)===0)return;
      }
      const state=await browser.runtime.sendMessage({id:'busterAutoClaim'});
      if(!state?.allowed){
        if(state?.reason==='notVisible'||state?.reason==='disabled')return;
        autoAttempted=true;stopAutoWatch();
        if(state?.reason!=='alreadyAttempted')void autoNotice(state?.reason||'无法取得单次许可，请刷新 Arena 或手动处理');
        return;
      }
      autoAttempted=true;
      if(autoTimer!==null){window.clearInterval(autoTimer);autoTimer=null;}
      if(solverWorking){stopAutoWatch();return;}
      ownsSolver=true;
      setSolverState({working:true});
      const result=await solve(false,null,state);
      void autoNotice(result===true?'已完成一次识别和提交，请查看验证结果；探测需手动重启':'本框自动尝试已结束，未完成提交，请手动处理');
    }catch(error){autoAttempted=true;stopAutoWatch();void autoNotice(String(error?.message||error));}
    finally{autoPending=false;if(ownsSolver){stopAutoWatch();setSolverState({working:false});}}
  }
  function configureAutomatic(){
    if(!autoEnabled||autoAttempted){stopAutoWatch();return;}
    if(!autoObserver){
      const changed=entries=>{const entry=entries[entries.length-1];autoViewportVisible=!!entry?.isIntersecting&&entry.intersectionRatio>0;void checkAutomatic();};
      // The parent confirms frame visibility; trackVisibility can reject scaled challenge frames.
      autoObserver=new IntersectionObserver(changed,{threshold:0.01});
      autoObserver.observe(document.documentElement);
    }
    if(autoTimer===null)autoTimer=window.setInterval(()=>void checkAutomatic(),1000);
  }
  function startAutomatic(){
    storage.get('autoCaptchaEnabled').then(data=>{autoEnabled=data.autoCaptchaEnabled===true;configureAutomatic();}).catch(()=>{});
    busterStorage.onChanged.addListener((changes,area)=>{if(area==='local'&&changes.autoCaptchaEnabled){autoEnabled=changes.autoCaptchaEnabled.newValue===true;configureAutomatic();}});
    document.addEventListener('visibilitychange',()=>void checkAutomatic());
    window.addEventListener('pagehide',stopAutoWatch,{once:true});
  }

  function solveChallenge(ev) {
    ev.preventDefault();
    ev.stopImmediatePropagation();

    if (!ev.isTrusted || solverWorking) {
      return;
    }
    setSolverState({working: true});

    runSolver(ev)
      .catch(err => {
        browser.runtime.sendMessage({
          id: 'notification',
          message: 'Buster: '+String(err?.message||err)
        });
        console.log(err.toString());
        throw err;
      })
      .finally(() => {
        setSolverState({working: false});
      });
  }

  async function runSolver(ev) {
    await solve(false,ev); // Preserve the upstream trusted user click; no native simulation client.
  }

  function init() {
    const observer = new MutationObserver(syncUI);
    observer.observe(document, {
      childList: true,
      subtree: true
    });

    syncUI();
    startAutomatic();
  }

  init();
}

if (runOnce('baseModule')) {
  main();
}

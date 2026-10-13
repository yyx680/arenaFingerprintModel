// SPDX-License-Identifier: GPL-3.0-only
// Fresh namespaced storage, without upstream legacy migrations or global clear().
import {busterStorage} from './isolated';
import {storageRevisions,appVersion} from 'utils/config';
async function initStorage({area='local',data=null}={}) {
  const defaults = area === 'local' ? {
    speechService:'managed',autoCaptchaEnabled:false,googleSpeechApiKey:'',ibmSpeechApiUrl:'',ibmSpeechApiKey:'',
    microsoftSpeechApiLoc:'eastus',microsoftSpeechApiKey:'',witSpeechApiKeys:{},
    installTime:Date.now(),useCount:0,tryEnglishSpeechModel:true,loadEnglishChallenge:false,
    simulateUserInput:false,autoUpdateClientApp:false,navigateWithKeyboard:false,
    appTheme:'auto',showContribPage:false,contribPageLastOpen:0,contribPageLastAutoOpen:0,
    appVersion,enableManagedLocalServices:true,enableManagedRemoteServices:false
  } : {platformInfo:null,autoAttemptClaims:{}};
  const current = await busterStorage[area].get(null);
  const missing = Object.fromEntries(Object.entries(defaults).filter(([key]) => current[key] === undefined));
  await busterStorage[area].set({...missing,...(data||{}),storageVersion:storageRevisions[area]});
}
export {initStorage};

import 'utils/public-path';
import {
  getTransformersApiStatus,
  getTransformersApiSession,
  getTransformersApiResult
} from 'utils/models';
import {
  arrayBufferToBase64,
  base64ToArrayBuffer,
  prepareAudio
} from 'utils/common';

async function processAudio(audioString, audioOptions) {
  const audioBuffer = base64ToArrayBuffer(audioString);
  const audioContent = await prepareAudio(audioBuffer, audioOptions);

  messagePort.postMessage({
    audioString: arrayBufferToBase64(audioContent)
  });
}

async function transcribeAudio(audioString, audioOptions) {
  const status = await getTransformersApiStatus();

  let result = {};

  if (status === 'available') {
    const audioBuffer = base64ToArrayBuffer(audioString);

    const audioContent = await prepareAudio(audioBuffer, {
      ...audioOptions,
      convertToWav: false
    });

    result = await getTransformersApiResult(audioContent);
  }

  if(status !== 'available')throw new Error('本地模型尚未准备：右键扩展图标打开人机辅助设置，先下载/准备 Whisper 模型');
  messagePort.postMessage({result});
}

function onMessage(request) {
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

let messagePort;
function onConnect(port) {
  if (port.name === 'offscreen') {
    messagePort = port;
    messagePort.onMessage.addListener(onMessage);
  }
}

browser.runtime.onConnect.addListener(onConnect);

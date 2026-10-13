import {
  pipeline,
  env as transformersEnv,
  LogLevel,
  ModelRegistry
} from '@huggingface/transformers';

import {noPunctuationRx} from 'utils/data';

function getPromptApiParams() {
  return {
    expectedInputs: [{type: 'text', languages: ['en']}, {type: 'audio'}],
    expectedOutputs: [{type: 'text', languages: ['en']}]
  };
}

async function initPromptApi({params = null} = {}) {
  if (!params) {
    params = getPromptApiParams();
  }

  try {
    const session = await LanguageModel.create(params);
    await session.destroy();
  } catch (err) {
    console.log(err.toString());
  }
}

async function getPromptApiStatus({params = null, init = false} = {}) {
  if (!params) {
    params = getPromptApiParams();
  }

  let status;

  try {
    if (typeof LanguageModel !== 'undefined') {
      status = await LanguageModel.availability(params);

      if (
        init &&
        !['unavailable', 'available', 'downloading'].includes(status)
      ) {
        initPromptApi({params});
      }
    }
  } catch (err) {
    console.log(err.toString());
  }

  return status ? status : 'unavailable';
}

async function getPromptApiSession({params = null} = {}) {
  if (!params) {
    params = getPromptApiParams();
  }

  try {
    return await LanguageModel.create(params);
  } catch (err) {
    console.log(err.toString());
  }
}

async function getPromptApiResult(audioContent) {
  const result = {};

  const session = await getPromptApiSession();

  if (session) {
    try {
      const data = await session.prompt([
        {
          role: 'user',
          content: [
            {
              type: 'text',
              value:
                'transcribe this audio, the output cannot contain punctuation or uppercase letters'
            },
            {type: 'audio', value: audioContent}
          ]
        }
      ]);

      if (data) {
        result.text = data.trim();
      }
    } catch (err) {
      console.log(err.toString());
    } finally {
      session.destroy();
    }
  }

  return result;
}

function getTransformersApiParams({callback = null} = {}) {
  // Keep cached q8 weights; bypass the ONNX QDQ transpose optimization failure.
  const options = {device: 'wasm', dtype: 'q8', session_options: {graphOptimizationLevel: 'disabled'}};

  if (callback) {
    options.progress_callback = callback;
  }

  return ['automatic-speech-recognition', 'Xenova/whisper-tiny', options];
}

function setTransformersApiEnv() {
  transformersEnv.logLevel = LogLevel.ERROR;
  transformersEnv.backends.onnx.wasm.wasmPaths =
    browser.runtime.getURL('buster/src/wasm/');
  transformersEnv.backends.onnx.wasm.numThreads = 1;
}

async function initTransformersApi({params = null, callback = null} = {}) {
  setTransformersApiEnv();

  if (!params) {
    params = getTransformersApiParams({callback});
  }

  try {
    const session = await pipeline(...params);
    await session.dispose();
  } catch (err) {
    console.log(err.toString());
  }
}

async function getTransformersApiStatus({params = null, init = false} = {}) {
  setTransformersApiEnv();

  if (!params) {
    params = getTransformersApiParams();
  }

  let isCached;

  try {
    isCached = await ModelRegistry.is_pipeline_cached(...params);

    if (init && !isCached) {
      initTransformersApi({params});
    }
  } catch (err) {
    console.log(err.toString());
  }

  return isCached ? 'available' : 'downloadable';
}

async function getTransformersApiSession({params = null, cachedOnly=false} = {}) {
  setTransformersApiEnv();

  if (!params) {
    params = getTransformersApiParams();
  }

  const allowLocalModels=transformersEnv.allowLocalModels;
  if(cachedOnly){
    // Transformers checks caches first; allowLocalModels is required by local_files_only.
    transformersEnv.allowLocalModels=true;
    params=[params[0],params[1],{...params[2],local_files_only:true}];
  }
  try {
    return await pipeline(...params);
  } catch (err) {
    const detail=String(err?.message||err).replace(/https?:\/\/[^\s"'<>]+/g,value=>{try{const url=new URL(value);url.search='';url.hash='';return url.href;}catch{return 'URL';}}).slice(0,1200);
    throw new Error('Whisper 加载失败：'+detail);
  }finally{transformersEnv.allowLocalModels=allowLocalModels;}
}

async function getManagedLocalServiceStatus() {
  let status = await getPromptApiStatus();

  const data = {};

  if (status !== 'unavailable') {
    data.modelId = 'geminiNano';
  } else {
    data.modelId = 'whisper';
    status = await getTransformersApiStatus();
  }

  if (status === 'available') {
    status = 'ready to use';
  } else if (status === 'downloadable') {
    status = 'ready to download';
  }

  data.status = status;

  return data;
}

async function getTransformersApiResult(audioContent) {
  const result = {};

  const session = await getTransformersApiSession({cachedOnly:true}); // Inference never downloads missing model files.

  if (session) {
    try {
      const data = await session(audioContent);

      if (data) {
        result.text = data.text
          .replace(noPunctuationRx, '')
          .toLowerCase()
          .trim();
      }
    } catch (err) {
      console.log(err.toString());
    } finally {
      session.dispose();
    }
  }

  return result;
}

export {
  getPromptApiParams,
  initPromptApi,
  getPromptApiStatus,
  getPromptApiSession,
  getPromptApiResult,
  getTransformersApiParams,
  setTransformersApiEnv,
  initTransformersApi,
  getTransformersApiStatus,
  getTransformersApiSession,
  getManagedLocalServiceStatus,
  getTransformersApiResult
};

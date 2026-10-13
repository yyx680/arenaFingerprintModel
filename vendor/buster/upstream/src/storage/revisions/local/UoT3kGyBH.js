import {busterStorage} from 'storage/isolated';
const message = 'Initial version';

const revision = 'UoT3kGyBH';

async function upgrade() {
  const changes = {
    speechService: 'googleSpeechApiDemo', // 'googleSpeechApiDemo', 'witSpeechApiDemo', 'googleSpeechApi', 'witSpeechApi', 'ibmSpeechApi', 'microsoftSpeechApi'
    googleSpeechApiKey: '',
    installTime: new Date().getTime(),
    useCount: 0
  };

  changes.storageVersion = revision;
  return busterStorage.local.set(changes);
}

export {message, revision, upgrade};

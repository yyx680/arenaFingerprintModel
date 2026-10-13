import {busterStorage} from 'storage/isolated';
const message = 'Add IBM Watson Speech to Text API';

const revision = 'ONiJBs00o';

async function upgrade() {
  const changes = {
    ibmSpeechApiLoc: 'frankfurt', // 'frankfurt', 'dallas', 'washington', 'sydney', 'tokyo'
    ibmSpeechApiKey: ''
  };

  changes.storageVersion = revision;
  return busterStorage.local.set(changes);
}

export {message, revision, upgrade};

import {busterStorage} from 'storage/isolated';
const message = 'Revision description';

const revision = 'DlgF14Chrh';

async function upgrade() {
  const changes = {};
  const {speechService} = await busterStorage.local.get('speechService');
  if (speechService === 'googleSpeechApiDemo') {
    changes.speechService = 'witSpeechApiDemo';
  }

  changes.storageVersion = revision;
  return busterStorage.local.set(changes);
}

export {message, revision, upgrade};

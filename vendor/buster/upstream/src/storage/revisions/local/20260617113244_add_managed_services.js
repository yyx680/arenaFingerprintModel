import {busterStorage} from 'storage/isolated';
const message = 'Add managed services';

const revision = '20260617113244_add_managed_services';

async function upgrade() {
  const changes = {};

  const {speechService} = await busterStorage.local.get('speechService');
  if (speechService === 'witSpeechApiDemo') {
    changes.speechService = 'managed';
  }

  changes.enableManagedLocalServices = true;
  changes.enableManagedRemoteServices = true;

  changes.storageVersion = revision;
  return busterStorage.local.set(changes);
}

export {message, revision, upgrade};

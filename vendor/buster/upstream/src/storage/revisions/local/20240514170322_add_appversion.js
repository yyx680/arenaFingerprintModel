import {busterStorage} from 'storage/isolated';
const message = 'Add appVersion';

const revision = '20240514170322_add_appversion';

async function upgrade() {
  const changes = {
    appVersion: ''
  };

  changes.storageVersion = revision;
  return busterStorage.local.set(changes);
}

export {message, revision, upgrade};

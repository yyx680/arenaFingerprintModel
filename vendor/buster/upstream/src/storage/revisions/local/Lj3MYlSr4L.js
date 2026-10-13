import {busterStorage} from 'storage/isolated';
const message = 'Add navigateWithKeyboard';

const revision = 'Lj3MYlSr4L';

async function upgrade() {
  const changes = {
    navigateWithKeyboard: false
  };

  changes.storageVersion = revision;
  return busterStorage.local.set(changes);
}

export {message, revision, upgrade};

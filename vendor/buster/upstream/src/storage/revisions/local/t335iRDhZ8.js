import {busterStorage} from 'storage/isolated';
const message = 'Add simulateUserInput option';

const revision = 't335iRDhZ8';

async function upgrade() {
  const changes = {
    simulateUserInput: false
  };

  changes.storageVersion = revision;
  return busterStorage.local.set(changes);
}

export {message, revision, upgrade};

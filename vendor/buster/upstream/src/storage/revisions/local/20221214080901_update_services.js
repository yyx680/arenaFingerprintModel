import {busterStorage} from 'storage/isolated';
const message = 'Update services';

const revision = '20221214080901_update_services';

async function upgrade() {
  const changes = {};

  const {witSpeechApiKeys} = await busterStorage.local.get(
    'witSpeechApiKeys'
  );
  delete witSpeechApiKeys['catalan'];
  delete witSpeechApiKeys['telugu'];
  changes.witSpeechApiKeys = witSpeechApiKeys;

  await busterStorage.local.remove('ibmSpeechApiLoc');
  changes.ibmSpeechApiUrl = '';

  changes.microsoftSpeechApiLoc = 'eastus';

  changes.storageVersion = revision;
  return busterStorage.local.set(changes);
}

export {message, revision, upgrade};

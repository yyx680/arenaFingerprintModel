import {busterStorage} from 'storage/isolated';
import {getDayPrecisionEpoch} from 'utils/common';

const message = 'Add theme support';

const revision = '20221211221603_add_theme_support';

async function upgrade() {
  const changes = {
    appTheme: 'auto', // auto, light, dark
    showContribPage: true,
    contribPageLastOpen: 0,
    contribPageLastAutoOpen: 0
  };

  const {installTime} = await busterStorage.local.get('installTime');
  changes.installTime = getDayPrecisionEpoch(installTime);

  changes.storageVersion = revision;
  return busterStorage.local.set(changes);
}

export {message, revision, upgrade};

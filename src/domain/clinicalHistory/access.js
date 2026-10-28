'use strict';

// Shared by the legacy patient projection and versioned clinical histories.
// The caller supplies its permission lookup, including transaction/catalog scope.
async function canReadClinicalHistory(hasPermission) {
    return await hasPermission('clinical_history.view')
        && await hasPermission('clinical_history.view_sensitive');
}

module.exports = { canReadClinicalHistory };

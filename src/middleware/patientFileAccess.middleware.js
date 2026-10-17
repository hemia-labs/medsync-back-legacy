const { hasPermission } = require('../util/effectivePermissions');
const response = require('../util/responsedata');
const CODES = Object.freeze({ SIGNATURE: 'CFCD20', PHOTO: 'C4CA42', XRAY: 'C81E72' });

function patientFileAccess(write = false) {
    return async (req, res, next) => {
        try {
            const actor = req.tokenDecode && req.tokenDecode.id_login;
            const codes = [];
            const general = await hasPermission(actor, write ? 'clinical_history.edit_draft' : 'clinical_history.view');
            if (general) codes.push(...Object.values(CODES));
            else if (await hasPermission(actor, 'px.photos.manager')) codes.push(CODES.PHOTO, CODES.XRAY);
            else if (!write) {
                if (await hasPermission(actor, 'px.tab.photos')) codes.push(CODES.PHOTO);
                if (await hasPermission(actor, 'px.radiography')) codes.push(CODES.XRAY);
            }
            if (!codes.length || (write && !codes.includes((req.body || {}).code_cat_files))) {
                const denied = response.forbidden('No tienes permiso para estos archivos del paciente.');
                return res.status(denied.status).send(denied);
            }
            req.patientFileCodes = codes;
            next();
        } catch (error) { next(error); }
    };
}
module.exports = patientFileAccess;

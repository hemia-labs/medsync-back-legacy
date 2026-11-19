'use strict';
const { QueryTypes } = require('sequelize');
const sequelize = require('../db/Sequelize.connection');
const privateImages = require('./aws/privateImages');

// The shared lock keeps updateLogo from replacing/deleting the object while we
// copy its bytes. Keep it until the document transaction commits or rolls back.
async function capture(business, transaction) {
    const rows = await sequelize.query(`SELECT logo_url FROM business
        WHERE id_business COLLATE utf8mb4_unicode_ci = :business COLLATE utf8mb4_unicode_ci
        AND active = 1 LIMIT 1 FOR SHARE`,
    { replacements: { business }, type: QueryTypes.SELECT, transaction });
    try {
        if (!rows[0]) throw Error();
        const source = rows[0].logo_url;
        if (!source) return null;
        const image = await privateImages.inlineImage(source, business);
        if (!image) throw Error();
        // Legacy external logos retain their existing representation. Never
        // fetch arbitrary URLs here; managed private images are always embedded.
        if (privateImages.isPrivateKey(source) && !image.startsWith('data:image/')) throw Error();
        return image;
    } catch (_) {
        throw Object.assign(new Error('No pudimos leer el logo para documentos. El documento sigue en borrador. Revisa el logo en Apariencia y vuelve a intentar.'), { code: 'DOCUMENT_LOGO_UNAVAILABLE' });
    }
}

function saved(raw) {
    let value = raw;
    if (typeof value === 'string') { try { value = JSON.parse(value); } catch (_) { value = null; } }
    if (!value || value.v !== 1 || !Object.hasOwn(value, 'logo')) return { state: 'unrecorded', image: null };
    return { state: value.logo ? 'captured' : 'captured_none', image: value.logo || null };
}
module.exports = { capture, saved };

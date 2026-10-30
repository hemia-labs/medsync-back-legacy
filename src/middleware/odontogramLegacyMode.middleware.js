'use strict';
const { getBusinessIdFromToken } = require('../util/tenant');
module.exports = async function legacyMode(req, res, next) {
    try {
        const mode = await require('../Dao/mysql/odontogramV2.dao').mode(getBusinessIdFromToken(req.tokenDecode));
        if (mode !== 'v1') return res.status(409).send({ status: 409, code: 'CO26_LEGACY_WRITE_BLOCKED', message: 'Recarga el expediente para usar el odontograma CO26.' });
        next();
    } catch (error) {
        // Unmigrated installations retain v1. Other failures never bypass the gate.
        if (['ER_BAD_FIELD_ERROR', 'ER_NO_SUCH_TABLE'].includes(error.code || error.original && error.original.code)) return next();
        next(error);
    }
};

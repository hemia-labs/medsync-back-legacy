'use strict';
const { QueryTypes, Transaction } = require('sequelize');

async function beginLicenseMutation(db, idBusiness) {
    if (!idBusiness) throw new Error('LICENSE_BUSINESS_REQUIRED');
    const transaction = await db.transaction({ isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED });
    try {
        const rows = await db.query('SELECT id_business FROM business WHERE id_business = :business FOR UPDATE', {
            replacements: { business: idBusiness }, type: QueryTypes.SELECT, transaction
        });
        if (!rows.length) throw new Error('LICENSE_BUSINESS_NOT_FOUND');
        return transaction;
    } catch (error) { await transaction.rollback(); throw error; }
}

module.exports = { beginLicenseMutation };

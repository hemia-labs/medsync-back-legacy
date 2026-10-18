const effectivePermissions = require('../../util/effectivePermissions');
const { QueryTypes } = require('sequelize');
const sequelize = require('../../db/Sequelize.connection');
const responseData = require('../../util/responsedata');
const Messages = require('../../util/common.messages.util');
const { SequelizeException } = require('../../util/sequelizeException');
const { validateBusinessProfile } = require('../../validators/business.validator');

function pickBusinessProfileUpdates(body = {}, current = {}) {
    const has = (field) => Object.prototype.hasOwnProperty.call(body, field);
    const pick = (field, fallback) => has(field) ? body[field] : fallback;

    return {
        name: pick('name', current.name || ''),
        legalName: pick('legalName', has('legal_name') ? body.legal_name : current.legalName || null),
        email: pick('email', current.email || null),
        phone: pick('phone', current.phone || null),
        address: pick('address', current.address || null),
        logoUrl: pick('logoUrl', has('logo_url') ? body.logo_url : current.logoUrl || null)
    };
}

class BusinessDao {
    async get(idBusiness) {
        try {
            const result = await sequelize.query(
                `SELECT id_business, name, legal_name AS legalName, slug, email, phone, address, logo_url AS logoUrl,
                        status, subscription_status AS subscriptionStatus, trial_starts_at AS trialStartsAt,
                        trial_ends_at AS trialEndsAt, current_period_starts_at AS currentPeriodStartsAt,
                        current_period_ends_at AS currentPeriodEndsAt,
                        plan, active, created_at AS createdAt, updated_at AS updatedAt
                   FROM business
                  WHERE id_business = :_id_business
                  LIMIT 1`,
                { replacements: { _id_business: idBusiness }, type: QueryTypes.SELECT }
            );
            return responseData.success(result[0] || null, Messages.DATA_GET_SUCCESSFULLY);
        } catch (error) {
            return SequelizeException(error, Messages.DATA_GET_ERROR);
        }
    }

    async update(idBusiness, body) {
        try {
            const currentResponse = await this.get(idBusiness);
            if(!currentResponse || currentResponse.status !== 200 || !currentResponse.data) return responseData.error('No se pudo consultar el consultorio antes de guardar. Tus cambios no se guardaron; reintenta.');
            const current = currentResponse.data;
            const validation = validateBusinessProfile(pickBusinessProfileUpdates(body, current));
            if(!validation.isValid) return responseData.bad_request(validation.message, { fieldErrors: validation.fieldErrors });
            const updates = validation.data;

            await sequelize.query(
                `UPDATE business
                    SET name = :_name,
                        legal_name = :_legal_name,
                        email = :_email,
                        phone = :_phone,
                        address = :_address,
                        logo_url = :_logo_url,
                        updated_at = NOW(),
                        updated_by = :_updated_by
                  WHERE id_business = :_id_business`,
                {
                    replacements: {
                        _id_business: idBusiness,
                        _name: updates.name,
                        _legal_name: updates.legalName || null,
                        _email: updates.email || null,
                        _phone: updates.phone || null,
                        _address: updates.address || null,
                        _logo_url: updates.logoUrl || null,
                        _updated_by: body.id_login || null
                    },
                    type: QueryTypes.UPDATE
                }
            );
            return this.get(idBusiness);
        } catch (error) {
            return SequelizeException(error, Messages.DATA_SAVE_ERROR);
        }
    }

    async hasPermission(idLogin, permission) {
        return effectivePermissions.hasPermission(idLogin, permission, {enabledCatalog:false});
    }
}

module.exports = new BusinessDao();

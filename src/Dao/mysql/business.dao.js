const privateImages = require('../../services/aws/privateImages');
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
            const candidate = pickBusinessProfileUpdates(body, current);
            // A saved private key is retained internally; clients never submit bearer URLs.
            if (privateImages.isPrivateKey(current.logoUrl)) {
                if (Object.hasOwn(body, 'logoUrl') || Object.hasOwn(body, 'logo_url')) return responseData.bad_request('Usa la carga de logo para modificar esta imagen.');
                candidate.logoUrl = '';
            }
            const validation = validateBusinessProfile(candidate);
            if(!validation.isValid) return responseData.bad_request(validation.message, { fieldErrors: validation.fieldErrors });
            const updates = validation.data;
            if (privateImages.isPrivateKey(current.logoUrl)) updates.logoUrl = current.logoUrl;

            await sequelize.query(
                `UPDATE business
                    SET name = :_name,
                        legal_name = :_legal_name,
                        email = :_email,
                        phone = :_phone,
                        address = :_address,
                        ${Object.hasOwn(body, 'logoUrl') || Object.hasOwn(body, 'logo_url') ? 'logo_url = :_logo_url,' : ''}
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

    async updateLogo(idBusiness, body, remove = false) {
        let transaction, uploaded, previous, committed = false, commitAttempted = false;
        try {
            transaction = await sequelize.transaction();
            const rows = await sequelize.query('SELECT logo_url FROM business WHERE id_business = :business AND active = 1 FOR UPDATE', {
                replacements: { business: idBusiness }, type: QueryTypes.SELECT, transaction
            });
            if (!rows[0]) return responseData.notSuccess('Consultorio no disponible.');
            previous = rows[0].logo_url;
            if (!remove) uploaded = await privateImages.upload(body.image, idBusiness);
            await sequelize.query('UPDATE business SET logo_url = :logo, updated_at = NOW(), updated_by = :actor WHERE id_business = :business', {
                replacements: { business: idBusiness, actor: body.id_login, logo: uploaded ? uploaded.Key : null }, type: QueryTypes.UPDATE, transaction
            });
            commitAttempted = true;
            await transaction.commit();
            transaction = null; committed = true;
            await privateImages.remove(previous, idBusiness);
            return this.get(idBusiness);
        } catch (error) {
            return error.status === 400 ? responseData.bad_request(error.message) : SequelizeException(error, Messages.DATA_SAVE_ERROR);
        } finally {
            if (transaction && !transaction.finished) await transaction.rollback();
            if (uploaded && !committed) {
                if (commitAttempted) await privateImages.pending(uploaded);
                else await privateImages.remove(uploaded.Key, idBusiness);
            }
        }
    }

    async hasPermission(idLogin, permission) {
        return effectivePermissions.hasPermission(idLogin, permission, {enabledCatalog:false});
    }
}

module.exports = new BusinessDao();

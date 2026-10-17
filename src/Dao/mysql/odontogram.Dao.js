const { QueryTypes } = require('sequelize');
const { v4: uuid } = require('uuid');
const sequelize = require('../../db/Sequelize.connection');
const SequelizeSP = require('../../util/sequelize.sp.util');
const responseData = require('../../util/responsedata');
const Messages = require('../../util/common.messages.util');
const { SequelizeException, SQLException } = require('../../util/sequelizeException');
const eq = (left, right) => `${left} COLLATE utf8mb4_unicode_ci = ${right} COLLATE utf8mb4_unicode_ci`;
const validId = id => typeof id === 'string' && id.trim().length > 0 && id.length <= 50;
const rejectOdontogram = (message, status = 400) => {
    const error = new Error(message);
    error.odontogramResponse = { status, data: null, message };
    throw error;
};


/**
 * Clase principal
 */
class OdontogramDao {

    /**
     * Permite obtener la configuración de un diente
     * @param {String} id_person id del px
     * @param {String} id_tooth id del diente
     * @returns 
     */
    async getbytooth(id_person, id_tooth) {
        let response;
        try {
            let result = await sequelize.query(SequelizeSP.SP_ODONTOGRAM_GET, {
                replacements: {
                    _id_person: id_person,
                    _id_tooth: id_tooth
                },
                type: QueryTypes.RAW,
                plain: true
            });

            if (result) {/*Validamos si existe un registro de salida */
                let SQLValid = SQLException(result);

                let newData = result.map((x) => {
                    return {
                        ...x,
                        config: JSON.parse(x.config)
                    }
                });

                response = !SQLValid.hasError ? responseData.success(newData[0], Messages.DATA_GET_SUCCESSFULLY) : responseData.notSuccess(Messages.DATA_GET_ERROR);
            }
            else {/* regresamos una excepción controlada al no obtener una respuesta */
                response = responseData.notSuccess(Messages.DATA_GET_ERROR)
            }
        } catch (error) {
            response = SequelizeException(error, Messages.DATA_GET_ERROR);
        }
        return response;
    }

    /**
     * Permite guardar la configuración de un diente
     * @param {Object} body Payload
     * @returns 
     */
    async savetooth(body) {
        let response;
        try {


            if (!Array.isArray(body.config)) throw new Error("Parameter config is not a Array!");

            const _json = JSON.stringify(body.config);
            let result = await sequelize.query(SequelizeSP.SP_ODONTOGRAM_SAVE, {
                replacements: {
                    _id_person: body.id_person,
                    _id_tooth: body.id_tooth,
                    _symbol: body.symbol,
                    _observation: body.observation,
                    _json: _json,
                    _id_user: body.id_login
                },
                type: QueryTypes.RAW,
                plain: true
            });

            if (result) {/*Validamos si existe un registro de salida */
                let SQLValid = SQLException(result);
                response = !SQLValid.hasError ? responseData.success(result, Messages.DATA_GET_SUCCESSFULLY) : responseData.notSuccess(Messages.DATA_GET_ERROR);
            }
            else {/* regresamos una excepción controlada al no obtener una respuesta */
                response = responseData.notSuccess(Messages.DATA_GET_ERROR)
            }
        } catch (error) {
            response = SequelizeException(error, Messages.DATA_GET_ERROR);
        }
        return response;
    }

    /**
     * Permite actualizar la configuración de un diente
     * @param {Object} body Payload
     * @returns 
     */
    async updatetooth(body) {
        let response;
        try {

            if (!Array.isArray(body.config)) throw new Error("Parameter config is not a Array!");

            const _json = JSON.stringify(body.config);
            let result = await sequelize.query(SequelizeSP.SP_ODONTOGRAM_UPDATE, {
                replacements: {
                    _id_odontogram: body.id_odontogram,
                    _id_person: body.id_person,
                    _id_tooth: body.id_tooth,
                    _symbol: body.symbol,
                    _observation: body.observation,
                    _json: _json,
                    _id_user: body.id_login
                },
                type: QueryTypes.RAW,
                plain: true
            });

            if (result) {/*Validamos si existe un registro de salida */
                let SQLValid = SQLException(result);
                response = !SQLValid.hasError ? responseData.success(result, Messages.DATA_GET_SUCCESSFULLY) : responseData.notSuccess(Messages.DATA_GET_ERROR);
            }
            else {/* regresamos una excepción controlada al no obtener una respuesta */
                response = responseData.notSuccess(Messages.DATA_GET_ERROR)
            }
        } catch (error) {
            response = SequelizeException(error, Messages.DATA_GET_ERROR);
        }
        return response;
    }


    /**
     * Obtiene la configuración de los tipos de odontograma
     * @returns 
     */
    async getCatTypeTooth() {
        let response;
        try {
            let result = await sequelize.query(SequelizeSP.SP_CAT_TYPE_TOOTH_GET, {
                replacements: {},
                type: QueryTypes.RAW,
                plain: true
            });

            if (result) {/*Validamos si existe un registro de salida */
                let SQLValid = SQLException(result);
                response = !SQLValid.hasError ? responseData.success(result, Messages.DATA_GET_SUCCESSFULLY) : responseData.notSuccess(Messages.DATA_GET_ERROR);
            }
            else {/* regresamos una excepción controlada al no obtener una respuesta */
                response = responseData.notSuccess(Messages.DATA_GET_ERROR)
            }
        } catch (error) {
            response = SequelizeException(error, Messages.DATA_GET_ERROR);
        }
        return response;
    }

    async queryV1(sql, replacements, transaction = null) {
        return sequelize.query(sql, { replacements, type: /^\s*SELECT\b/i.test(sql) ? QueryTypes.SELECT : QueryTypes.RAW, transaction });
    }

    // Keep v1 SQL explicit: older installed routines declare parameters with a
    // different collation from the clinical tables and can return SHOW ERRORS
    // as successful data. Serialize mutations on the owning patient instead.
    async mutateV1(body, operation) {
        let transaction;
        try {
            if (!validId(body.id_login)) rejectOdontogram('Usuario no disponible.', 403);
            transaction = await sequelize.transaction();
            let patient = body.id_person;
            if (!patient && validId(body.id_odontogramv1)) {
                const rows = await this.queryV1(`SELECT id_person FROM odontogramv1 WHERE ${eq('id_odontogramv1', ':chart')} LIMIT 1`, { chart: body.id_odontogramv1 }, transaction);
                patient = rows[0] && rows[0].id_person;
            }
            if (!validId(patient)) rejectOdontogram('No se encontro el paciente del odontograma.', 403);
            const patients = await this.queryV1(`SELECT p.id_person, p.id_business FROM person p
                WHERE ${eq('p.id_person', ':patient')} AND p.active = 1
                  AND ${eq('p.id_business', '(SELECT l.id_business FROM login l WHERE ' + eq('l.id_login', ':actor') + ' AND l.active = 1 LIMIT 1)')}
                FOR UPDATE`, { patient, actor: body.id_login }, transaction);
            if (!patients[0]) rejectOdontogram('El paciente no esta disponible en este consultorio.', 403);
            const result = await operation({ patient, business: patients[0].id_business, actor: body.id_login, transaction });
            await transaction.commit();
            return responseData.success(result, Messages.DATA_GET_SUCCESSFULLY);
        } catch (error) {
            if (transaction && !transaction.finished) await transaction.rollback();
            return error.odontogramResponse || SequelizeException(error, Messages.DATA_GET_ERROR);
        }
    }

    async activeV1(patient, transaction = null) {
        return this.queryV1(`SELECT id_odontogramv1, id_person, type, active FROM odontogramv1
            WHERE ${eq('id_person', ':patient')} AND active = 1 AND is_active = 1
            ORDER BY created_at DESC, id_odontogramv1 LIMIT 1${transaction ? ' FOR UPDATE' : ''}`, { patient }, transaction);
    }

    async validateOdontogramv1(id_person) {
        try {
            const rows = await this.activeV1(id_person);
            const row = rows[0];
            return responseData.success(row ? { id_odontogramv1: row.id_odontogramv1, type: row.type, active: 1 }
                : { id_odontogramv1: null, type: 'C4CA42', active: 0 }, Messages.DATA_GET_SUCCESSFULLY);
        } catch (error) { return SequelizeException(error, Messages.DATA_GET_ERROR); }
    }

    async saveOdontogramv1(body) {
        return this.mutateV1(body, async ({ patient, business, actor, transaction }) => {
            if (body.expand && body.expand !== 'INDICARTOR_DISABLED') rejectOdontogram('Missing key expand');
            if (typeof body.type !== 'string') rejectOdontogram('Tipo de odontograma invalido.');
            const types = await this.queryV1(`SELECT code FROM cat_type_tooth WHERE ${eq('code', ':type')} LIMIT 1`, { type: body.type }, transaction);
            if (!types[0]) rejectOdontogram('No se encontro el tipo de odontograma.');
            const active = await this.activeV1(patient, transaction);
            if (active.length && body.expand !== 'INDICARTOR_DISABLED') rejectOdontogram('Ya se cuenta con un odontograma activo.', 409);
            await this.queryV1(`UPDATE odontogramv1 SET active=0, updated_at=NOW(), updated_by=:actor
                WHERE ${eq('id_person', ':patient')} AND active=1 AND is_active=1`, { patient, actor }, transaction);
            const chart = uuid();
            await this.queryV1(`INSERT INTO odontogramv1 (id_odontogramv1,id_business,id_person,type,active,is_active,created_at,created_by)
                VALUES (:chart,:business,:patient,:type,1,1,NOW(),:actor)`, { chart, business, patient, type: types[0].code, actor }, transaction);
            return { id_odontogramv1: chart, id_person: patient, type: types[0].code };
        });
    }

    async getOdontogramv1(id_person) {
        try {
            const rows = await this.queryV1(`SELECT ct.id_tooth, ct.description, ct.sec, ct.\`order\`,
                x.description AS ejex, y.description AS ejey, type.description AS type, ordering.sec AS cuadrante,
                detail.treatment, detail.id_odontogram_detailv1
                FROM odontogramv1 chart
                INNER JOIN cat_type_tooth type ON ${eq('type.code', 'chart.type')}
                INNER JOIN cat_tooth ct ON ${eq('ct.id_cat_type_tooth', 'type.id_cat_type_tooth')}
                INNER JOIN cat_x_position_tooth x ON ${eq('x.id_cat_x_position_tooth', 'ct.id_cat_x_position_tooth')}
                INNER JOIN cat_y_position_tooth y ON ${eq('y.id_cat_y_position_tooth', 'ct.id_cat_y_position_tooth')}
                INNER JOIN cat_order_tooth ordering ON ${eq('ordering.id_cat_order_tooth', 'ct.id_cat_order_tooth')}
                LEFT JOIN odontogramDetailv1 detail ON ${eq('detail.id_odontogramv1', 'chart.id_odontogramv1')}
                  AND ${eq('detail.id_tooth', 'ct.id_tooth')} AND detail.active=1 AND detail.is_active=1
                WHERE chart.id_odontogramv1 COLLATE utf8mb4_unicode_ci = (
                    SELECT current_chart.id_odontogramv1 FROM odontogramv1 current_chart
                    WHERE ${eq('current_chart.id_person', ':patient')} AND current_chart.active=1 AND current_chart.is_active=1
                    ORDER BY current_chart.created_at DESC,current_chart.id_odontogramv1 LIMIT 1
                ) COLLATE utf8mb4_unicode_ci
                ORDER BY ordering.sec, ct.\`order\``, { patient: id_person });
            return responseData.success(rows, Messages.DATA_GET_SUCCESSFULLY);
        } catch (error) { return SequelizeException(error, Messages.DATA_GET_ERROR); }
    }

    async saveOdontogramvDetailv1(body) {
        return this.mutateV1(body, async ({ patient, business, actor, transaction }) => {
            if (!validId(body.id_tooth) || typeof body.treatment !== 'string' || !body.treatment.trim() || body.treatment.length > 1000) {
                rejectOdontogram('Indica una region dental y un diagnostico de hasta 1000 caracteres.');
            }
            const active = (await this.activeV1(patient, transaction))[0];
            if (!active) rejectOdontogram('No se cuenta con un odontograma activo.', 409);
            const teeth = await this.queryV1(`SELECT ct.id_tooth FROM cat_tooth ct
                INNER JOIN cat_type_tooth type ON ${eq('type.id_cat_type_tooth', 'ct.id_cat_type_tooth')}
                WHERE ${eq('ct.id_tooth', ':tooth')} AND ${eq('type.code', ':type')} LIMIT 1`, { tooth: body.id_tooth, type: active.type }, transaction);
            if (!teeth[0]) rejectOdontogram('La region dental no pertenece al tipo de odontograma.');
            let detail;
            if (body.id_odontogram_detailv1) {
                if (!validId(body.id_odontogram_detailv1)) rejectOdontogram('Detalle de odontograma invalido.');
                detail = (await this.queryV1(`SELECT id_odontogram_detailv1 FROM odontogramDetailv1
                    WHERE ${eq('id_odontogram_detailv1', ':detail')} AND ${eq('id_odontogramv1', ':chart')}
                      AND ${eq('id_tooth', ':tooth')} AND active=1 AND is_active=1 LIMIT 1 FOR UPDATE`,
                { detail: body.id_odontogram_detailv1, chart: active.id_odontogramv1, tooth: body.id_tooth }, transaction))[0];
                if (!detail) rejectOdontogram('El diagnostico no pertenece al odontograma activo.', 409);
            } else {
                // Retry without the returned detail id updates the same tooth;
                // the patient lock prevents two inserts racing each other.
                detail = (await this.queryV1(`SELECT id_odontogram_detailv1 FROM odontogramDetailv1
                    WHERE ${eq('id_odontogramv1', ':chart')} AND ${eq('id_tooth', ':tooth')}
                      AND active=1 AND is_active=1 ORDER BY created_at, id_odontogram_detailv1 LIMIT 1 FOR UPDATE`,
                { chart: active.id_odontogramv1, tooth: body.id_tooth }, transaction))[0];
            }
            const id = detail ? detail.id_odontogram_detailv1 : uuid();
            if (detail) {
                await this.queryV1(`UPDATE odontogramDetailv1 SET treatment=:treatment, updated_at=NOW(), updated_by=:actor
                    WHERE ${eq('id_odontogram_detailv1', ':detail')}`, { treatment: body.treatment, actor, detail: id }, transaction);
            } else {
                await this.queryV1(`INSERT INTO odontogramDetailv1 (id_odontogram_detailv1,id_business,id_odontogramv1,id_tooth,treatment,active,is_active,created_at,created_by)
                    VALUES (:detail,:business,:chart,:tooth,:treatment,1,1,NOW(),:actor)`,
                { detail: id, business, chart: active.id_odontogramv1, tooth: body.id_tooth, treatment: body.treatment, actor }, transaction);
            }
            return { id_odontogram_detailv1: id, id_tooth: body.id_tooth, treatment: body.treatment };
        });
    }

    async getHistoryv1(id_person) {
        try {
            // Odontogram DATETIME values are written by the Sequelize UTC session
            // (NOW()). Preserve the legacy field and expose the instant plus the
            // clinic timezone; clients must not treat the UTC day as a local day.
            const rows = await this.queryV1(`SELECT chart.id_odontogramv1, chart.active, type.code, type.description,
                DATE_FORMAT(chart.created_at,'%d-%m-%Y %H:%i:%s') AS created_at,
                DATE_FORMAT(chart.created_at,'%Y-%m-%dT%H:%i:%s.000Z') AS created_at_utc,
                COALESCE((SELECT config.timezone FROM appointment_config config
                    WHERE ${eq('config.id_business', 'chart.id_business')} AND config.doctor_profile_id IS NULL AND config.active=1
                    ORDER BY config.created_at DESC LIMIT 1), 'America/Mexico_City') AS timezone
                FROM odontogramv1 chart INNER JOIN cat_type_tooth type ON ${eq('type.code', 'chart.type')}
                WHERE ${eq('chart.id_person', ':patient')} AND chart.is_active=1
                ORDER BY chart.created_at, chart.id_odontogramv1`, { patient: id_person });
            return responseData.success(rows, Messages.DATA_GET_SUCCESSFULLY);
        } catch (error) { return SequelizeException(error, Messages.DATA_GET_ERROR); }
    }

    async updateStatusOdontogramV1(body) {
        return this.mutateV1(body, async ({ patient, actor, transaction }) => {
            if (typeof body.active !== 'boolean') rejectOdontogram('Campo invalido: active');
            const chart = (await this.queryV1(`SELECT id_odontogramv1,type FROM odontogramv1
                WHERE ${eq('id_odontogramv1', ':chart')} AND ${eq('id_person', ':patient')} AND is_active=1 LIMIT 1 FOR UPDATE`,
            { chart: body.id_odontogramv1, patient }, transaction))[0];
            if (!chart) rejectOdontogram('No se encontro un odontograma disponible.');
            if (body.active) {
                await this.queryV1(`UPDATE odontogramv1 SET active=0, updated_at=NOW(), updated_by=:actor
                    WHERE ${eq('id_person', ':patient')} AND active=1 AND is_active=1`, { patient, actor }, transaction);
            }
            await this.queryV1(`UPDATE odontogramv1 SET active=:active, updated_at=NOW(), updated_by=:actor
                WHERE ${eq('id_odontogramv1', ':chart')}`, { active: body.active ? 1 : 0, actor, chart: chart.id_odontogramv1 }, transaction);
            return { ...chart, active: body.active ? 1 : 0 };
        });
    }

    async deleteOdontogramV1(body) {
        return this.mutateV1(body, async ({ patient, actor, transaction }) => {
            const chart = (await this.queryV1(`SELECT id_odontogramv1,type FROM odontogramv1
                WHERE ${eq('id_odontogramv1', ':chart')} AND ${eq('id_person', ':patient')} LIMIT 1 FOR UPDATE`,
            { chart: body.id_odontogramv1, patient }, transaction))[0];
            if (!chart) rejectOdontogram('No se encontro el odontograma.');
            await this.queryV1(`UPDATE odontogramv1 SET active=0,is_active=0,updated_at=NOW(),updated_by=:actor
                WHERE ${eq('id_odontogramv1', ':chart')}`, { chart: chart.id_odontogramv1, actor }, transaction);
            await this.queryV1(`UPDATE odontogramDetailv1 SET active=0,is_active=0,updated_at=NOW(),updated_by=:actor
                WHERE ${eq('id_odontogramv1', ':chart')}`, { chart: chart.id_odontogramv1, actor }, transaction);
            return { ...chart, active: 0 };
        });
    }

}

module.exports = new OdontogramDao;

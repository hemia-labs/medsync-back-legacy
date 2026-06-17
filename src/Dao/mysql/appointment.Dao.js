const { QueryTypes } = require('sequelize');
const sequelize = require('../../db/Sequelize.connection');
const SequelizeSP = require('../../util/sequelize.sp.util');
const responseData = require('../../util/responsedata');
const Messages = require('../../util/common.messages.util');
const {SequelizeException, SQLException} = require('../../util/sequelizeException');

const TENANT_COLLATION = 'utf8mb4_unicode_ci';
const collatedText = (value) => {
    const expression = String(value || '').trim();
    return expression.startsWith(':')
        ? `CONVERT(${expression} USING utf8mb4) COLLATE ${TENANT_COLLATION}`
        : `${expression} COLLATE ${TENANT_COLLATION}`;
};
const collateEq = (left, param) => `${collatedText(left)} = ${collatedText(param)}`;
const DEFAULT_PATIENT_HISTORY_LIMIT = 8;
const MAX_PATIENT_HISTORY_LIMIT = 50;
const APPOINTMENT_BLOCKING_STATUSES = Object.freeze(['pending_confirmation', 'confirmed', 'completed']);
const APPOINTMENT_NON_BLOCKING_STATUSES = Object.freeze(['cancelled', 'rescheduled', 'no_show']);
const MAX_CONTACT_PHONE_LENGTH = 40;

function normalizeInteger(value, fallback, min, max) {
    const parsed = Number.parseInt(value, 10);
    if(Number.isNaN(parsed)) {
        return fallback;
    }

    return Math.min(Math.max(parsed, min), max);
}

function appointmentBlocksAvailability(status, storedValue) {
    if(APPOINTMENT_NON_BLOCKING_STATUSES.includes(status)) {
        return false;
    }

    if(APPOINTMENT_BLOCKING_STATUSES.includes(status)) {
        return true;
    }

    return storedValue === true || storedValue === 1 || storedValue === '1';
}

function normalizeContactPhone(value) {
    const phone = String(value || '').trim();
    return phone ? phone : null;
}

class AppointmentDao{

    async getConfig(id_business) {
        let response;
        try {
            const result = await sequelize.query(SequelizeSP.SP_APPOINTMENT_CONFIG_GET, {
                replacements: { _id_business: id_business },
                type: QueryTypes.RAW,
                plain: true
            });

            const config = this.parseConfig(result);
            response = responseData.success(config, Messages.DATA_GET_SUCCESSFULLY);
        } catch (error) {
            response = SequelizeException(error, Messages.DATA_GET_ERROR);
        }
        return response;
    }

    async saveConfig(body) {
        let response;
        try {
            const result = await sequelize.query(SequelizeSP.SP_APPOINTMENT_CONFIG_SAVE, {
                replacements: {
                    _config: body.config ? JSON.stringify(body.config) : JSON.stringify(body),
                    _id_login: body.id_login,
                    _id_business: body.id_business
                },
                type: QueryTypes.RAW,
                plain: true
            });

            const config = this.parseConfig(result);
            response = responseData.success(config, Messages.DATA_GET_SUCCESSFULLY);
        } catch (error) {
            response = SequelizeException(error, Messages.DATA_GET_ERROR);
        }
        return response;
    }

    async list(body) {
        let response;
        try {
            const result = await sequelize.query(SequelizeSP.SP_APPOINTMENT_LIST, {
                replacements: {
                    _date_from: body.date_from || null,
                    _date_to: body.date_to || null,
                    _id_person: body.id_person || null,
                    _id_business: body.id_business
                },
                type: QueryTypes.RAW
            });

            if(result){
                const SQLValid = SQLException(result);
                response = !SQLValid.hasError ? responseData.success(this.normalizeAppointmentRows(this.normalizeResultRows(result)), Messages.DATA_GET_SUCCESSFULLY) : responseData.notSuccess(Messages.DATA_GET_ERROR);
            }
            else{
                response = responseData.success([], Messages.DATA_GET_SUCCESSFULLY);
            }
        } catch (error) {
            response = SequelizeException(error, Messages.DATA_GET_ERROR);
        }
        return response;
    }

    async save(body) {
        let response;
        try {
            const appointment = this.normalizeAppointmentPayload(body.appointment || body);
            const validationResponse = await this.validateAppointmentPayload(appointment, body.id_business);
            if(validationResponse) {
                return validationResponse;
            }

            const conflictResponse = await this.validateAvailabilityConflict(appointment, body.id_business);
            if(conflictResponse) {
                return conflictResponse;
            }

            const result = await sequelize.query(SequelizeSP.SP_APPOINTMENT_SAVE, {
                replacements: {
                    _appointment: JSON.stringify(appointment),
                    _id_login: body.id_login,
                    _id_business: body.id_business
                },
                type: QueryTypes.RAW,
                plain: true
            });

            const rows = this.normalizeAppointmentRows(this.normalizeResultRows(result));

            if(rows.length){
                const SQLValid = SQLException(rows);
                response = !SQLValid.hasError ? responseData.success(rows, Messages.DATA_GET_SUCCESSFULLY) : responseData.notSuccess(SQLValid.message || Messages.DATA_GET_ERROR);
            }
            else{
                response = responseData.notSuccess(Messages.DATA_SAVE_ERROR, []);
            }
        } catch (error) {
            response = SequelizeException(error, Messages.DATA_GET_ERROR);
        }
        return response;
    }

    async delete(body) {
        let response;
        try {
            const result = await sequelize.query(SequelizeSP.SP_APPOINTMENT_DELETE, {
                replacements: {
                    _id_appointment: body.id_appointment,
                    _id_login: body.id_login,
                    _id_business: body.id_business
                },
                type: QueryTypes.RAW,
                plain: true
            });

            response = responseData.success(result, Messages.DATA_GET_SUCCESSFULLY);
        } catch (error) {
            response = SequelizeException(error, Messages.DATA_GET_ERROR);
        }
        return response;
    }

    async patientHistory(body) {
        let response;
        try {
            const patientId = body.patient_id || body.id_person || body.patientId;
            const businessId = body.id_business;

            if(!patientId || !businessId) {
                return responseData.bad_request('Paciente y negocio son requeridos.');
            }

            const patientRows = await sequelize.query(
                `SELECT p.id_person
                   FROM person p
                  WHERE ${collateEq('p.id_person', ':_id_person')}
                    AND ${collateEq('p.id_business', ':_id_business')}
                  LIMIT 1`,
                {
                    replacements: {
                        _id_person: patientId,
                        _id_business: businessId
                    },
                    type: QueryTypes.SELECT
                }
            );

            if(!patientRows.length) {
                return responseData.forbidden('Paciente no disponible para este consultorio.');
            }

            const limit = normalizeInteger(body.limit, DEFAULT_PATIENT_HISTORY_LIMIT, 1, MAX_PATIENT_HISTORY_LIMIT);
            const offset = normalizeInteger(body.offset, 0, 0, 100000);
            const rows = await sequelize.query(
                `SELECT
                    a.id_appointment AS id,
                    a.id_person AS patientId,
                    COALESCE(NULLIF(a.patient_name, ''), TRIM(CONCAT(IFNULL(p.name, ''), ' ', IFNULL(p.surname, '')))) AS patientName,
                    COALESCE(NULLIF(a.contact_phone, ''), NULLIF(p.telephone, ''), NULLIF(p.local_telephone, '')) AS contactPhone,
                    a.id_tracing AS followUpId,
                    DATE_FORMAT(a.appointment_date, '%Y-%m-%d') AS date,
                    DATE_FORMAT(a.start_time, '%H:%i') AS startTime,
                    DATE_FORMAT(a.end_time, '%H:%i') AS endTime,
                    a.status,
                    a.title,
                    a.description,
                    a.source,
                    a.cancellation_reason AS cancellationReason,
                    a.rescheduled_from_appointment_id AS rescheduledFromAppointmentId,
                    a.rescheduled_to_appointment_id AS rescheduledToAppointmentId,
                    a.blocks_availability AS blocksAvailability,
                    a.created_at AS createdAt,
                    a.updated_at AS updatedAt,
                    creator.name AS createdByName,
                    updater.name AS updatedByName
                   FROM appointment a
              LEFT JOIN person p
                     ON ${collateEq('p.id_person', 'a.id_person')}
                    AND ${collateEq('p.id_business', 'a.id_business')}
              LEFT JOIN login creator
                     ON ${collateEq('creator.id_login', 'a.created_by')}
                    AND (${collateEq('creator.id_business', 'a.id_business')} OR creator.id_business IS NULL)
              LEFT JOIN login updater
                     ON ${collateEq('updater.id_login', 'a.updated_by')}
                    AND (${collateEq('updater.id_business', 'a.id_business')} OR updater.id_business IS NULL)
                  WHERE a.active = 1
                    AND ${collateEq('a.id_business', ':_id_business')}
                    AND ${collateEq('a.id_person', ':_id_person')}
               ORDER BY a.appointment_date DESC, a.start_time DESC, a.created_at DESC
                  LIMIT ${limit + 1}
                 OFFSET ${offset}`,
                {
                    replacements: {
                        _id_person: patientId,
                        _id_business: businessId
                    },
                    type: QueryTypes.SELECT
                }
            );

            const hasMore = rows.length > limit;
            const appointments = this.normalizeAppointmentRows(hasMore ? rows.slice(0, limit) : rows);

            response = responseData.success({
                appointments,
                pagination: {
                    limit,
                    offset,
                    count: appointments.length,
                    hasMore,
                    nextOffset: offset + appointments.length
                }
            }, Messages.DATA_GET_SUCCESSFULLY);
        } catch (error) {
            response = SequelizeException(error, Messages.DATA_GET_ERROR);
        }
        return response;
    }

    async validateAvailabilityConflict(appointment, businessId) {
        const status = appointment ? appointment.status : null;

        if(!appointmentBlocksAvailability(status, appointment ? appointment.blocksAvailability : null)) {
            return null;
        }

        const appointmentDate = appointment.date || appointment.appointment_date;
        const startTime = appointment.startTime || appointment.start_time;
        const endTime = appointment.endTime || appointment.end_time;

        if(!businessId || !appointmentDate || !startTime || !endTime) {
            return null;
        }

        const rows = await sequelize.query(
            `SELECT 1
               FROM appointment a
              WHERE a.active = 1
                AND ${collateEq('a.id_business', ':_id_business')}
                AND a.appointment_date = :_appointment_date
                AND (:_id_appointment IS NULL OR NOT (${collateEq('a.id_appointment', ':_id_appointment')}))
                AND (a.status IN ('pending_confirmation', 'confirmed', 'completed') OR a.blocks_availability = 1)
                AND TIME(:_start_time) < a.end_time
                AND TIME(:_end_time) > a.start_time
              LIMIT 1`,
            {
                replacements: {
                    _id_business: businessId,
                    _id_appointment: appointment.id || appointment.id_appointment || null,
                    _appointment_date: appointmentDate,
                    _start_time: startTime,
                    _end_time: endTime
                },
                type: QueryTypes.SELECT
            }
        );

        return rows.length ? responseData.bad_request('Este horario ya esta ocupado.') : null;
    }

    normalizeAppointmentPayload(appointment) {
        const nextAppointment = Object.assign({}, appointment || {});
        const contactPhone = normalizeContactPhone(nextAppointment.contactPhone || nextAppointment.contact_phone);
        nextAppointment.contactPhone = contactPhone;
        return nextAppointment;
    }

    async validateAppointmentPayload(appointment, businessId) {
        if(!appointment || !businessId) {
            return responseData.bad_request('Cita y negocio son requeridos.');
        }

        const contactPhone = normalizeContactPhone(appointment.contactPhone);
        const patientId = appointment.patientId || appointment.id_person || null;
        const appointmentId = appointment.id || appointment.id_appointment || null;

        if(contactPhone && contactPhone.length > MAX_CONTACT_PHONE_LENGTH) {
            return responseData.bad_request(`Telefono de contacto maximo ${MAX_CONTACT_PHONE_LENGTH} caracteres.`);
        }

        if(patientId) {
            const patientRows = await sequelize.query(
                `SELECT 1
                   FROM person p
                  WHERE ${collateEq('p.id_person', ':_id_person')}
                    AND ${collateEq('p.id_business', ':_id_business')}
                    AND p.active = 1
                  LIMIT 1`,
                {
                    replacements: {
                        _id_person: patientId,
                        _id_business: businessId
                    },
                    type: QueryTypes.SELECT
                }
            );

            if(!patientRows.length) {
                return responseData.forbidden('Paciente no disponible para este consultorio.');
            }
        }

        if(!appointmentId && !patientId && !contactPhone) {
            return responseData.bad_request('Telefono de contacto requerido para citas de pacientes no registrados.');
        }

        return null;
    }

    normalizeAppointmentRows(rows) {
        if(!Array.isArray(rows)) {
            return rows;
        }

        return rows.map((row) => this.normalizeAppointmentRow(row));
    }

    normalizeAppointmentRow(row) {
        if(!row || typeof row !== 'object') {
            return row;
        }

        const status = row.status || row.appointment_status;
        const storedValue = row.blocksAvailability !== undefined ? row.blocksAvailability : row.blocks_availability;
        return {
            ...row,
            contactPhone: row.contactPhone !== undefined ? row.contactPhone : row.contact_phone || null,
            blocksAvailability: appointmentBlocksAvailability(status, storedValue) ? 1 : 0
        };
    }

    normalizeResultRows(result) {
        if(!result) {
            return [];
        }

        if(Array.isArray(result)) {
            return Array.isArray(result[0]) ? result[0] : result;
        }

        return [result];
    }

    parseConfig(result) {
        if(!result) {
            return null;
        }

        const rawConfig = result.config || result[0] && result[0].config;
        if(!rawConfig) {
            return result;
        }

        if(typeof rawConfig === 'object') {
            return rawConfig;
        }

        try {
            return JSON.parse(rawConfig);
        } catch (error) {
            return rawConfig;
        }
    }
}

module.exports = new AppointmentDao;

const { QueryTypes } = require('sequelize');
const sequelize = require('../../db/Sequelize.connection');
const SequelizeSP = require('../../util/sequelize.sp.util');
const responseData = require('../../util/responsedata');
const Messages = require('../../util/common.messages.util');
const {SequelizeException, SQLException} = require('../../util/sequelizeException');
const { listProfessionals, resolveProfessional } = require('../../util/professionalContext');
const { validateConfig, validateAppointment } = require('../../domain/appointments/agendaRules');
const UserDao = require('./user.dao');

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
const FOLLOW_UP_OPEN_STATUSES = Object.freeze(['pending_confirmation', 'confirmed']);
const followUpConflict = (code, message) => ({ status: 409, data: { code }, message });

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

    async doctors(body) {
        const rows = await listProfessionals(body.id_business);
        return responseData.success(rows.map(d => ({ id_doctor_professional_profile: d.id_doctor_professional_profile,
            id_login: d.id_login, professional_name: d.professional_name, professional_license: d.professional_license,
            display_name: d.professional_name || 'Doctor sin nombre' })), Messages.DATA_GET_SUCCESSFULLY);
    }

    async readConfig(business, profile, transaction = null) {
        const result = await sequelize.query(SequelizeSP.SP_APPOINTMENT_CONFIG_GET, {
            replacements: { _id_business: business, _doctor_profile_id: profile },
            type: QueryTypes.RAW, plain: true, transaction
        });
        const config = this.parseConfig(result);
        if (config && typeof config === 'object') {
            config.workingDays = [1,2,3,4,5,6,0].map(dayOfWeek => (config.workingDays || []).find(day => Number(day.dayOfWeek) === dayOfWeek) || { dayOfWeek, enabled: false, timeRanges: [] });
        }
        return config;
    }

    async getConfig(body) {
        let response;
        try {
            if (body.doctor_profile_id === 'business') return responseData.success(await this.readConfig(body.id_business, null), Messages.DATA_GET_SUCCESSFULLY);
            const resolved = await resolveProfessional(body, body.doctor_profile_id);
            if (resolved.error) return resolved.error;
            const config = await this.readConfig(body.id_business, resolved.doctor.id_doctor_professional_profile);
            const general = await this.readConfig(body.id_business, null);
            config.doctorName = resolved.doctor.professional_name;
            config.businessEnabled = !!general.enabled;
            config.timezone = general.timezone;
            config.businessBlockedDates = general.blockedDates || [];
            config.businessBlockedHours = general.blockedHours || [];
            response = responseData.success(config, Messages.DATA_GET_SUCCESSFULLY);
        } catch (error) {
            response = SequelizeException(error, Messages.DATA_GET_ERROR);
        }
        return response;
    }

    async saveConfig(body) {
        let response;
        let transaction;
        try {
            const configBody = body.config || body;
            const requested = configBody.doctorProfileId;
            const isBusiness = requested === 'business';
            const resolved = isBusiness ? {} : await resolveProfessional(body, requested);
            if (resolved.error) return resolved.error;
            const admin = await require('../../util/effectivePermissions').isTenantAdministrator(body.id_login, body.id_business, 'admin.config');
            if (!admin && (isBusiness || resolved.doctor.id_login !== body.id_login)) return responseData.forbidden('Solo puedes configurar tu propia agenda.');
            const invalid = validateConfig(configBody);
            if (invalid) return responseData.bad_request(invalid);
            transaction = await sequelize.transaction();
            await sequelize.query('SELECT id_business FROM business WHERE id_business = :business FOR UPDATE', { replacements: { business: body.id_business }, type: QueryTypes.SELECT, transaction });
            const result = await sequelize.query(SequelizeSP.SP_APPOINTMENT_CONFIG_SAVE, {
                replacements: {
                    _config: JSON.stringify(configBody),
                    _id_login: body.id_login,
                    _id_business: body.id_business,
                    _doctor_profile_id: isBusiness ? null : resolved.doctor.id_doctor_professional_profile
                },
                type: QueryTypes.RAW,
                plain: true,
                transaction
            });

            const config = this.parseConfig(result);
            await transaction.commit();
            response = responseData.success(config, Messages.DATA_GET_SUCCESSFULLY);
        } catch (error) {
            if (transaction && !transaction.finished) await transaction.rollback();
            response = SequelizeException(error, Messages.DATA_GET_ERROR);
        }
        return response;
    }

    async list(body) {
        let response;
        try {
            if (body.doctor_profile_id) {
                const resolved = await resolveProfessional(body, body.doctor_profile_id);
                if (resolved.error) return resolved.error;
            }
            const result = await sequelize.query(SequelizeSP.SP_APPOINTMENT_LIST, {
                replacements: {
                    _date_from: body.date_from || null,
                    _date_to: body.date_to || null,
                    _id_person: body.id_person || null,
                    _id_business: body.id_business,
                    _doctor_profile_id: body.doctor_profile_id || null
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
        let transaction;
        try {
            const appointment = this.normalizeAppointmentPayload(body.appointment || body);
            transaction = await sequelize.transaction();
            await sequelize.query('SELECT id_business FROM business WHERE id_business = :business FOR UPDATE', { replacements: { business: body.id_business }, type: QueryTypes.SELECT, transaction });
            const resolved = await resolveProfessional(body, appointment.doctorProfileId, transaction);
            if (resolved.error) { await transaction.rollback(); return resolved.error; }
            appointment.doctorProfileId = resolved.doctor.id_doctor_professional_profile;
            appointment.doctorName = resolved.doctor.professional_name;
            if (appointment.id) {
                const current = await sequelize.query('SELECT id_appointment FROM appointment WHERE id_appointment = :id AND id_business = :business AND active = 1', { replacements: { id: appointment.id, business: body.id_business }, type: QueryTypes.SELECT, transaction });
                if (!current.length) { await transaction.rollback(); return responseData.forbidden('Cita no disponible para este consultorio.'); }
            }
            const validationResponse = await this.validateAppointmentPayload(appointment, body.id_business, transaction);
            if(validationResponse) {
                await transaction.rollback();
                return validationResponse;
            }
            if (body.sync_follow_up === true) {
                const followUpResponse = await this.validateFollowUpSync(appointment, body, transaction);
                if (followUpResponse) {
                    // A successful replay returns the appointment already committed, without another write.
                    await transaction.rollback();
                    return followUpResponse;
                }
            }
            const config = await this.readConfig(body.id_business, appointment.doctorProfileId, transaction);
            const general = await this.readConfig(body.id_business, null, transaction);
            Object.assign(config, { businessEnabled: !!general.enabled, businessBlockedDates: general.blockedDates || [], businessBlockedHours: general.blockedHours || [] });
            const invalid = validateAppointment(appointment, config);
            if (invalid) { await transaction.rollback(); return responseData.bad_request(invalid); }
            const conflictResponse = await this.validateAvailabilityConflict(appointment, body.id_business, transaction);
            if(conflictResponse) {
                await transaction.rollback();
                return conflictResponse;
            }

            const result = await sequelize.query(SequelizeSP.SP_APPOINTMENT_SAVE, {
                replacements: {
                    _appointment: JSON.stringify(appointment),
                    _id_login: body.id_login,
                    _id_business: body.id_business
                },
                type: QueryTypes.RAW,
                plain: true,
                transaction
            });

            const rows = this.normalizeAppointmentRows(this.normalizeResultRows(result));
            await transaction.commit();

            if(rows.length){
                const SQLValid = SQLException(rows);
                response = !SQLValid.hasError ? responseData.success(rows, Messages.DATA_GET_SUCCESSFULLY) : responseData.notSuccess(SQLValid.message || Messages.DATA_GET_ERROR);
            }
            else{
                response = responseData.notSuccess(Messages.DATA_SAVE_ERROR, []);
            }
        } catch (error) {
            if (transaction && !transaction.finished) await transaction.rollback();
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
            const followUpId = body.follow_up_id;
            if (followUpId !== undefined && (typeof followUpId !== 'string' || !followUpId.trim() || followUpId.length > 50)) {
                return responseData.bad_request('Indica un seguimiento valido.');
            }
            const upcomingFrom = body.upcoming_from;
            if (upcomingFrom !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(String(upcomingFrom))
                || !Number.isFinite(Date.parse(`${upcomingFrom}T12:00:00Z`))
                || new Date(`${upcomingFrom}T12:00:00Z`).toISOString().slice(0, 10) !== upcomingFrom)) {
                return responseData.bad_request('Indica una fecha valida para consultar las proximas citas.');
            }
            const upcomingTime = body.upcoming_time;
            if (upcomingTime !== undefined && (!upcomingFrom || !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(upcomingTime)))) {
                return responseData.bad_request('Indica una hora valida para consultar las proximas citas.');
            }
            const activeOnly = body.active_only === true || body.active_only === 'true' || body.active_only === '1';

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
                    a.doctor_profile_id AS doctorProfileId,
                    a.doctor_name_snapshot AS doctorName,
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
                    ${followUpId ? `AND ${collateEq('a.id_tracing', ':_id_tracing')}` : ''}
                    ${activeOnly || upcomingFrom ? "AND a.status IN ('pending_confirmation', 'confirmed')" : ''}
                    ${upcomingFrom ? 'AND a.appointment_date >= :_upcoming_from' : ''}
                    ${upcomingTime ? 'AND (a.appointment_date > :_upcoming_from OR a.start_time > TIME(:_upcoming_time))' : ''}
               ORDER BY a.appointment_date ${upcomingFrom ? 'ASC' : 'DESC'}, a.start_time ${upcomingFrom ? 'ASC' : 'DESC'}, a.created_at DESC
                  LIMIT ${limit + 1}
                 OFFSET ${offset}`,
                {
                    replacements: {
                        _id_person: patientId,
                        _id_business: businessId,
                        _id_tracing: followUpId || null,
                        _upcoming_from: upcomingFrom || null,
                        _upcoming_time: upcomingTime || null
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

    async validateFollowUpSync(appointment, body, transaction) {
        if (![appointment.followUpId, appointment.patientId].every(value => typeof value === 'string' && value.trim() && value.length <= 50)) {
            return responseData.bad_request('La cita de seguimiento necesita el paciente y el seguimiento guardado.');
        }
        const followUp = await sequelize.query(`SELECT status FROM tracing
            WHERE ${collateEq('id_tracing', ':id')} AND ${collateEq('id_business', ':business')}
              AND ${collateEq('id_person', ':patient')} LIMIT 1 FOR UPDATE`, {
            replacements: { id: appointment.followUpId, business: body.id_business, patient: appointment.patientId }, type: QueryTypes.SELECT, transaction
        });
        if (!followUp.length || followUp[0].status !== 'active') return responseData.bad_request('Solo se puede agendar desde un seguimiento vigente.');
        const linked = await sequelize.query(`SELECT a.id_appointment AS id, a.id_person AS patientId,
                a.id_tracing AS followUpId, a.doctor_profile_id AS doctorProfileId, a.doctor_name_snapshot AS doctorName,
                a.patient_name AS patientName, a.contact_phone AS contactPhone,
                DATE_FORMAT(a.appointment_date, '%Y-%m-%d') AS date,
                DATE_FORMAT(a.start_time, '%H:%i') AS startTime, DATE_FORMAT(a.end_time, '%H:%i') AS endTime,
                a.status, a.title, a.description, a.source, a.blocks_availability AS blocksAvailability
            FROM appointment a WHERE ${collateEq('a.id_business', ':business')}
              AND ${collateEq('a.id_person', ':patient')} AND ${collateEq('a.id_tracing', ':tracing')}
              AND a.active = 1 ORDER BY a.created_at DESC FOR UPDATE`, {
            replacements: { business: body.id_business, patient: appointment.patientId, tracing: appointment.followUpId }, type: QueryTypes.SELECT, transaction
        });
        if (appointment.id) {
            const current = linked.find(row => row.id === appointment.id);
            if (!current) return responseData.forbidden('La cita no corresponde a este seguimiento.');
            if (!FOLLOW_UP_OPEN_STATUSES.includes(current.status)) {
                return followUpConflict('FOLLOW_UP_APPOINTMENT_TERMINAL', 'Esta cita ya termino, se cancelo o se reprogramo. Se conserva en el historial; agenda una nueva cita de forma explicita.');
            }
            // Follow-up edits synchronize the schedule/text, never undo an agenda confirmation.
            appointment.status = current.status;
            return null;
        }
        const open = linked.filter(row => FOLLOW_UP_OPEN_STATUSES.includes(row.status));
        if (open.length > 1) return followUpConflict('FOLLOW_UP_APPOINTMENT_AMBIGUOUS', 'Hay varias citas vigentes para este seguimiento. Revisalas en la agenda antes de crear otra.');
        if (open.length === 1) {
            const current = open[0];
            const sameRequest = ['patientId', 'followUpId', 'doctorProfileId', 'date', 'startTime', 'endTime', 'title', 'description']
                .every(key => String(current[key] || '') === String(appointment[key] || ''));
            if (!sameRequest) return { ...followUpConflict('FOLLOW_UP_APPOINTMENT_ALREADY_EXISTS',
                'Ya existe una cita vigente con otros datos para este seguimiento. Consulta esa cita en la agenda para modificarla; no se creo otra.'),
                data: { code: 'FOLLOW_UP_APPOINTMENT_ALREADY_EXISTS', appointment: this.normalizeAppointmentRow(current) } };
            return responseData.success(this.normalizeAppointmentRows(open), 'La cita de este seguimiento ya estaba guardada. No se creo otra cita.');
        }
        if (linked.length && body.explicit_new_follow_up !== true) {
            return followUpConflict('FOLLOW_UP_APPOINTMENT_TERMINAL', 'El seguimiento ya tiene una cita historica. Para otra atencion, elige agendar una nueva cita.');
        }
        return null;
    }

    async validateAvailabilityConflict(appointment, businessId, transaction = null) {
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
                AND a.doctor_profile_id = :_doctor_profile_id
                AND a.appointment_date = :_appointment_date
                AND (:_id_appointment IS NULL OR NOT (${collateEq('a.id_appointment', ':_id_appointment')}))
                AND (a.status IN ('pending_confirmation', 'confirmed', 'completed') OR a.blocks_availability = 1)
                AND TIME(:_start_time) < a.end_time
                AND TIME(:_end_time) > a.start_time
              LIMIT 1`,
            {
                replacements: {
                    _id_business: businessId,
                    _doctor_profile_id: appointment.doctorProfileId,
                    _id_appointment: appointment.id || appointment.id_appointment || null,
                    _appointment_date: appointmentDate,
                    _start_time: startTime,
                    _end_time: endTime
                },
                type: QueryTypes.SELECT,
                transaction
            }
        );

        return rows.length ? responseData.bad_request('Este horario ya esta ocupado.') : null;
    }

    normalizeAppointmentPayload(appointment) {
        const nextAppointment = Object.assign({}, appointment || {});
        const contactPhone = normalizeContactPhone(nextAppointment.contactPhone || nextAppointment.contact_phone);
        nextAppointment.contactPhone = contactPhone;
        nextAppointment.status = nextAppointment.status || 'pending_confirmation';
        return nextAppointment;
    }

    async validateAppointmentPayload(appointment, businessId, transaction = null) {
        if(!appointment || !businessId) {
            return responseData.bad_request('Cita y negocio son requeridos.');
        }

        const contactPhone = normalizeContactPhone(appointment.contactPhone);
        const patientId = appointment.patientId || appointment.id_person || null;
        const appointmentId = appointment.id || appointment.id_appointment || null;
        if (!patientId && !String(appointment.patientName || '').trim()) return responseData.bad_request('Captura el nombre del paciente.');
        if (String(appointment.patientName || '').length > 1000 || String(appointment.title || '').length > 500 || String(appointment.description || '').length > 5000) return responseData.bad_request('Revisa la longitud de los datos de la cita.');

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
                    type: QueryTypes.SELECT,
                    transaction
                }
            );

            if(!patientRows.length) {
                return responseData.forbidden('Paciente no disponible para este consultorio.');
            }
        }

        if(!appointmentId && !patientId && !contactPhone) {
            return responseData.bad_request('Telefono de contacto requerido para citas de pacientes no registrados.');
        }

        if (appointment.followUpId) {
            const rows = await sequelize.query('SELECT 1 FROM tracing WHERE id_tracing = :id AND id_business = :business AND id_person = :patient LIMIT 1', {
                replacements: { id: appointment.followUpId, business: businessId, patient: patientId }, type: QueryTypes.SELECT, transaction
            });
            if (!rows.length) return responseData.forbidden('Seguimiento no disponible para este paciente.');
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

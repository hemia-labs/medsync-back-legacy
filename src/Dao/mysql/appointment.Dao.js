const { QueryTypes } = require('sequelize');
const sequelize = require('../../db/Sequelize.connection');
const SequelizeSP = require('../../util/sequelize.sp.util');
const responseData = require('../../util/responsedata');
const Messages = require('../../util/common.messages.util');
const { SequelizeException } = require('../../util/sequelizeException');
const { resolveProfessional } = require('../../util/professionalContext');
const { validateConfig, validateAppointment } = require('../../domain/appointments/agendaRules');
const safeWrites = require('../../domain/appointments/safeWrites');

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

    async doctors(body, transaction = null) {
        const rows = await sequelize.query(`SELECT d.id_doctor_professional_profile,d.id_login,d.professional_name,d.professional_license,
            COALESCE(NULLIF(d.professional_name,''),'Doctor sin nombre') AS display_name,
            IF(d.is_active=1 AND l.active=1,1,0) AS active
            FROM doctor_professional_profile d JOIN login l ON l.id_login=d.id_login AND l.id_business=d.id_business
            WHERE d.id_business=:business AND ((d.is_active=1 AND l.active=1) OR EXISTS
                (SELECT 1 FROM appointment a WHERE a.id_business=d.id_business AND a.doctor_profile_id=d.id_doctor_professional_profile AND a.active=1))
            ORDER BY active DESC,display_name`, { replacements: { business: body.id_business }, type: QueryTypes.SELECT, transaction });
        return responseData.success(rows, Messages.DATA_GET_SUCCESSFULLY);
    }

    async readConfig(business, profile, transaction = null) {
        const result = await sequelize.query(SequelizeSP.SP_APPOINTMENT_CONFIG_GET, {
            replacements: { _id_business: business, _doctor_profile_id: profile },
            type: QueryTypes.RAW, plain: true, transaction
        });
        const config = this.parseConfig(result);
        if (config && typeof config === 'object') {
            config.workingDays = [1,2,3,4,5,6,0].map(dayOfWeek => (config.workingDays || []).find(day => Number(day.dayOfWeek) === dayOfWeek) || { dayOfWeek, enabled: false, timeRanges: [] });
            const [version] = await sequelize.query('SELECT revision FROM appointment_config WHERE id_appointment_config=:id AND id_business=:business', {
                replacements: { id: config.id, business }, type: QueryTypes.SELECT, transaction
            });
            config.revision = version && Number(version.revision);
        }
        return config;
    }

    async getConfig(body) {
        let transaction;
        try {
            // Config JSON and its revision must describe the same committed state.
            transaction = await sequelize.transaction();
            await sequelize.query('SELECT id_business FROM business WHERE id_business=:business FOR UPDATE', { replacements:{business:body.id_business},type:QueryTypes.SELECT,transaction });
            const general = await this.readConfig(body.id_business, null, transaction);
            if (body.doctor_profile_id === 'business') { await transaction.commit(); return responseData.success(general, Messages.DATA_GET_SUCCESSFULLY); }
            let resolved = await resolveProfessional(body, body.doctor_profile_id, transaction);
            if (resolved.error && body.doctor_profile_id) {
                const doctors = await this.doctors(body, transaction);
                const historical = doctors.data.find(d => d.id_doctor_professional_profile === body.doctor_profile_id);
                if (historical) resolved = { doctor: historical };
            }
            if (resolved.error) { await transaction.rollback(); return resolved.error; }
            const config = await this.readConfig(body.id_business, resolved.doctor.id_doctor_professional_profile, transaction);
            Object.assign(config, { doctorName: resolved.doctor.professional_name, doctorActive: resolved.doctor.active !== 0,
                businessRevision: general.revision, businessEnabled: !!general.enabled, timezone: general.timezone,
                businessBlockedDates: general.blockedDates || [], businessBlockedHours: general.blockedHours || [] });
            await transaction.commit();
            return responseData.success(config, Messages.DATA_GET_SUCCESSFULLY);
        } catch (error) {
            if (transaction && !transaction.finished) await transaction.rollback();
            return SequelizeException(error, Messages.DATA_GET_ERROR);
        }
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
            const current = await this.readConfig(body.id_business, isBusiness ? null : resolved.doctor.id_doctor_professional_profile, transaction);
            const conflict = safeWrites.revisionConflict(configBody.revision, current, 'config');
            if (conflict) { await transaction.rollback(); return conflict; }
            // The timezone has its own endpoint/version. A doctor form never owns it.
            configBody.timezone = current.timezone;
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
            await sequelize.query('UPDATE appointment_config SET revision=revision+1 WHERE id_appointment_config=:id AND id_business=:business', {
                replacements: { id: current.id, business: body.id_business }, type: QueryTypes.UPDATE, transaction
            });
            config.revision = current.revision + 1;
            await transaction.commit();
            response = responseData.success(config, Messages.DATA_GET_SUCCESSFULLY);
        } catch (error) {
            if (transaction && !transaction.finished) await transaction.rollback();
            response = SequelizeException(error, Messages.DATA_GET_ERROR);
        }
        return response;
    }

    async saveTimezone(body) {
        let transaction;
        try {
            const admin = await require('../../util/effectivePermissions').isTenantAdministrator(body.id_login, body.id_business, 'admin.config');
            if (!admin) return responseData.forbidden('Solo el administrador puede cambiar la zona horaria del consultorio.');
            if (typeof body.timezone !== 'string' || !body.timezone.trim() || body.timezone.length > 80) return responseData.bad_request('Zona horaria invalida.');
            try {
                const zone = new Intl.DateTimeFormat('es-MX', { timeZone: body.timezone }).resolvedOptions().timeZone;
                if (/^[+-]/.test(zone)) return responseData.bad_request('Selecciona una zona horaria con nombre, no un desfase fijo.');
            }
            catch (_) { return responseData.bad_request('Zona horaria invalida.'); }
            transaction = await sequelize.transaction();
            await sequelize.query('SELECT id_business FROM business WHERE id_business = :business FOR UPDATE', {
                replacements: { business: body.id_business }, type: QueryTypes.SELECT, transaction
            });
            const general = await this.readConfig(body.id_business, null, transaction);
            if (!general || !general.id) throw new Error('No se pudo cargar la configuracion general del consultorio.');
            const conflict = safeWrites.revisionConflict(body.revision, general, 'config');
            if (conflict) { await transaction.rollback(); return conflict; }
            // A dedicated update cannot overwrite concurrent closures or doctor availability.
            await sequelize.query(`UPDATE appointment_config SET timezone = :timezone, revision=revision+1, updated_at = NOW(), updated_by = :actor
                WHERE id_appointment_config = :config AND id_business = :business AND doctor_profile_id IS NULL AND active = 1`, {
                replacements: { timezone: body.timezone, actor: body.id_login, config: general.id, business: body.id_business },
                type: QueryTypes.UPDATE, transaction
            });
            await transaction.commit();
            return responseData.success({ timezone: body.timezone, revision: general.revision + 1 }, Messages.DATA_GET_SUCCESSFULLY);
        } catch (error) {
            if (transaction && !transaction.finished) await transaction.rollback();
            return SequelizeException(error, Messages.DATA_GET_ERROR);
        }
    }

    async list(body) {
        try {
            if(body.doctor_profile_id) {
                const rows = await sequelize.query('SELECT 1 FROM doctor_professional_profile WHERE id_business=:business AND id_doctor_professional_profile=:id', {replacements:{business:body.id_business,id:body.doctor_profile_id},type:QueryTypes.SELECT});
                if(!rows.length) return responseData.forbidden('Doctor no disponible para este consultorio.');
            }
            for(const date of [body.date_from,body.date_to].filter(Boolean)) if(!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date+'T12:00:00Z')) || new Date(date+'T12:00:00Z').toISOString().slice(0,10)!==date) return responseData.bad_request('Fecha de consulta invalida.');
            return responseData.success(this.normalizeAppointmentRows(await safeWrites.list(body)), Messages.DATA_GET_SUCCESSFULLY);
        }
        catch (error) { return SequelizeException(error, Messages.DATA_GET_ERROR); }
    }

    async save(body) { return safeWrites.write(this, body); }
    async reschedule(body) { return safeWrites.write(this, body, 'reschedule'); }

    async delete(body) {
        // Preserve history. The legacy delete route now performs a versioned cancellation.
        const current = await safeWrites.get(body.id_appointment, body.id_business);
        if (!current) return responseData.forbidden('Cita no disponible para este consultorio.');
        return this.save({ ...body, appointment: { ...current, revision: body.revision, status: 'cancelled', cancellationReason: body.cancellationReason,
            ...(Object.prototype.hasOwnProperty.call(body, 'cancellationReasonCode') ? { cancellationReasonCode: body.cancellationReasonCode } : {}),
            cancellationImpactToken: body.cancellationImpactToken } });
    }

    async cancellationImpact(body) {
        let transaction;
        try {
            transaction = await sequelize.transaction();
            await safeWrites.query('SELECT id_business FROM business WHERE id_business=:business FOR UPDATE', { business: body.id_business }, transaction);
            const current = await safeWrites.get(body.id_appointment, body.id_business, transaction);
            if (!current) { await transaction.rollback(); return responseData.forbidden('Cita no disponible para este consultorio.'); }
            const conflict = safeWrites.revisionConflict(body.revision, current);
            if (conflict) { await transaction.rollback(); return conflict; }
            const impact = await require('../../domain/appointments/cancellationImpact').evaluate(this, current, body, transaction, Date.now());
            await transaction.commit();
            return responseData.success(impact, 'Impacto de cancelación consultado.');
        } catch (error) {
            if (transaction && !transaction.finished) await transaction.rollback();
            return responseData.error('No se pudo consultar el impacto de cancelación.');
        }
    }

    async get(body) {
        const row = await safeWrites.get(body.id_appointment, body.id_business);
        return row ? responseData.success(row, Messages.DATA_GET_SUCCESSFULLY) : responseData.forbidden('Cita no disponible para este consultorio.');
    }

    async audit(body) {
        if (!await safeWrites.get(body.id_appointment, body.id_business)) return responseData.forbidden('Cita no disponible para este consultorio.');
        const rows = await sequelize.query(`SELECT a.id,a.operation,a.revision,a.changes,a.created_at AS createdAt,l.name AS actorName
            FROM appointment_audit a LEFT JOIN login l ON l.id_login=a.actor_id AND l.id_business=a.id_business
            WHERE a.id_business=:business AND a.appointment_id=:id AND (:before IS NULL OR a.id < :before)
            ORDER BY a.id DESC LIMIT 51`, { replacements: { business: body.id_business, id: body.id_appointment,
                before: Number(body.before) > 0 ? Number(body.before) : null }, type: QueryTypes.SELECT });
        return responseData.success({ items: rows.slice(0,50), hasMore: rows.length>50, nextBefore: rows.length>50 ? rows[49].id : null }, Messages.DATA_GET_SUCCESSFULLY);
    }

    async configImpact(body) {
        const config = body.config;
        const invalid = validateConfig(config);
        if (invalid) return responseData.bad_request(invalid);
        const general = await this.readConfig(body.id_business, null);
        const today = new Intl.DateTimeFormat('en-CA', { timeZone: general.timezone, year:'numeric',month:'2-digit',day:'2-digit' }).format(new Date());
        const rows = await safeWrites.list({ id_business: body.id_business, date_from: today,
            doctor_profile_id: config.doctorProfileId === 'business' ? null : config.doctorProfileId });
        const affected = [], configs = new Map();
        for (const a of rows) {
            if (!APPOINTMENT_BLOCKING_STATUSES.includes(a.status)) continue;
            let effective = config;
            if (config.doctorProfileId === 'business') {
                if (!configs.has(a.doctorProfileId)) configs.set(a.doctorProfileId, await this.readConfig(body.id_business, a.doctorProfileId));
                effective = { ...configs.get(a.doctorProfileId), businessEnabled: !!config.enabled,
                    businessBlockedDates: config.blockedDates, businessBlockedHours: config.blockedHours };
            } else effective = { ...config, businessEnabled: !!general.enabled, businessBlockedDates: general.blockedDates, businessBlockedHours: general.blockedHours };
            if (validateAppointment(a, effective)) affected.push({ id:a.id,date:a.date,startTime:a.startTime,doctorName:a.doctorName,patientName:a.patientName });
        }
        return responseData.success({ count:affected.length,appointments:affected.slice(0,50),truncated:affected.length>50,asOf:today }, Messages.DATA_GET_SUCCESSFULLY);
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
                    a.id_appointment AS id, a.revision,
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

    async validateFollowUpSync(appointment, body, transaction, options = {}) {
        if (![appointment.followUpId, appointment.patientId].every(value => typeof value === 'string' && value.trim() && value.length <= 50)) {
            return responseData.bad_request('La cita de seguimiento necesita el paciente y el seguimiento guardado.');
        }
        const followUp = await sequelize.query(`SELECT status FROM tracing
            WHERE ${collateEq('id_tracing', ':id')} AND ${collateEq('id_business', ':business')}
              AND ${collateEq('id_person', ':patient')} LIMIT 1 FOR UPDATE`, {
            replacements: { id: appointment.followUpId, business: body.id_business, patient: appointment.patientId }, type: QueryTypes.SELECT, transaction
        });
        if (!followUp.length || followUp[0].status !== 'active') return responseData.bad_request('Solo se puede agendar desde un seguimiento vigente.');
        let linked = await sequelize.query(`SELECT a.id_appointment AS id, a.revision, a.id_person AS patientId,
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
        if (options.excludeId) linked = linked.filter(row => row.id !== options.excludeId);
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
            if (!sameRequest || options.associationOnly) return { ...followUpConflict('FOLLOW_UP_APPOINTMENT_ALREADY_EXISTS',
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
                  LIMIT 1 ${transaction ? 'FOR UPDATE' : ''}`,
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

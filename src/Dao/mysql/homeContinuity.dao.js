const { QueryTypes } = require('sequelize');
const sequelize = require('../../db/Sequelize.connection');
const responseData = require('../../util/responsedata');
const Messages = require('../../util/common.messages.util');
const { SequelizeException } = require('../../util/sequelizeException');
const UserDao = require('./user.dao');
const { resolveDashboardAccess } = require('../../util/dashboardAccess');
const AppointmentDao = require('./appointment.Dao');

const TENANT_COLLATION = 'utf8mb4_unicode_ci';
const ITEM_LIMIT = 3;
const collateEq = (left, param) => `${left} COLLATE ${TENANT_COLLATION} = ${param} COLLATE ${TENANT_COLLATION}`;

function toIso(value) {
    if (!value) {
        return null;
    }

    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function patientName(row) {
    const name = `${row.name || ''} ${row.surname || ''}`.trim();
    return name || row.patient_name || 'Paciente';
}

function numberValue(row, key = 'total') {
    if (Array.isArray(row)) row = row[0];
    return Number(row && row[key] ? row[key] : 0);
}

function summaryCard(key, label, value, tone = 'neutral') {
    return {
        key,
        label,
        value: Number(value || 0),
        tone
    };
}

function action(label, path, permission) {
    if (!path) {
        return null;
    }

    return {
        label,
        path,
        permission
    };
}

class HomeContinuityDao {
    async summary(idBusiness, idLogin, options = {}) {
        if (!idBusiness || !idLogin) {
            return responseData.unauthorized('No hay sesion activa para consultar continuidad clinica.');
        }

        try {
            const access = await resolveDashboardAccess(idBusiness, idLogin, { scope: options.scope, requireFamily: false });
            if (access.error) return access.error;
            const permissions = await this.resolvePermissions(idLogin);
            permissions.scope = access.scope;
            permissions.dashboard = permissions.dashboard || Object.values(access.families).some(Boolean);
            permissions.patientActivity = permissions.pxAll && access.families.administrative && access.scope.mode === 'tenant';
            permissions.clinicalHistoryView = permissions.clinicalHistoryView && access.families.clinical;
            permissions.prescriptionsReadable = permissions.prescriptionsReadable && access.families.clinical;
            permissions.documentsView = permissions.documentsView && access.families.clinical;
            const [drafts, signatures, recentPatients, pulse] = await Promise.all([
                this.draftsSection(idBusiness, idLogin, permissions),
                this.signaturesSection(idBusiness, permissions),
                this.recentPatientsSection(idBusiness, permissions),
                this.pulseSection(idBusiness, idLogin, permissions)
            ]);

            return responseData.success({
                generatedAt: new Date().toISOString(),
                refreshAfterSeconds: 3600,
                scope: access.scope,
                families: access.families,
                canSelectOwn: access.canSelectOwn,
                canSelectTenant: access.canSelectTenant,
                permissions,
                sections: {
                    drafts,
                    signatures,
                    recentPatients,
                    pulse
                }
            }, Messages.DATA_GET_SUCCESSFULLY);
        } catch (error) {
            return SequelizeException(error, Messages.DATA_GET_ERROR);
        }
    }

    async appointments(idBusiness, idLogin, options = {}) {
        if (!await UserDao.hasPermission(idLogin, 'px.dates')) return responseData.forbidden('No tienes permiso para consultar agenda.');
        const access = await resolveDashboardAccess(idBusiness, idLogin, { scope: options.scope, requireFamily: false });
        if (access.error) return access.error;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(options.date || '')) return responseData.bad_request('Fecha invalida.');
        return AppointmentDao.list({ id_business: idBusiness, id_login: idLogin,
            date_from: options.date, date_to: options.date, doctor_profile_id: access.scope.doctorProfileId });
    }

    responsibleClause(permissions, column) {
        if (!permissions.scope || permissions.scope.mode !== 'own') return '';
        const profile = { 'ch.doctor_responsible_user_id': 'ch.doctor_responsible_profile_id', 'pd.responsible_doctor_user_id': 'pd.responsible_doctor_profile_id', 'pr.issuer_doctor_id': 'pr.issuer_doctor_profile_id' }[column];
        return profile ? ` AND (${collateEq(profile, ':_scope_profile')} OR (${profile} IS NULL AND ${collateEq(column, ':_scope_login')}))` : ' AND ' + collateEq(column, ':_scope_login');
    }

    async resolvePermissions(idLogin) {
        const checks = await Promise.all([
            UserDao.hasPermission(idLogin, 'px.all'),
            UserDao.hasPermission(idLogin, 'px.dates'),
            UserDao.hasPermission(idLogin, 'clinical_history.view'),
            UserDao.hasPermission(idLogin, 'prescriptions.global'),
            UserDao.hasPermission(idLogin, 'prescriptions.view.all'),
            UserDao.hasPermission(idLogin, 'prescriptions.view.own'),
            UserDao.hasPermission(idLogin, 'documents.view'),
            UserDao.hasPermission(idLogin, 'documents.sign'),
            UserDao.hasPermission(idLogin, 'dashboard.tenant'),
            UserDao.hasPermission(idLogin, 'reports.dashboard'),
            UserDao.hasPermission(idLogin, 'dashboard')
        ]);

        const [
            pxAll,
            pxDates,
            clinicalHistoryView,
            prescriptionsGlobal,
            prescriptionsViewAll,
            prescriptionsViewOwn,
            documentsView,
            documentsSign,
            dashboardTenant,
            reportsDashboard,
            legacyDashboard
        ] = checks;

        return {
            pxAll,
            pxDates,
            clinicalHistoryView,
            prescriptionsGlobal,
            prescriptionsViewAll,
            prescriptionsViewOwn,
            prescriptionsCanViewAll: prescriptionsViewAll,
            prescriptionsReadable: prescriptionsViewAll || prescriptionsViewOwn,
            documentsView,
            documentsSign,
            dashboard: dashboardTenant || reportsDashboard || legacyDashboard
        };
    }

    prescriptionOwnershipClause(permissions) {
        if (permissions.scope && permissions.scope.mode === 'own') return this.responsibleClause(permissions, 'pr.issuer_doctor_id');
        return permissions.prescriptionsCanViewAll
            ? ''
            : ` AND (${collateEq('pr.issuer_doctor_id', ':_id_login')} OR ${collateEq('pr.created_by', ':_id_login')})`;
    }

    async draftsSection(idBusiness, idLogin, permissions) {
        const [
            clinicalRows,
            prescriptionRows,
            documentRows
        ] = await Promise.all([
            this.countClinicalDrafts(idBusiness, permissions),
            this.countPrescriptionDrafts(idBusiness, idLogin, permissions),
            this.countDocumentDrafts(idBusiness, permissions)
        ]);

        const cards = [
            permissions.clinicalHistoryView && summaryCard('clinical', 'Historias en borrador', numberValue(clinicalRows), 'warning'),
            permissions.prescriptionsReadable && summaryCard('prescriptions', 'Recetas sin emitir', numberValue(prescriptionRows), 'accent'),
            permissions.documentsView && summaryCard('documents', 'Documentos en borrador', numberValue(documentRows), 'neutral')
        ].filter(Boolean);
        const total = cards.reduce((sum, item) => sum + item.value, 0);
        const items = permissions.pxAll ? await this.draftItems(idBusiness, idLogin, permissions) : [];

        return {
            key: 'drafts',
            label: 'Borradores clinicos',
            eyebrow: 'Continuidad',
            title: total ? `${total} pendiente${total === 1 ? '' : 's'} por cerrar` : 'Sin borradores pendientes',
            description: total
                ? 'Historias, recetas o documentos que quedaron abiertos.'
                : 'No encontramos borradores clinicos abiertos para revisar.',
            icon: 'mdi-clipboard-edit-outline',
            total,
            available: cards.length > 0,
            cards,
            items,
            action: permissions.pxAll
                ? action('Revisar pacientes', '/px/all', 'px.all')
                : (permissions.prescriptionsReadable ? action('Ir a recetas', '/prescriptions', 'prescriptions.view.own') : null)
        };
    }

    async signaturesSection(idBusiness, permissions) {
        const rows = permissions.documentsView
            ? await this.signatureSummaryRows(idBusiness, permissions)
            : [];
        const row = rows[0] || {};
        const pending = numberValue(row, 'pending');
        const expiringSoon = numberValue(row, 'expiringSoon');
        const expired = numberValue(row, 'expired');
        const total = pending + expiringSoon + expired;
        const items = permissions.pxAll && permissions.documentsView
            ? await this.signatureItems(idBusiness, permissions)
            : [];

        return {
            key: 'signatures',
            label: 'Firmas pendientes',
            eyebrow: 'Documentos',
            title: total ? `${total} firma${total === 1 ? '' : 's'} por atender` : 'Firmas al dia',
            description: total
                ? 'Solicitudes remotas pendientes, por vencer o vencidas.'
                : 'No hay solicitudes de firma remota abiertas.',
            icon: 'mdi-draw-pen',
            total,
            available: permissions.documentsView,
            cards: !permissions.documentsView ? [] : [
                summaryCard('pending', 'Vigentes (>48 h)', pending, 'accent'),
                summaryCard('expiringSoon', 'Por vencer (48 h)', expiringSoon, 'warning'),
                summaryCard('expired', 'Vencidas', expired, 'danger')
            ],
            items,
            action: permissions.pxAll ? action('Ver expedientes', '/px/all', 'px.all') : null
        };
    }

    async recentPatientsSection(idBusiness, permissions) {
        const rows = permissions.patientActivity ? await this.recentPatientSummaryRows(idBusiness, permissions) : [];
        const row = rows[0] || {};
        const total = numberValue(row, 'recentPatients');
        const withoutClinicalHistory = numberValue(row, 'withoutClinicalHistory');
        const withoutNextAppointment = numberValue(row, 'withoutNextAppointment');
        const items = permissions.patientActivity ? await this.recentPatientItems(idBusiness, permissions) : [];

        return {
            key: 'recentPatients',
            label: 'Pacientes recientes',
            eyebrow: 'Seguimiento',
            title: total ? `${total} paciente${total === 1 ? '' : 's'} nuevo${total === 1 ? '' : 's'} en los ultimos 7 dias` : 'Sin pacientes nuevos',
            description: total
                ? 'Revisa las altas recientes y los pendientes que puedes consultar.'
                : 'No hay altas recientes que requieran seguimiento.',
            icon: 'mdi-account-clock-outline',
            total,
            available: permissions.patientActivity,
            cards: !permissions.patientActivity ? [] : [
                summaryCard('recent', 'Altas recientes', total, 'neutral'),
                permissions.clinicalHistoryView && summaryCard('withoutHistory', 'Sin historia inicial', withoutClinicalHistory, 'warning'),
                permissions.pxDates && summaryCard('withoutAppointment', 'Sin proxima cita', withoutNextAppointment, 'accent')
            ].filter(Boolean),
            items,
            action: permissions.pxAll ? action('Ver pacientes', '/px/all', 'px.all') : null
        };
    }

    async pulseSection(idBusiness, idLogin, permissions) {
        const rows = await this.pulseRows(idBusiness, idLogin, permissions);
        const row = rows[0] || {};
        const cards = [
            permissions.patientActivity && summaryCard('patients', 'Pacientes nuevos', numberValue(row, 'patientsNew'), 'neutral'),
            permissions.prescriptionsReadable && summaryCard('prescriptions', 'Recetas emitidas', numberValue(row, 'prescriptionsIssued'), 'accent'),
            permissions.clinicalHistoryView && summaryCard('histories', 'Historias finalizadas', numberValue(row, 'clinicalHistoriesFinalized'), 'success'),
            permissions.documentsView && summaryCard('documents', 'Documentos generados', numberValue(row, 'documentsCreated'), 'neutral')
        ].filter(Boolean);
        const total = cards.reduce((sum, item) => sum + item.value, 0);

        return {
            key: 'pulse',
            label: permissions.scope.mode === 'own' ? 'Mi actividad' : 'Pulso del consultorio',
            eyebrow: 'Ultimos 7 dias',
            title: total ? 'Movimiento de los ultimos 7 dias' : 'Sin actividad registrada',
            description: total
                ? 'Resumen breve de actividad operativa reciente.'
                : 'Aun no hay actividad registrada en los ultimos 7 dias.',
            icon: 'mdi-pulse',
            total,
            available: cards.length > 0,
            cards,
            items: [],
            action: permissions.dashboard ? action('Ir al dashboard', '/dashboard', 'dashboard.tenant') : null
        };
    }

    countClinicalDrafts(idBusiness, permissions) {
        if (!permissions.clinicalHistoryView) {
            return [];
        }

        return sequelize.query(
            `SELECT COUNT(*) AS total
               FROM clinical_histories ch
              WHERE ${collateEq('ch.business_id', ':_id_business')}
                AND ch.status = 'DRAFT'
                AND ch.deleted_at IS NULL ${this.responsibleClause(permissions, 'ch.doctor_responsible_user_id')}`,
            {
                replacements: { _id_business: idBusiness, _scope_login: permissions.scope.idLogin, _scope_profile: permissions.scope.doctorProfileId },
                type: QueryTypes.SELECT
            }
        );
    }

    countPrescriptionDrafts(idBusiness, idLogin, permissions) {
        if (!permissions.prescriptionsReadable) {
            return [];
        }

        return sequelize.query(
            `SELECT COUNT(*) AS total
               FROM prescription pr
              WHERE ${collateEq('pr.id_business', ':_id_business')}
                AND pr.status = 'draft'
                AND pr.active = 1
                ${this.prescriptionOwnershipClause(permissions)}`,
            {
                replacements: { _id_business: idBusiness, _id_login: idLogin, _scope_login: permissions.scope.idLogin, _scope_profile: permissions.scope.doctorProfileId },
                type: QueryTypes.SELECT
            }
        );
    }

    countDocumentDrafts(idBusiness, permissions) {
        if (!permissions.documentsView) {
            return [];
        }

        return sequelize.query(
            `SELECT COUNT(*) AS total
               FROM patient_documents pd
              WHERE ${collateEq('pd.id_business', ':_id_business')}
                AND pd.status = 'BORRADOR'
                AND pd.active = 1 ${this.responsibleClause(permissions, 'pd.responsible_doctor_user_id')}`,
            {
                replacements: { _id_business: idBusiness, _scope_login: permissions.scope.idLogin, _scope_profile: permissions.scope.doctorProfileId },
                type: QueryTypes.SELECT
            }
        );
    }

    async draftItems(idBusiness, idLogin, permissions) {
        const queries = [];

        if (permissions.clinicalHistoryView) queries.push(sequelize.query(
            `SELECT 'clinical' AS type,
                    ch.id_clinical_history AS id,
                    ch.patient_id AS patientId,
                    p.name,
                    p.surname,
                    ch.updated_at AS dateValue
               FROM clinical_histories ch
               INNER JOIN person p
                       ON ${collateEq('p.id_person', 'ch.patient_id')}
                      AND ${collateEq('p.id_business', 'ch.business_id')}
              WHERE ${collateEq('ch.business_id', ':_id_business')}
                AND ch.status = 'DRAFT'
                AND ch.deleted_at IS NULL ${this.responsibleClause(permissions, 'ch.doctor_responsible_user_id')}
              ORDER BY ch.updated_at DESC, ch.created_at DESC
              LIMIT ${ITEM_LIMIT}`,
            {
                replacements: { _id_business: idBusiness, _scope_login: permissions.scope.idLogin, _scope_profile: permissions.scope.doctorProfileId },
                type: QueryTypes.SELECT
            }
        ));

        if (permissions.prescriptionsReadable) {
            queries.push(sequelize.query(
                `SELECT 'prescription' AS type,
                        pr.id_prescription AS id,
                        pr.id_person AS patientId,
                        p.name,
                        p.surname,
                        pr.issue_date AS dateValue,
                        pr.folio
                   FROM prescription pr
                   INNER JOIN person p
                           ON ${collateEq('p.id_person', 'pr.id_person')}
                          AND ${collateEq('p.id_business', 'pr.id_business')}
                  WHERE ${collateEq('pr.id_business', ':_id_business')}
                    AND pr.status = 'draft'
                    AND pr.active = 1
                    ${this.prescriptionOwnershipClause(permissions)}
                  ORDER BY pr.created_at DESC
                  LIMIT ${ITEM_LIMIT}`,
                {
                    replacements: { _id_business: idBusiness, _id_login: idLogin, _scope_login: permissions.scope.idLogin, _scope_profile: permissions.scope.doctorProfileId },
                    type: QueryTypes.SELECT
                }
            ));
        }

        if (permissions.documentsView) {
            queries.push(sequelize.query(
                `SELECT 'document' AS type,
                        pd.id_patient_document AS id,
                        pd.id_person AS patientId,
                        p.name,
                        p.surname,
                        pd.updated_at AS dateValue,
                        pd.title
                   FROM patient_documents pd
                   INNER JOIN person p
                           ON ${collateEq('p.id_person', 'pd.id_person')}
                          AND ${collateEq('p.id_business', 'pd.id_business')}
                  WHERE ${collateEq('pd.id_business', ':_id_business')}
                    AND pd.status = 'BORRADOR'
                    AND pd.active = 1 ${this.responsibleClause(permissions, 'pd.responsible_doctor_user_id')}
                  ORDER BY COALESCE(pd.updated_at, pd.created_at) DESC
                  LIMIT ${ITEM_LIMIT}`,
                {
                    replacements: { _id_business: idBusiness, _scope_login: permissions.scope.idLogin, _scope_profile: permissions.scope.doctorProfileId },
                    type: QueryTypes.SELECT
                }
            ));
        }

        const rows = (await Promise.all(queries)).flat();
        return rows
            .sort((left, right) => new Date(right.dateValue || 0).getTime() - new Date(left.dateValue || 0).getTime())
            .slice(0, ITEM_LIMIT)
            .map((row) => ({
                key: `${row.type}-${row.id}`,
                type: row.type,
                label: patientName(row),
                detail: row.type === 'prescription'
                    ? `Receta ${row.folio || 'en borrador'}`
                    : (row.type === 'document' ? (row.title || 'Documento en borrador') : 'Historia clinica en borrador'),
                patientId: row.patientId,
                path: `/px/history/${row.patientId}?tab=${row.type === 'prescription' ? 'prescriptions' : row.type === 'document' ? 'documents' : 'history'}`,
                createdAt: toIso(row.dateValue)
            }));
    }

    signatureAttentionWhere(permissions) {
        // Count one current request per document/role; retries and historical expirations
        // must not create additional pending signatures after renewal or local signing.
        return `${collateEq('dsr.id_business', ':_id_business')}
            AND dsr.status IN ('pending', 'opened', 'expired') AND pd.active = 1
            AND pd.status IN ('BORRADOR', 'PENDIENTE_FIRMA')
            ${this.responsibleClause(permissions, 'pd.responsible_doctor_user_id')}
            AND NOT EXISTS (SELECT 1 FROM patient_document_signatures sig
                WHERE ${collateEq('sig.id_business', 'dsr.id_business')}
                  AND ${collateEq('sig.id_patient_document', 'dsr.id_patient_document')}
                  AND ${collateEq('sig.signature_role', 'dsr.signature_role')}
                  AND (NULLIF(sig.signature_image, '') IS NOT NULL OR sig.signed_at IS NOT NULL))
            AND NOT EXISTS (SELECT 1 FROM document_signature_requests newer
                WHERE ${collateEq('newer.id_business', 'dsr.id_business')}
                  AND ${collateEq('newer.id_patient_document', 'dsr.id_patient_document')}
                  AND ${collateEq('newer.signature_role', 'dsr.signature_role')}
                  AND (newer.created_at > dsr.created_at OR (newer.created_at = dsr.created_at
                    AND (newer.status IN ('pending', 'opened', 'expired') OR dsr.status = 'expired')
                    AND (newer.expires_at > dsr.expires_at OR (newer.expires_at = dsr.expires_at
                    AND newer.id_document_signature_request > dsr.id_document_signature_request)))))`;
    }

    signatureSummaryRows(idBusiness, permissions) {
        return sequelize.query(
            `SELECT
                SUM(CASE WHEN dsr.status IN ('pending', 'opened') AND dsr.expires_at > DATE_ADD(NOW(), INTERVAL 48 HOUR) THEN 1 ELSE 0 END) AS pending,
                SUM(CASE WHEN dsr.status IN ('pending', 'opened') AND dsr.expires_at > NOW() AND dsr.expires_at <= DATE_ADD(NOW(), INTERVAL 48 HOUR) THEN 1 ELSE 0 END) AS expiringSoon,
                SUM(CASE WHEN dsr.status = 'expired' OR dsr.expires_at <= NOW() THEN 1 ELSE 0 END) AS expired
             FROM document_signature_requests dsr
             INNER JOIN patient_documents pd ON ${collateEq('pd.id_patient_document', 'dsr.id_patient_document')}
                AND ${collateEq('pd.id_business', 'dsr.id_business')}
             WHERE ${this.signatureAttentionWhere(permissions)}`,
            { replacements: { _id_business: idBusiness, _scope_login: permissions.scope.idLogin, _scope_profile: permissions.scope.doctorProfileId }, type: QueryTypes.SELECT }
        );
    }

    signatureItems(idBusiness, permissions) {
        return sequelize.query(
            `SELECT dsr.id_document_signature_request AS id, dsr.id_person AS patientId,
                dsr.signature_role AS signatureRole, dsr.expires_at AS expiresAt, dsr.status, p.name, p.surname, pd.title
             FROM document_signature_requests dsr
             INNER JOIN person p ON ${collateEq('p.id_person', 'dsr.id_person')}
                AND ${collateEq('p.id_business', 'dsr.id_business')}
             INNER JOIN patient_documents pd ON ${collateEq('pd.id_patient_document', 'dsr.id_patient_document')}
                AND ${collateEq('pd.id_business', 'dsr.id_business')}
             WHERE ${this.signatureAttentionWhere(permissions)}
             ORDER BY dsr.expires_at ASC, dsr.created_at DESC LIMIT ${ITEM_LIMIT}`,
            { replacements: { _id_business: idBusiness, _scope_login: permissions.scope.idLogin, _scope_profile: permissions.scope.doctorProfileId }, type: QueryTypes.SELECT }
        ).then(rows => rows.map(row => ({
            key: `signature-${row.id}`, type: 'signature', label: patientName(row),
            detail: row.status === 'expired' || (row.expiresAt && new Date(row.expiresAt).getTime() <= Date.now()) ? 'Firma vencida' : (row.title || 'Firma pendiente'),
            patientId: row.patientId, path: `/px/history/${row.patientId}?tab=documents`, expiresAt: toIso(row.expiresAt)
        })));
    }

    recentPatientFlags(permissions) {
        // Consult only modules the actor can read, within the current tenant.
        return {
            history: permissions.clinicalHistoryView ? `NOT EXISTS (
                SELECT 1 FROM clinical_histories ch
                 WHERE ${collateEq('ch.business_id', 'p.id_business')}
                   AND ${collateEq('ch.patient_id', 'p.id_person')}
                   AND ch.deleted_at IS NULL)` : '0',
            appointment: permissions.pxDates ? `NOT EXISTS (
                SELECT 1 FROM appointment ap
                 WHERE ${collateEq('ap.id_business', 'p.id_business')}
                   AND ${collateEq('ap.id_person', 'p.id_person')}
                   AND ap.active = 1 AND TIMESTAMP(ap.appointment_date, ap.start_time) >= NOW()
                   AND ap.status IN ('pending_confirmation', 'confirmed'))` : '0'
        };
    }

    recentPatientSummaryRows(idBusiness, permissions) {
        const flags = this.recentPatientFlags(permissions);
        return sequelize.query(
            `SELECT
                    COUNT(*) AS recentPatients,
                    SUM(${flags.history}) AS withoutClinicalHistory,
                    SUM(${flags.appointment}) AS withoutNextAppointment
               FROM person p
              WHERE ${collateEq('p.id_business', ':_id_business')}
                AND p.active = 1
                AND p.created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)`,
            {
                replacements: { _id_business: idBusiness, _scope_login: permissions.scope.idLogin, _scope_profile: permissions.scope.doctorProfileId },
                type: QueryTypes.SELECT
            }
        );
    }

    recentPatientItems(idBusiness, permissions) {
        const flags = this.recentPatientFlags(permissions);
        return sequelize.query(
            `SELECT p.id_person AS patientId,
                    p.name,
                    p.surname,
                    p.created_at AS createdAt,
                    ${flags.history} AS withoutClinicalHistory,
                    ${flags.appointment} AS withoutNextAppointment
               FROM person p
              WHERE ${collateEq('p.id_business', ':_id_business')}
                AND p.active = 1
                AND p.created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
              ORDER BY (withoutClinicalHistory + withoutNextAppointment) DESC, p.created_at DESC
              LIMIT ${ITEM_LIMIT}`,
            {
                replacements: { _id_business: idBusiness, _scope_login: permissions.scope.idLogin, _scope_profile: permissions.scope.doctorProfileId },
                type: QueryTypes.SELECT
            }
        ).then((rows) => rows.map((row) => {
            const missing = [];
            if (permissions.clinicalHistoryView && Number(row.withoutClinicalHistory) === 1) {
                missing.push('sin historia inicial');
            }
            if (permissions.pxDates && Number(row.withoutNextAppointment) === 1) {
                missing.push('sin proxima cita');
            }

            return {
                key: `recent-${row.patientId}`,
                type: 'recentPatient',
                label: patientName(row),
                detail: missing.length ? missing.join(' y ') : 'Alta reciente',
                patientId: row.patientId,
                path: `/px/history/${row.patientId}`,
                createdAt: toIso(row.createdAt)
            };
        }));
    }

    pulseRows(idBusiness, idLogin, permissions) {
        const columns = [
            permissions.patientActivity ? `(SELECT COUNT(*)
                       FROM person p
                      WHERE ${collateEq('p.id_business', ':_id_business')}
                        AND p.active = 1
                        AND p.created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)) AS patientsNew` : '0 AS patientsNew',
            permissions.prescriptionsReadable ? `(SELECT COUNT(*)
                       FROM prescription pr
                      WHERE ${collateEq('pr.id_business', ':_id_business')}
                        AND pr.active = 1
                        AND pr.status = 'issued'
                        AND COALESCE(pr.issued_at, CONCAT(pr.issue_date, ' 00:00:00')) >= DATE_SUB(NOW(), INTERVAL 7 DAY)
                        ${this.prescriptionOwnershipClause(permissions)}) AS prescriptionsIssued` : '0 AS prescriptionsIssued',
            permissions.clinicalHistoryView ? `(SELECT COUNT(*)
                       FROM clinical_histories ch
                      WHERE ${collateEq('ch.business_id', ':_id_business')}
                        AND ch.status = 'FINALIZED'
                        AND ch.finalized_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
                        AND ch.deleted_at IS NULL ${this.responsibleClause(permissions, 'ch.doctor_responsible_user_id')}) AS clinicalHistoriesFinalized` : '0 AS clinicalHistoriesFinalized',
            permissions.documentsView ? `(SELECT COUNT(*)
                       FROM patient_documents pd
                      WHERE ${collateEq('pd.id_business', ':_id_business')}
                        AND pd.active = 1
                        AND pd.created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY) ${this.responsibleClause(permissions, 'pd.responsible_doctor_user_id')}) AS documentsCreated` : '0 AS documentsCreated'
        ];
        return sequelize.query(
            `SELECT ${columns.join(', ')}`,
            {
                replacements: { _id_business: idBusiness, _id_login: idLogin, _scope_login: permissions.scope.idLogin, _scope_profile: permissions.scope.doctorProfileId },
                type: QueryTypes.SELECT
            }
        ).then((rows) => {
            const row = rows[0] || {};
            return [{
                patientsNew: permissions.patientActivity ? row.patientsNew : 0,
                prescriptionsIssued: permissions.prescriptionsReadable ? row.prescriptionsIssued : 0,
                clinicalHistoriesFinalized: permissions.clinicalHistoryView ? row.clinicalHistoriesFinalized : 0,
                documentsCreated: permissions.documentsView ? row.documentsCreated : 0
            }];
        });
    }
}

module.exports = new HomeContinuityDao();

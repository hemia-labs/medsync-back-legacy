const { QueryTypes } = require('sequelize');
const sequelize = require('../../db/Sequelize.connection');
const responseData = require('../../util/responsedata');
const Messages = require('../../util/common.messages.util');
const { SequelizeException } = require('../../util/sequelizeException');
const UserDao = require('./user.dao');

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
    async summary(idBusiness, idLogin) {
        if (!idBusiness || !idLogin) {
            return responseData.unauthorized('No hay sesion activa para consultar continuidad clinica.');
        }

        try {
            const permissions = await this.resolvePermissions(idLogin);
            const [drafts, signatures, recentPatients, pulse] = await Promise.all([
                this.draftsSection(idBusiness, idLogin, permissions),
                this.signaturesSection(idBusiness, permissions),
                this.recentPatientsSection(idBusiness, permissions),
                this.pulseSection(idBusiness, idLogin, permissions)
            ]);

            return responseData.success({
                generatedAt: new Date().toISOString(),
                refreshAfterSeconds: 3600,
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

    async resolvePermissions(idLogin) {
        const checks = await Promise.all([
            UserDao.hasPermission(idLogin, 'px.all'),
            UserDao.hasPermission(idLogin, 'px.dates'),
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
            prescriptionsGlobal,
            prescriptionsViewAll,
            prescriptionsViewOwn,
            prescriptionsCanViewAll: prescriptionsGlobal || prescriptionsViewAll,
            prescriptionsReadable: prescriptionsGlobal || prescriptionsViewAll || prescriptionsViewOwn,
            documentsView,
            documentsSign,
            dashboard: dashboardTenant || reportsDashboard || legacyDashboard
        };
    }

    prescriptionOwnershipClause(permissions) {
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
            summaryCard('clinical', 'Historias en borrador', numberValue(clinicalRows), 'warning'),
            summaryCard('prescriptions', 'Recetas sin emitir', numberValue(prescriptionRows), 'accent'),
            summaryCard('documents', 'Documentos en borrador', numberValue(documentRows), 'neutral')
        ];
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
            available: permissions.pxAll || permissions.prescriptionsReadable || permissions.documentsView,
            cards,
            items,
            action: permissions.pxAll
                ? action('Revisar pacientes', '/px/all', 'px.all')
                : (permissions.prescriptionsReadable ? action('Ir a recetas', '/prescriptions', 'prescriptions.view.own') : null)
        };
    }

    async signaturesSection(idBusiness, permissions) {
        const rows = permissions.documentsView || permissions.documentsSign
            ? await this.signatureSummaryRows(idBusiness)
            : [];
        const row = rows[0] || {};
        const pending = numberValue(row, 'pending');
        const expiringSoon = numberValue(row, 'expiringSoon');
        const expired = numberValue(row, 'expired');
        const total = pending + expired;
        const items = permissions.pxAll && (permissions.documentsView || permissions.documentsSign)
            ? await this.signatureItems(idBusiness)
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
            available: permissions.documentsView || permissions.documentsSign,
            cards: [
                summaryCard('pending', 'Pendientes', pending, 'accent'),
                summaryCard('expiringSoon', 'Por vencer', expiringSoon, 'warning'),
                summaryCard('expired', 'Vencidas', expired, 'danger')
            ],
            items,
            action: permissions.pxAll ? action('Ver expedientes', '/px/all', 'px.all') : null
        };
    }

    async recentPatientsSection(idBusiness, permissions) {
        const rows = permissions.pxAll ? await this.recentPatientSummaryRows(idBusiness) : [];
        const row = rows[0] || {};
        const total = numberValue(row, 'recentPatients');
        const withoutClinicalHistory = numberValue(row, 'withoutClinicalHistory');
        const withoutNextAppointment = numberValue(row, 'withoutNextAppointment');
        const items = permissions.pxAll ? await this.recentPatientItems(idBusiness) : [];

        return {
            key: 'recentPatients',
            label: 'Pacientes recientes',
            eyebrow: 'Seguimiento',
            title: total ? `${total} paciente${total === 1 ? '' : 's'} nuevo${total === 1 ? '' : 's'} esta semana` : 'Sin pacientes nuevos',
            description: total
                ? 'Detecta altas recientes que aun necesitan historia o proxima cita.'
                : 'No hay altas recientes que requieran seguimiento.',
            icon: 'mdi-account-clock-outline',
            total,
            available: permissions.pxAll,
            cards: [
                summaryCard('recent', 'Altas recientes', total, 'neutral'),
                summaryCard('withoutHistory', 'Sin historia inicial', withoutClinicalHistory, 'warning'),
                summaryCard('withoutAppointment', 'Sin proxima cita', withoutNextAppointment, 'accent')
            ],
            items,
            action: permissions.pxAll ? action('Ver pacientes', '/px/all', 'px.all') : null
        };
    }

    async pulseSection(idBusiness, idLogin, permissions) {
        const rows = await this.pulseRows(idBusiness, idLogin, permissions);
        const row = rows[0] || {};
        const cards = [
            summaryCard('patients', 'Pacientes nuevos', numberValue(row, 'patientsNew'), 'neutral'),
            summaryCard('prescriptions', 'Recetas emitidas', numberValue(row, 'prescriptionsIssued'), 'accent'),
            summaryCard('histories', 'Historias finalizadas', numberValue(row, 'clinicalHistoriesFinalized'), 'success'),
            summaryCard('documents', 'Documentos generados', numberValue(row, 'documentsCreated'), 'neutral')
        ];
        const total = cards.reduce((sum, item) => sum + item.value, 0);

        return {
            key: 'pulse',
            label: 'Pulso del consultorio',
            eyebrow: 'Semana',
            title: total ? 'Movimiento de los ultimos 7 dias' : 'Semana tranquila',
            description: total
                ? 'Resumen breve de actividad operativa reciente.'
                : 'Aun no hay actividad registrada en los ultimos 7 dias.',
            icon: 'mdi-pulse',
            total,
            available: true,
            cards,
            items: [],
            action: permissions.dashboard ? action('Ir al dashboard', '/dashboard', 'dashboard.tenant') : null
        };
    }

    countClinicalDrafts(idBusiness, permissions) {
        if (!permissions.pxAll) {
            return [];
        }

        return sequelize.query(
            `SELECT COUNT(*) AS total
               FROM clinical_histories ch
              WHERE ${collateEq('ch.business_id', ':_id_business')}
                AND ch.status = 'DRAFT'
                AND ch.deleted_at IS NULL`,
            {
                replacements: { _id_business: idBusiness },
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
                replacements: { _id_business: idBusiness, _id_login: idLogin },
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
                AND pd.active = 1`,
            {
                replacements: { _id_business: idBusiness },
                type: QueryTypes.SELECT
            }
        );
    }

    async draftItems(idBusiness, idLogin, permissions) {
        const queries = [];

        queries.push(sequelize.query(
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
                AND ch.deleted_at IS NULL
              ORDER BY ch.updated_at DESC, ch.created_at DESC
              LIMIT ${ITEM_LIMIT}`,
            {
                replacements: { _id_business: idBusiness },
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
                    replacements: { _id_business: idBusiness, _id_login: idLogin },
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
                    AND pd.active = 1
                  ORDER BY COALESCE(pd.updated_at, pd.created_at) DESC
                  LIMIT ${ITEM_LIMIT}`,
                {
                    replacements: { _id_business: idBusiness },
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
                path: `/px/history/${row.patientId}`,
                createdAt: toIso(row.dateValue)
            }));
    }

    signatureSummaryRows(idBusiness) {
        return sequelize.query(
            `SELECT
                    SUM(CASE WHEN dsr.status = 'pending' THEN 1 ELSE 0 END) AS pending,
                    SUM(CASE WHEN dsr.status = 'pending' AND dsr.expires_at >= NOW() AND dsr.expires_at <= DATE_ADD(NOW(), INTERVAL 48 HOUR) THEN 1 ELSE 0 END) AS expiringSoon,
                    SUM(CASE WHEN dsr.status = 'pending' AND dsr.expires_at < NOW() THEN 1 ELSE 0 END) AS expired
               FROM document_signature_requests dsr
              WHERE ${collateEq('dsr.id_business', ':_id_business')}`,
            {
                replacements: { _id_business: idBusiness },
                type: QueryTypes.SELECT
            }
        );
    }

    signatureItems(idBusiness) {
        return sequelize.query(
            `SELECT dsr.id_document_signature_request AS id,
                    dsr.id_person AS patientId,
                    dsr.signature_role AS signatureRole,
                    dsr.expires_at AS expiresAt,
                    p.name,
                    p.surname,
                    pd.title
               FROM document_signature_requests dsr
               INNER JOIN person p
                       ON ${collateEq('p.id_person', 'dsr.id_person')}
                      AND ${collateEq('p.id_business', 'dsr.id_business')}
               LEFT JOIN patient_documents pd
                      ON ${collateEq('pd.id_patient_document', 'dsr.id_patient_document')}
                     AND ${collateEq('pd.id_business', 'dsr.id_business')}
              WHERE ${collateEq('dsr.id_business', ':_id_business')}
                AND dsr.status = 'pending'
              ORDER BY CASE WHEN dsr.expires_at < NOW() THEN 0 ELSE 1 END,
                       dsr.expires_at ASC,
                       dsr.created_at DESC
              LIMIT ${ITEM_LIMIT}`,
            {
                replacements: { _id_business: idBusiness },
                type: QueryTypes.SELECT
            }
        ).then((rows) => rows.map((row) => ({
            key: `signature-${row.id}`,
            type: 'signature',
            label: patientName(row),
            detail: row.expiresAt && new Date(row.expiresAt).getTime() < Date.now()
                ? 'Firma vencida'
                : (row.title || 'Firma pendiente'),
            patientId: row.patientId,
            path: `/px/history/${row.patientId}`,
            expiresAt: toIso(row.expiresAt)
        })));
    }

    recentPatientSummaryRows(idBusiness) {
        return sequelize.query(
            `SELECT
                    COUNT(*) AS recentPatients,
                    SUM(CASE WHEN ch.id_clinical_history IS NULL THEN 1 ELSE 0 END) AS withoutClinicalHistory,
                    SUM(CASE WHEN next_appointment.id_appointment IS NULL THEN 1 ELSE 0 END) AS withoutNextAppointment
               FROM person p
               LEFT JOIN (
                    SELECT business_id, patient_id, MIN(id_clinical_history) AS id_clinical_history
                      FROM clinical_histories
                     WHERE deleted_at IS NULL
                     GROUP BY business_id, patient_id
               ) ch
                      ON ${collateEq('ch.business_id', 'p.id_business')}
                     AND ${collateEq('ch.patient_id', 'p.id_person')}
               LEFT JOIN (
                    SELECT id_business, id_person, MIN(id_appointment) AS id_appointment
                      FROM appointment
                     WHERE active = 1
                       AND appointment_date >= CURDATE()
                       AND status NOT IN ('cancelled', 'no_show')
                     GROUP BY id_business, id_person
               ) next_appointment
                      ON ${collateEq('next_appointment.id_business', 'p.id_business')}
                     AND ${collateEq('next_appointment.id_person', 'p.id_person')}
              WHERE ${collateEq('p.id_business', ':_id_business')}
                AND p.active = 1
                AND p.created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)`,
            {
                replacements: { _id_business: idBusiness },
                type: QueryTypes.SELECT
            }
        );
    }

    recentPatientItems(idBusiness) {
        return sequelize.query(
            `SELECT p.id_person AS patientId,
                    p.name,
                    p.surname,
                    p.created_at AS createdAt,
                    CASE WHEN ch.id_clinical_history IS NULL THEN 1 ELSE 0 END AS withoutClinicalHistory,
                    CASE WHEN next_appointment.id_appointment IS NULL THEN 1 ELSE 0 END AS withoutNextAppointment
               FROM person p
               LEFT JOIN (
                    SELECT business_id, patient_id, MIN(id_clinical_history) AS id_clinical_history
                      FROM clinical_histories
                     WHERE deleted_at IS NULL
                     GROUP BY business_id, patient_id
               ) ch
                      ON ${collateEq('ch.business_id', 'p.id_business')}
                     AND ${collateEq('ch.patient_id', 'p.id_person')}
               LEFT JOIN (
                    SELECT id_business, id_person, MIN(id_appointment) AS id_appointment
                      FROM appointment
                     WHERE active = 1
                       AND appointment_date >= CURDATE()
                       AND status NOT IN ('cancelled', 'no_show')
                     GROUP BY id_business, id_person
               ) next_appointment
                      ON ${collateEq('next_appointment.id_business', 'p.id_business')}
                     AND ${collateEq('next_appointment.id_person', 'p.id_person')}
              WHERE ${collateEq('p.id_business', ':_id_business')}
                AND p.active = 1
                AND p.created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
              ORDER BY (withoutClinicalHistory + withoutNextAppointment) DESC, p.created_at DESC
              LIMIT ${ITEM_LIMIT}`,
            {
                replacements: { _id_business: idBusiness },
                type: QueryTypes.SELECT
            }
        ).then((rows) => rows.map((row) => {
            const missing = [];
            if (Number(row.withoutClinicalHistory) === 1) {
                missing.push('sin historia inicial');
            }
            if (Number(row.withoutNextAppointment) === 1) {
                missing.push('sin proxima cita');
            }

            return {
                key: `recent-${row.patientId}`,
                type: 'recentPatient',
                label: patientName(row),
                detail: missing.length ? missing.join(' y ') : 'Alta reciente completa',
                patientId: row.patientId,
                path: `/px/history/${row.patientId}`,
                createdAt: toIso(row.createdAt)
            };
        }));
    }

    pulseRows(idBusiness, idLogin, permissions) {
        return sequelize.query(
            `SELECT
                    (SELECT COUNT(*)
                       FROM person p
                      WHERE ${collateEq('p.id_business', ':_id_business')}
                        AND p.active = 1
                        AND p.created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)) AS patientsNew,
                    (SELECT COUNT(*)
                       FROM prescription pr
                      WHERE ${collateEq('pr.id_business', ':_id_business')}
                        AND pr.active = 1
                        AND pr.status = 'issued'
                        AND COALESCE(pr.issued_at, CONCAT(pr.issue_date, ' 00:00:00')) >= DATE_SUB(NOW(), INTERVAL 7 DAY)
                        ${this.prescriptionOwnershipClause(permissions)}) AS prescriptionsIssued,
                    (SELECT COUNT(*)
                       FROM clinical_histories ch
                      WHERE ${collateEq('ch.business_id', ':_id_business')}
                        AND ch.status = 'FINALIZED'
                        AND ch.finalized_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
                        AND ch.deleted_at IS NULL) AS clinicalHistoriesFinalized,
                    (SELECT COUNT(*)
                       FROM patient_documents pd
                      WHERE ${collateEq('pd.id_business', ':_id_business')}
                        AND pd.active = 1
                        AND pd.created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)) AS documentsCreated`,
            {
                replacements: { _id_business: idBusiness, _id_login: idLogin },
                type: QueryTypes.SELECT
            }
        ).then((rows) => {
            const row = rows[0] || {};
            return [{
                patientsNew: permissions.pxAll ? row.patientsNew : 0,
                prescriptionsIssued: permissions.prescriptionsReadable ? row.prescriptionsIssued : 0,
                clinicalHistoriesFinalized: permissions.pxAll ? row.clinicalHistoriesFinalized : 0,
                documentsCreated: permissions.documentsView ? row.documentsCreated : 0
            }];
        });
    }
}

module.exports = new HomeContinuityDao();

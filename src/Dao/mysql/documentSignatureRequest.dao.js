const effectivePermissions = require('../../util/effectivePermissions');
const { QueryTypes } = require('sequelize');
const { v4: uuidv4 } = require('uuid');
const sequelize = require('../../db/Sequelize.connection');
const responseData = require('../../util/responsedata');
const Messages = require('../../util/common.messages.util');
const { SequelizeException } = require('../../util/sequelizeException');
const {
    createSignatureTokenPayload
} = require('../../services/documentSignature/documentSignatureToken.service');
const {
    SIGNATURE_REQUEST_PERMISSION,
    SIGNATURE_REQUEST_CHANNELS,
    SIGNATURE_REQUEST_STATUSES,
    REMOTE_SIGNATURE_ROLES,
    DOCUMENT_STATUSES_ALLOWED_FOR_REMOTE_REQUEST,
    ACTIVE_SIGNATURE_REQUEST_STATUSES,
    DOCUMENT_SIGNATURE_EVENTS
} = require('../../services/documentSignature/documentSignatureRequest.constants');
const EmailService = require('../../services/email/email.service');
const planConsentDocuments = require('../../services/documentSignature/treatmentPlanConsentDocument.service');
const documentRequirements = require('../../services/documentSignature/documentRequirements.service');

const TENANT_COLLATION = 'utf8mb4_unicode_ci';
const collateEq = (left, param) => `${left} COLLATE ${TENANT_COLLATION} = ${param} COLLATE ${TENANT_COLLATION}`;

const VALID_CHANNELS = Object.values(SIGNATURE_REQUEST_CHANNELS);
const VALID_REMOTE_SIGNATURE_ROLES = Object.values(REMOTE_SIGNATURE_ROLES);
const SUCCESS_STATUS = 200;
const FORBIDDEN_STATUS = 403;
const BAD_GATEWAY_STATUS = 502;
const emailProviderName = () => String(process.env.EMAIL_PROVIDER || 'smtp').trim().toLowerCase() || 'smtp';

function success(data, message) {
    return {
        status: SUCCESS_STATUS,
        success: true,
        data,
        message
    };
}

function forbidden(message) {
    return {
        status: FORBIDDEN_STATUS,
        success: false,
        data: null,
        message
    };
}

function controlledFailure(status, code, message, data = null) {
    return {
        status,
        success: false,
        code,
        data,
        message
    };
}

function normalizeChannel(channel) {
    return String(channel || '').trim().toLowerCase();
}

function normalizeSignatureRole(signatureRole) {
    return String(signatureRole || '').trim().toUpperCase();
}

function normalizeNullableString(value) {
    const normalized = String(value || '').trim();
    return normalized || null;
}

function normalizeEmail(value) {
    const normalized = String(value || '').trim().toLowerCase();
    return normalized ? normalized.slice(0, 255) : null;
}

function normalizePhone(value) {
    const normalized = String(value || '').trim().replace(/[^\d+]/g, '');
    return normalized || null;
}

function isValidEmail(value) {
    if (!value) {
        return true;
    }

    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value).trim()) && String(value).trim().length <= 255;
}

function maskPhone(value) {
    const phone = normalizePhone(value);
    if (!phone) {
        return null;
    }

    if (phone.length <= 4) {
        return '****';
    }

    return `${'*'.repeat(Math.max(phone.length - 4, 0))}${phone.slice(-4)}`;
}

function maskEmail(value) {
    const email = normalizeEmail(value);
    if (!email) {
        return null;
    }

    const parts = email.split('@');
    if (parts.length !== 2) {
        return '[email]';
    }

    const name = parts[0];
    const domain = parts[1];
    const visibleName = `${name[0] || ''}***`;
    return `${visibleName}@${domain}`;
}

function redactSensitiveText(value) {
    return String(value || '')
        .replace(/\/sign\/d\/[A-Za-z0-9_-]+/g, '/sign/d/[redacted]')
        .replace(/[A-Za-z0-9_-]{43,}/g, '[redacted]')
        .slice(0, 300);
}

function safeEventNotes(message, metadata) {
    const payload = {
        message,
        metadata
    };

    const serialized = JSON.stringify(payload);
    return serialized.length > 1000 ? serialized.slice(0, 997) + '...' : serialized;
}

function toIso(value) {
    if (!value) {
        return null;
    }

    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function displayName(row) {
    return `${row.patient_name || ''} ${row.patient_surname || ''}`.trim();
}

function documentTitle(row) {
    const labels = {
        SENSITIVE_DATA_CONSENT: 'Consentimiento de datos personales sensibles',
        TREATMENT_PLAN_CONSENT: 'Consentimiento del plan de tratamiento',
        GENERAL_ATTENTION_CONSENT: 'Consentimiento general de atencion',
        CUSTOM_DOCUMENT: 'Documento personalizado',
        CUSTOM: 'Documento personalizado'
    };
    return row.title || labels[row.document_type] || 'Documento clinico';
}

function formatEmailDateTime(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (!value || Number.isNaN(date.getTime())) {
        return 'la fecha indicada';
    }

    return new Intl.DateTimeFormat('es-MX', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'America/Mexico_City'
    }).format(date);
}

class DocumentSignatureRequestDao {
    async hasPermission(idLogin, permission) {
        return effectivePermissions.hasPermission(idLogin, permission, {enabledCatalog:true});
    }

    async assertRequestPermission(body) {
        if (String(body.rol || '').toLowerCase() === 'super_admin') {
            return forbidden('Super Admin no puede operar solicitudes de firma clinicas.');
        }

        if (!body.id_business) {
            return forbidden('No hay negocio activo para operar solicitudes de firma.');
        }

        const allowed = await this.hasPermission(body.id_login, SIGNATURE_REQUEST_PERMISSION);
        if (!allowed) {
            return forbidden('No tienes permiso para solicitar firmas remotas.');
        }

        return null;
    }

    requiredSignatureRoles(document) {
        const roles = [];
        if (document.guardian_name_snapshot || document.requires_tutor_signature === 1) {
            roles.push(REMOTE_SIGNATURE_ROLES.TUTOR);
        } else if (document.requires_patient_signature !== 0) {
            roles.push(REMOTE_SIGNATURE_ROLES.PATIENT);
        }

        if (document.requires_doctor_signature !== 0) {
            roles.push('DOCTOR');
        }

        if (document.requires_witness1_signature === 1) {
            roles.push('WITNESS1');
        }

        if (document.requires_witness2_signature === 1) {
            roles.push('WITNESS2');
        }

        return roles;
    }

    completedSignatureRoles(document, signatures) {
        const roles = signatures
            .filter((signature) => signature.signature_image || signature.signed_at)
            .map((signature) => signature.signature_role);

        if (document.doctor_signature_snapshot) {
            roles.push('DOCTOR');
        }

        return [...new Set(roles)];
    }

    async getDocumentForRequest(idBusiness, idPatientDocument, transaction = null, forUpdate = false) {
        const rows = await sequelize.query(
            `SELECT pd.id_patient_document, pd.id_business, pd.id_person, pd.document_type, pd.origin, pd.treatment_plan_id,
                    pd.status, pd.active, pd.guardian_name_snapshot, pd.doctor_signature_snapshot,
                    dt.requires_patient_signature, dt.requires_tutor_signature, dt.requires_doctor_signature,
                    dt.requires_witness1_signature, dt.requires_witness2_signature
               FROM patient_documents pd
               LEFT JOIN document_templates dt
                      ON ${collateEq('dt.id_document_template', 'pd.id_document_template')}
              WHERE ${collateEq('pd.id_patient_document', ':_id_patient_document')}
                AND ${collateEq('pd.id_business', ':_id_business')}
                AND pd.active = 1
              LIMIT 1 ${forUpdate ? 'FOR UPDATE' : ''}`,
            {
                replacements: {
                    _id_patient_document: idPatientDocument,
                    _id_business: idBusiness
                },
                type: QueryTypes.SELECT,
                transaction
            }
        );

        const document = await documentRequirements.decorate(rows[0], idBusiness, transaction);
        return document ? planConsentDocuments.decorate(document, transaction) : null;
    }

    async getDocumentSignatures(idBusiness, idPatientDocument, transaction = null) {
        return sequelize.query(
            `SELECT signature_role, signature_image, signed_at
               FROM patient_document_signatures
              WHERE ${collateEq('id_patient_document', ':_id_patient_document')}
                AND ${collateEq('id_business', ':_id_business')}`,
            {
                replacements: {
                    _id_patient_document: idPatientDocument,
                    _id_business: idBusiness
                },
                type: QueryTypes.SELECT,
                transaction
            }
        );
    }

    async validatePatientTenant(document, transaction = null) {
        const rows = await sequelize.query(
            `SELECT id_person
               FROM person
              WHERE ${collateEq('id_person', ':_id_person')}
                AND ${collateEq('id_business', ':_id_business')}
                AND active = 1
              LIMIT 1`,
            {
                replacements: {
                    _id_person: document.id_person,
                    _id_business: document.id_business
                },
                type: QueryTypes.SELECT,
                transaction
            }
        );

        return rows.length > 0;
    }

    validateDocumentCanRequest(document) {
        if (!DOCUMENT_STATUSES_ALLOWED_FOR_REMOTE_REQUEST.includes(document.status)) {
            return responseData.bad_request('Este documento no esta disponible para solicitar firma remota.');
        }

        return null;
    }

    validatePendingSignature(document, signatures, signatureRole) {
        const requiredRoles = this.requiredSignatureRoles(document);
        if (!requiredRoles.includes(signatureRole)) {
            return responseData.bad_request('La firma solicitada no aplica para este documento.');
        }

        const completedRoles = this.completedSignatureRoles(document, signatures);
        if (completedRoles.includes(signatureRole)) {
            return responseData.bad_request('La firma solicitada ya fue capturada para este documento.');
        }

        return null;
    }

    async addEvent(document, idLogin, eventType, notes, transaction = null) {
        await sequelize.query(
            `INSERT INTO patient_document_events (
                id_patient_document_event, id_patient_document, id_business, event_type,
                notes, created_at, created_by
            ) VALUES (
                :_id_patient_document_event, :_id_patient_document, :_id_business, :_event_type,
                :_notes, NOW(), :_id_login
            )`,
            {
                replacements: {
                    _id_patient_document_event: uuidv4(),
                    _id_patient_document: document.id_patient_document,
                    _id_business: document.id_business,
                    _event_type: eventType,
                    _notes: notes,
                    _id_login: idLogin
                },
                type: QueryTypes.INSERT,
                transaction
            }
        );
    }

    mapRequestRow(row) {
        return {
            id_document_signature_request: row.id_document_signature_request,
            id_patient_document: row.id_patient_document,
            signature_role: row.signature_role,
            channel: row.channel,
            status: row.status,
            expires_at: toIso(row.expires_at),
            opened_at: toIso(row.opened_at),
            signed_at: toIso(row.signed_at),
            revoked_at: toIso(row.revoked_at),
            recipient_email: row.recipient_email || null,
            recipient_phone: row.recipient_phone || null,
            created_at: toIso(row.created_at),
            token_fingerprint: row.token_fingerprint || null
        };
    }

    async getEmailContext(idBusiness, idPatientDocument) {
        const rows = await sequelize.query(
            `SELECT pd.id_patient_document, pd.id_business, pd.id_person, pd.document_type,
                    pd.title, pd.doctor_name_snapshot,
                    p.name AS patient_name, p.surname AS patient_surname,
                    b.name AS business_name, b.legal_name AS business_legal_name,
                    b.logo_url AS business_logo_url
               FROM patient_documents pd
              INNER JOIN person p
                      ON ${collateEq('p.id_person', 'pd.id_person')}
                     AND ${collateEq('p.id_business', 'pd.id_business')}
              LEFT JOIN business b
                     ON ${collateEq('b.id_business', 'pd.id_business')}
              WHERE ${collateEq('pd.id_business', ':_id_business')}
                AND ${collateEq('pd.id_patient_document', ':_id_patient_document')}
                AND pd.active = 1
              LIMIT 1`,
            {
                replacements: {
                    _id_business: idBusiness,
                    _id_patient_document: idPatientDocument
                },
                type: QueryTypes.SELECT
            }
        );

        return rows[0] || null;
    }

    async markRequestFailed(idBusiness, idSignatureRequest) {
        await sequelize.query(
            `UPDATE document_signature_requests
                SET status = :_failed_status,
                    updated_at = NOW()
              WHERE ${collateEq('id_business', ':_id_business')}
                AND ${collateEq('id_document_signature_request', ':_id_document_signature_request')}`,
            {
                replacements: {
                    _id_business: idBusiness,
                    _id_document_signature_request: idSignatureRequest,
                    _failed_status: SIGNATURE_REQUEST_STATUSES.FAILED
                },
                type: QueryTypes.UPDATE
            }
        );
    }

    async create(body) {
        const permissionError = await this.assertRequestPermission(body);
        if (permissionError) {
            return permissionError;
        }

        const idPatientDocument = normalizeNullableString(body.id_patient_document);
        const signatureRole = normalizeSignatureRole(body.signature_role);
        const channel = normalizeChannel(body.channel);
        const rawRecipientEmail = normalizeEmail(body.recipient_email);
        const recipientPhone = channel === SIGNATURE_REQUEST_CHANNELS.WHATSAPP ? normalizePhone(body.recipient_phone) : null;
        const recipientEmail = channel === SIGNATURE_REQUEST_CHANNELS.EMAIL ? rawRecipientEmail : null;

        if (!idPatientDocument) {
            return responseData.bad_request('id_patient_document es requerido.');
        }

        if (!VALID_REMOTE_SIGNATURE_ROLES.includes(signatureRole)) {
            return responseData.bad_request('Rol de firma remota invalido.');
        }

        if (!VALID_CHANNELS.includes(channel)) {
            return responseData.bad_request('Canal de firma remota invalido.');
        }

        if (recipientEmail && !isValidEmail(recipientEmail)) {
            return responseData.bad_request('recipient_email no tiene un formato valido.');
        }

        let tokenPayload;
        const transaction = await sequelize.transaction();
        try {
            const document = await this.getDocumentForRequest(body.id_business, idPatientDocument, transaction, true);
            if (!document) {
                await transaction.rollback();
                return responseData.bad_request('Documento no encontrado.');
            }

            if (planConsentDocuments.isLinked(document)) {
                const canUsePlan = await this.hasPermission(body.id_login, 'treatments.view') &&
                    (await this.hasPermission(body.id_login, 'treatments.consent.view') || await this.hasPermission(body.id_login, 'treatments.consent.sign'));
                if (!canUsePlan || !await planConsentDocuments.assertCurrent(document, transaction)) {
                    await transaction.rollback();
                    return forbidden('No puedes solicitar firma para esta versión del plan. Consulta el plan y prepara una versión vigente.');
                }
            }

            const patientBelongsToTenant = await this.validatePatientTenant(document, transaction);
            if (!patientBelongsToTenant) {
                await transaction.rollback();
                return responseData.bad_request('Documento fuera del tenant activo.');
            }

            const documentError = this.validateDocumentCanRequest(document);
            if (documentError) {
                await transaction.rollback();
                return documentError;
            }

            const signatures = await this.getDocumentSignatures(body.id_business, idPatientDocument, transaction);
            const signatureError = this.validatePendingSignature(document, signatures, signatureRole);
            if (signatureError) {
                await transaction.rollback();
                return signatureError;
            }

            try {
                tokenPayload = createSignatureTokenPayload(channel, body.expires_in_minutes);
            } catch (error) {
                await transaction.rollback();
                return error.code && error.code.indexOf('SIGNATURE_TTL_') === 0
                    ? responseData.bad_request(error.message)
                    : responseData.error(error.message);
            }

            const previousRequests = await sequelize.query(
                `SELECT id_document_signature_request, channel, signature_role, expires_at, token_fingerprint
                   FROM document_signature_requests
                  WHERE ${collateEq('id_business', ':_id_business')}
                    AND ${collateEq('id_patient_document', ':_id_patient_document')}
                    AND ${collateEq('signature_role', ':_signature_role')}
                    AND status IN (:_active_statuses)
                  FOR UPDATE`,
                {
                    replacements: {
                        _id_business: body.id_business,
                        _id_patient_document: idPatientDocument,
                        _signature_role: signatureRole,
                        _active_statuses: ACTIVE_SIGNATURE_REQUEST_STATUSES
                    },
                    type: QueryTypes.SELECT,
                    transaction
                }
            );

            if (previousRequests.length > 0) {
                await sequelize.query(
                    `UPDATE document_signature_requests
                        SET status = :_revoked_status,
                            revoked_at = NOW(),
                            revoked_by = :_id_login,
                            updated_at = NOW()
                      WHERE ${collateEq('id_business', ':_id_business')}
                        AND ${collateEq('id_patient_document', ':_id_patient_document')}
                        AND ${collateEq('signature_role', ':_signature_role')}
                        AND status IN (:_active_statuses)`,
                    {
                        replacements: {
                            _id_business: body.id_business,
                            _id_patient_document: idPatientDocument,
                            _signature_role: signatureRole,
                            _active_statuses: ACTIVE_SIGNATURE_REQUEST_STATUSES,
                            _revoked_status: SIGNATURE_REQUEST_STATUSES.REVOKED,
                            _id_login: body.id_login
                        },
                        type: QueryTypes.UPDATE,
                        transaction
                    }
                );

                for (const previous of previousRequests) {
                    await this.addEvent(
                        document,
                        body.id_login,
                        DOCUMENT_SIGNATURE_EVENTS.LINK_REVOKED,
                        safeEventNotes('Solicitud de firma remota revocada por reemplazo.', {
                            signature_request_id: previous.id_document_signature_request,
                            channel: previous.channel,
                            signature_role: previous.signature_role,
                            expires_at: toIso(previous.expires_at),
                            token_fingerprint: previous.token_fingerprint || null,
                            reason: 'replaced_by_new_request'
                        }),
                        transaction
                    );
                }
            }

            const idSignatureRequest = uuidv4();
            const metadata = {
                created_from: 'internal_authenticated_endpoint',
                ttl_minutes: tokenPayload.ttlMinutes,
                recipient_phone_masked: maskPhone(recipientPhone),
                recipient_email_masked: maskEmail(recipientEmail)
            };

            await sequelize.query(
                `INSERT INTO document_signature_requests (
                    id_document_signature_request, id_business, id_person, id_patient_document,
                    document_type, signature_role, channel, status, token_hash, token_fingerprint,
                    expires_at, created_by, recipient_phone, recipient_email, metadata_json,
                    created_at, updated_at
                ) VALUES (
                    :_id_document_signature_request, :_id_business, :_id_person, :_id_patient_document,
                    :_document_type, :_signature_role, :_channel, :_status, :_token_hash, :_token_fingerprint,
                    DATE_ADD(NOW(), INTERVAL :_ttl_minutes MINUTE), :_created_by, :_recipient_phone, :_recipient_email, :_metadata_json,
                    NOW(), NOW()
                )`,
                {
                    replacements: {
                        _id_document_signature_request: idSignatureRequest,
                        _id_business: body.id_business,
                        _id_person: document.id_person,
                        _id_patient_document: document.id_patient_document,
                        _document_type: document.document_type,
                        _signature_role: signatureRole,
                        _channel: channel,
                        _status: SIGNATURE_REQUEST_STATUSES.PENDING,
                        _token_hash: tokenPayload.tokenHash,
                        _token_fingerprint: tokenPayload.tokenFingerprint,
                        _ttl_minutes: tokenPayload.ttlMinutes,
                        _created_by: body.id_login,
                        _recipient_phone: recipientPhone,
                        _recipient_email: recipientEmail,
                        _metadata_json: JSON.stringify(metadata)
                    },
                    type: QueryTypes.INSERT,
                    transaction
                }
            );

            const createdRequestRows = await sequelize.query(
                `SELECT expires_at
                   FROM document_signature_requests
                  WHERE ${collateEq('id_document_signature_request', ':_id_document_signature_request')}
                  LIMIT 1`,
                {
                    replacements: { _id_document_signature_request: idSignatureRequest },
                    type: QueryTypes.SELECT,
                    transaction
                }
            );
            const createdExpiresAt = createdRequestRows[0] ? createdRequestRows[0].expires_at : null;

            await this.addEvent(
                document,
                body.id_login,
                DOCUMENT_SIGNATURE_EVENTS.LINK_CREATED,
                safeEventNotes('Solicitud de firma remota creada.', {
                    signature_request_id: idSignatureRequest,
                    channel,
                    signature_role: signatureRole,
                    expires_at: toIso(createdExpiresAt),
                    token_fingerprint: tokenPayload.tokenFingerprint,
                    recipient_phone_masked: maskPhone(recipientPhone),
                    recipient_email_masked: maskEmail(recipientEmail)
                }),
                transaction
            );

            await transaction.commit();

            return success({
                id_document_signature_request: idSignatureRequest,
                id_patient_document: document.id_patient_document,
                signature_role: signatureRole,
                channel,
                status: SIGNATURE_REQUEST_STATUSES.PENDING,
                public_url: tokenPayload.publicUrl,
                expires_at: toIso(createdExpiresAt),
                token_fingerprint: tokenPayload.tokenFingerprint
            }, 'Solicitud de firma creada.');
        } catch (error) {
            await transaction.rollback();
            return SequelizeException(error, Messages.DATA_SAVE_ERROR);
        }
    }

    async sendEmail(body) {
        const recipientEmail = normalizeEmail(body.recipient_email);
        if (!recipientEmail || !isValidEmail(recipientEmail)) {
            return responseData.bad_request('recipient_email no tiene un formato valido.');
        }

        let createdRequest = null;
        let emailContext = null;

        try {
            const createResponse = await this.create({
                ...body,
                channel: SIGNATURE_REQUEST_CHANNELS.EMAIL,
                recipient_email: recipientEmail,
                recipient_phone: null,
                expires_in_minutes: null
            });

            if (!createResponse || !createResponse.success) {
                return createResponse;
            }

            createdRequest = createResponse.data;
            emailContext = await this.getEmailContext(body.id_business, createdRequest.id_patient_document);

            if (!emailContext) {
                await this.markRequestFailed(body.id_business, createdRequest.id_document_signature_request);
                return controlledFailure(
                    400,
                    'SIGNATURE_EMAIL_CONTEXT_NOT_FOUND',
                    'No se pudo preparar el correo de firma.'
                );
            }

            await this.addEvent(
                emailContext,
                body.id_login,
                DOCUMENT_SIGNATURE_EVENTS.LINK_SEND_EMAIL_ATTEMPT,
                safeEventNotes('Intento de envio de correo de firma remota.', {
                    signature_request_id: createdRequest.id_document_signature_request,
                    channel: SIGNATURE_REQUEST_CHANNELS.EMAIL,
                    signature_role: createdRequest.signature_role,
                    expires_at: createdRequest.expires_at,
                    token_fingerprint: createdRequest.token_fingerprint || null,
                    recipient_email_masked: maskEmail(recipientEmail),
                    provider: emailProviderName()
                })
            );

            const emailResult = await EmailService.sendTransactionalEmail({
                type: 'document-signature',
                to: recipientEmail,
                variables: {
                    patientName: displayName(emailContext),
                    clinicName: emailContext.business_legal_name || emailContext.business_name || 'Tu consultorio',
                    clinicLogoUrl: emailContext.business_logo_url,
                    documentTitle: documentTitle(emailContext),
                    doctorName: emailContext.doctor_name_snapshot,
                    expiresAt: formatEmailDateTime(createdRequest.expires_at),
                    publicUrl: createdRequest.public_url
                }
            });

            if (!emailResult || !emailResult.success) {
                await this.markRequestFailed(body.id_business, createdRequest.id_document_signature_request);
                await this.addEvent(
                    emailContext,
                    body.id_login,
                    DOCUMENT_SIGNATURE_EVENTS.LINK_SEND_EMAIL_FAILED,
                    safeEventNotes('Fallo envio de correo de firma remota.', {
                        signature_request_id: createdRequest.id_document_signature_request,
                        channel: SIGNATURE_REQUEST_CHANNELS.EMAIL,
                        signature_role: createdRequest.signature_role,
                        expires_at: createdRequest.expires_at,
                        token_fingerprint: createdRequest.token_fingerprint || null,
                        recipient_email_masked: maskEmail(recipientEmail),
                        provider: emailResult && emailResult.provider ? emailResult.provider : emailProviderName(),
                        error_code: emailResult && emailResult.code ? emailResult.code : 'EMAIL_SEND_FAILED'
                    })
                );

                return controlledFailure(
                    BAD_GATEWAY_STATUS,
                    'SIGNATURE_EMAIL_SEND_FAILED',
                    'No se pudo enviar el correo de firma. Verifica el email o intenta mas tarde.'
                );
            }

            await this.addEvent(
                emailContext,
                body.id_login,
                DOCUMENT_SIGNATURE_EVENTS.LINK_SEND_EMAIL_SUCCESS,
                safeEventNotes('Correo de firma remota enviado.', {
                    signature_request_id: createdRequest.id_document_signature_request,
                    channel: SIGNATURE_REQUEST_CHANNELS.EMAIL,
                    signature_role: createdRequest.signature_role,
                    expires_at: createdRequest.expires_at,
                    token_fingerprint: createdRequest.token_fingerprint || null,
                    recipient_email_masked: maskEmail(recipientEmail),
                    provider: emailResult.provider || emailProviderName(),
                    message_id: emailResult.messageId || null
                })
            );

            return success({
                id_document_signature_request: createdRequest.id_document_signature_request,
                id_patient_document: createdRequest.id_patient_document,
                signature_role: createdRequest.signature_role,
                channel: SIGNATURE_REQUEST_CHANNELS.EMAIL,
                status: SIGNATURE_REQUEST_STATUSES.PENDING,
                expires_at: createdRequest.expires_at,
                recipient_email: recipientEmail,
                email_sent: true,
                token_fingerprint: createdRequest.token_fingerprint || null
            }, 'Correo de firma enviado.');
        } catch (error) {
            if (createdRequest && createdRequest.id_document_signature_request) {
                await this.markRequestFailed(body.id_business, createdRequest.id_document_signature_request);
            }

            if (emailContext) {
                await this.addEvent(
                    emailContext,
                    body.id_login,
                    DOCUMENT_SIGNATURE_EVENTS.LINK_SEND_EMAIL_FAILED,
                    safeEventNotes('Fallo envio de correo de firma remota.', {
                        signature_request_id: createdRequest ? createdRequest.id_document_signature_request : null,
                        channel: SIGNATURE_REQUEST_CHANNELS.EMAIL,
                        signature_role: createdRequest ? createdRequest.signature_role : normalizeSignatureRole(body.signature_role),
                        token_fingerprint: createdRequest ? createdRequest.token_fingerprint || null : null,
                        recipient_email_masked: maskEmail(recipientEmail),
                        provider: emailProviderName(),
                        error_code: error && error.code ? error.code : 'EMAIL_SEND_FAILED'
                    })
                );
            }

            return controlledFailure(
                BAD_GATEWAY_STATUS,
                'SIGNATURE_EMAIL_SEND_FAILED',
                'No se pudo enviar el correo de firma. Verifica el email o intenta mas tarde.'
            );
        }
    }

    async expirePendingRequests(document, transaction) {
        const expiredRows = await sequelize.query(
            `SELECT id_document_signature_request, channel, signature_role, expires_at, token_fingerprint
               FROM document_signature_requests
              WHERE ${collateEq('id_business', ':_id_business')}
                AND ${collateEq('id_patient_document', ':_id_patient_document')}
                AND status IN (:_active_statuses)
                AND expires_at <= NOW()
              FOR UPDATE`,
            {
                replacements: {
                    _id_business: document.id_business,
                    _id_patient_document: document.id_patient_document,
                    _active_statuses: ACTIVE_SIGNATURE_REQUEST_STATUSES
                },
                type: QueryTypes.SELECT,
                transaction
            }
        );

        if (expiredRows.length === 0) {
            return;
        }

        await sequelize.query(
            `UPDATE document_signature_requests
                SET status = :_expired_status,
                    updated_at = NOW()
              WHERE ${collateEq('id_business', ':_id_business')}
                AND ${collateEq('id_patient_document', ':_id_patient_document')}
                AND status IN (:_active_statuses)
                AND expires_at <= NOW()`,
            {
                replacements: {
                    _id_business: document.id_business,
                    _id_patient_document: document.id_patient_document,
                    _active_statuses: ACTIVE_SIGNATURE_REQUEST_STATUSES,
                    _expired_status: SIGNATURE_REQUEST_STATUSES.EXPIRED
                },
                type: QueryTypes.UPDATE,
                transaction
            }
        );

        for (const expired of expiredRows) {
            await this.addEvent(
                document,
                null,
                DOCUMENT_SIGNATURE_EVENTS.LINK_EXPIRED,
                safeEventNotes('Solicitud de firma remota expirada.', {
                    signature_request_id: expired.id_document_signature_request,
                    channel: expired.channel,
                    signature_role: expired.signature_role,
                    expires_at: toIso(expired.expires_at),
                    token_fingerprint: expired.token_fingerprint || null
                }),
                transaction
            );
        }
    }

    async list(body) {
        const permissionError = await this.assertRequestPermission(body);
        if (permissionError) {
            return permissionError;
        }

        const idPatientDocument = normalizeNullableString(body.id_patient_document);
        if (!idPatientDocument) {
            return responseData.bad_request('id_patient_document es requerido.');
        }

        const transaction = await sequelize.transaction();
        try {
            const document = await this.getDocumentForRequest(body.id_business, idPatientDocument, transaction, true);
            if (!document) {
                await transaction.rollback();
                return responseData.bad_request('Documento no encontrado.');
            }

            await this.expirePendingRequests(document, transaction);

            const rows = await sequelize.query(
                `SELECT id_document_signature_request, id_patient_document, signature_role, channel,
                        status, expires_at, opened_at, signed_at, revoked_at, recipient_email,
                        recipient_phone, created_at, token_fingerprint
                   FROM document_signature_requests
                  WHERE ${collateEq('id_business', ':_id_business')}
                    AND ${collateEq('id_patient_document', ':_id_patient_document')}
                  ORDER BY created_at DESC`,
                {
                    replacements: {
                        _id_business: body.id_business,
                        _id_patient_document: idPatientDocument
                    },
                    type: QueryTypes.SELECT,
                    transaction
                }
            );

            await transaction.commit();

            return success(rows.map((row) => this.mapRequestRow(row)), 'Solicitudes obtenidas.');
        } catch (error) {
            await transaction.rollback();
            return SequelizeException(error, Messages.DATA_GET_ERROR);
        }
    }

    async revoke(body) {
        const permissionError = await this.assertRequestPermission(body);
        if (permissionError) {
            return permissionError;
        }

        const idSignatureRequest = normalizeNullableString(body.id_document_signature_request);
        if (!idSignatureRequest) {
            return responseData.bad_request('id_document_signature_request es requerido.');
        }

        const reason = redactSensitiveText(body.reason || 'Revocado desde Documentos y firmas.');
        const transaction = await sequelize.transaction();
        try {
            const rows = await sequelize.query(
                `SELECT dsr.id_document_signature_request, dsr.id_business, dsr.id_person,
                        dsr.id_patient_document, dsr.signature_role, dsr.channel, dsr.status,
                        dsr.expires_at, dsr.token_fingerprint, pd.document_type
                   FROM document_signature_requests dsr
                  INNER JOIN patient_documents pd
                          ON ${collateEq('pd.id_patient_document', 'dsr.id_patient_document')}
                         AND ${collateEq('pd.id_business', 'dsr.id_business')}
                  WHERE ${collateEq('dsr.id_document_signature_request', ':_id_document_signature_request')}
                    AND ${collateEq('dsr.id_business', ':_id_business')}
                  LIMIT 1
                  FOR UPDATE`,
                {
                    replacements: {
                        _id_document_signature_request: idSignatureRequest,
                        _id_business: body.id_business
                    },
                    type: QueryTypes.SELECT,
                    transaction
                }
            );

            const request = rows[0];
            if (!request) {
                await transaction.rollback();
                return responseData.bad_request('Solicitud de firma no encontrada.');
            }

            if (!ACTIVE_SIGNATURE_REQUEST_STATUSES.includes(request.status)) {
                await transaction.rollback();
                return responseData.bad_request('Esta solicitud de firma no se puede revocar.');
            }

            await sequelize.query(
                `UPDATE document_signature_requests
                    SET status = :_revoked_status,
                        revoked_at = NOW(),
                        revoked_by = :_id_login,
                        updated_at = NOW()
                  WHERE ${collateEq('id_document_signature_request', ':_id_document_signature_request')}
                    AND ${collateEq('id_business', ':_id_business')}`,
                {
                    replacements: {
                        _id_document_signature_request: idSignatureRequest,
                        _id_business: body.id_business,
                        _revoked_status: SIGNATURE_REQUEST_STATUSES.REVOKED,
                        _id_login: body.id_login
                    },
                    type: QueryTypes.UPDATE,
                    transaction
                }
            );

            await this.addEvent(
                request,
                body.id_login,
                DOCUMENT_SIGNATURE_EVENTS.LINK_REVOKED,
                safeEventNotes('Solicitud de firma remota revocada.', {
                    signature_request_id: request.id_document_signature_request,
                    channel: request.channel,
                    signature_role: request.signature_role,
                    expires_at: toIso(request.expires_at),
                    token_fingerprint: request.token_fingerprint || null,
                    reason
                }),
                transaction
            );

            await transaction.commit();

            return success({
                id_document_signature_request: idSignatureRequest,
                status: SIGNATURE_REQUEST_STATUSES.REVOKED,
                revoked_at: toIso(new Date())
            }, 'Solicitud revocada.');
        } catch (error) {
            await transaction.rollback();
            return SequelizeException(error, Messages.DATA_SAVE_ERROR);
        }
    }
}

module.exports = new DocumentSignatureRequestDao();

const { QueryTypes } = require('sequelize');
const { v4: uuidv4 } = require('uuid');
const sequelize = require('../../db/Sequelize.connection');
const planConsentDocuments = require('../../services/documentSignature/treatmentPlanConsentDocument.service');
const documentRequirements = require('../../services/documentSignature/documentRequirements.service');
const { validateSignatureImage } = require('../../services/documentSignature/signatureImage.service');
const { sanitizeDocumentHtml } = require('../../services/documentSignature/documentHtml.service');
const { hashToken } = require('../../services/documentSignature/documentSignatureToken.service');
const {
    SIGNATURE_REQUEST_STATUSES,
    REMOTE_SIGNATURE_ROLES,
    DOCUMENT_STATUSES_ALLOWED_FOR_REMOTE_REQUEST,
    ACTIVE_SIGNATURE_REQUEST_STATUSES,
    DOCUMENT_SIGNATURE_EVENTS
} = require('../../services/documentSignature/documentSignatureRequest.constants');

const TENANT_COLLATION = 'utf8mb4_unicode_ci';
const collateEq = (left, param) => `${left} COLLATE ${TENANT_COLLATION} = ${param} COLLATE ${TENANT_COLLATION}`;
const GENERIC_LINK_MESSAGE = 'Este enlace ya no esta disponible. Solicita uno nuevo al consultorio.';
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;
function ok(data, message) {
    return {
        status: 200,
        success: true,
        data,
        message
    };
}

function badRequest(message) {
    return {
        status: 400,
        success: false,
        data: null,
        message
    };
}

function conflict(message) {
    return {
        status: 409,
        success: false,
        data: null,
        message
    };
}

function unavailable() {
    return {
        status: 400,
        success: false,
        code: 'SIGNATURE_LINK_NOT_AVAILABLE',
        data: null,
        message: GENERIC_LINK_MESSAGE
    };
}

function publicInternalError() {
    return {
        status: 500,
        success: false,
        data: null,
        message: 'No fue posible completar la solicitud.'
    };
}

function normalizeToken(token) {
    return String(token || '').trim();
}

function validateTokenFormat(token) {
    return TOKEN_PATTERN.test(token);
}

function normalizeOptionalText(value, max = 255) {
    const text = String(value || '').trim();
    return text ? text.slice(0, max) : null;
}

function toIso(value) {
    if (!value) {
        return null;
    }

    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function requestIp(meta = {}) {
    return normalizeOptionalText(meta.ip, 100);
}

function requestUserAgent(meta = {}) {
    return normalizeOptionalText(meta.userAgent, 1000);
}

function shortUserAgent(meta = {}) {
    return normalizeOptionalText(meta.userAgent, 250);
}

function safeEventNotes(message, metadata) {
    const serialized = JSON.stringify({ message, metadata });
    return serialized.length > 1000 ? `${serialized.slice(0, 997)}...` : serialized;
}

function displayName(person) {
    if (!person) {
        return '';
    }

    return `${person.name || ''} ${person.surname || ''}`.trim();
}

class PublicDocumentSignatureDao {
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

    async addEvent(document, eventType, notes, createdBy = null, transaction = null) {
        await sequelize.query(
            `INSERT INTO patient_document_events (
                id_patient_document_event, id_patient_document, id_business, event_type,
                notes, created_at, created_by
            ) VALUES (
                :_id_patient_document_event, :_id_patient_document, :_id_business, :_event_type,
                :_notes, NOW(), :_created_by
            )`,
            {
                replacements: {
                    _id_patient_document_event: uuidv4(),
                    _id_patient_document: document.id_patient_document,
                    _id_business: document.id_business,
                    _event_type: eventType,
                    _notes: notes,
                    _created_by: createdBy
                },
                type: QueryTypes.INSERT,
                transaction
            }
        );
    }

    async getRequestByHash(tokenHash, transaction = null, forUpdate = false) {
        const rows = await sequelize.query(
            `SELECT id_document_signature_request, id_business, id_person, id_patient_document,
                    document_type, signature_role, channel, status, token_fingerprint,
                    expires_at, opened_at, signed_at, used_at, revoked_at
               FROM document_signature_requests
              WHERE token_hash = :_token_hash
              LIMIT 1 ${forUpdate ? 'FOR UPDATE' : ''}`,
            {
                replacements: { _token_hash: tokenHash },
                type: QueryTypes.SELECT,
                transaction
            }
        );

        return rows[0] || null;
    }

    async lockPlanPatient(request, transaction) {
        if (!request || request.document_type !== 'TREATMENT_PLAN_CONSENT') return;
        await sequelize.query(`SELECT id_person FROM person WHERE ${collateEq('id_person', ':_id_person')} AND ${collateEq('id_business', ':_id_business')} FOR UPDATE`,
            { replacements: { _id_person: request.id_person, _id_business: request.id_business }, type: QueryTypes.SELECT, transaction });
    }

    async getDocument(request, transaction = null, forUpdate = false) {
        const rows = await sequelize.query(
            `SELECT pd.id_patient_document, pd.id_business, pd.id_person, pd.document_type, pd.origin, pd.treatment_plan_id,
                    pd.status, pd.title, pd.content_html_snapshot, pd.created_at,
                    pd.guardian_name_snapshot, pd.doctor_signature_snapshot,
                    pd.doctor_name_snapshot, pd.professional_license_snapshot,
                    pd.responsible_doctor_profile_id, pd.responsible_doctor_user_id,
                    dt.requires_patient_signature, dt.requires_tutor_signature, dt.requires_doctor_signature,
                    dt.requires_witness1_signature, dt.requires_witness2_signature
               FROM patient_documents pd
               LEFT JOIN document_templates dt
                      ON ${collateEq('dt.id_document_template', 'pd.id_document_template')}
              WHERE ${collateEq('pd.id_business', ':_id_business')}
                AND ${collateEq('pd.id_patient_document', ':_id_patient_document')}
                AND pd.active = 1
              LIMIT 1 ${forUpdate ? 'FOR UPDATE' : ''}`,
            {
                replacements: {
                    _id_business: request.id_business,
                    _id_patient_document: request.id_patient_document
                },
                type: QueryTypes.SELECT,
                transaction
            }
        );

        const document = await documentRequirements.decorate(rows[0], request.id_business, transaction);
        return document ? planConsentDocuments.decorate(document, transaction) : null;
    }

    async getPatient(request, transaction = null) {
        const rows = await sequelize.query(
            `SELECT id_person, name, surname
               FROM person
              WHERE ${collateEq('id_business', ':_id_business')}
                AND ${collateEq('id_person', ':_id_person')}
                AND active = 1
              LIMIT 1`,
            {
                replacements: {
                    _id_business: request.id_business,
                    _id_person: request.id_person
                },
                type: QueryTypes.SELECT,
                transaction
            }
        );

        return rows[0] || null;
    }

    async getBusiness(idBusiness, transaction = null) {
        const rows = await sequelize.query(
            `SELECT name, legal_name, phone, address, logo_url
               FROM business
              WHERE ${collateEq('id_business', ':_id_business')}
                AND active = 1
              LIMIT 1`,
            {
                replacements: { _id_business: idBusiness },
                type: QueryTypes.SELECT,
                transaction
            }
        );

        return rows[0] || {};
    }

    async getDocumentSignatures(request, transaction = null, forUpdate = false) {
        return sequelize.query(
            `SELECT signature_role, signature_image, signed_at
               FROM patient_document_signatures
              WHERE ${collateEq('id_business', ':_id_business')}
                AND ${collateEq('id_patient_document', ':_id_patient_document')}
              ${forUpdate ? 'FOR UPDATE' : ''}`,
            {
                replacements: {
                    _id_business: request.id_business,
                    _id_patient_document: request.id_patient_document
                },
                type: QueryTypes.SELECT,
                transaction
            }
        );
    }

    async expireRequest(request, meta, transaction = null) {
        await sequelize.query(
            `UPDATE document_signature_requests
                SET status = :_expired_status,
                    updated_at = NOW()
              WHERE ${collateEq('id_document_signature_request', ':_id_document_signature_request')}`,
            {
                replacements: {
                    _id_document_signature_request: request.id_document_signature_request,
                    _expired_status: SIGNATURE_REQUEST_STATUSES.EXPIRED
                },
                type: QueryTypes.UPDATE,
                transaction
            }
        );

        await this.addEvent(
            request,
            DOCUMENT_SIGNATURE_EVENTS.LINK_EXPIRED,
            safeEventNotes('Solicitud de firma remota expirada.', {
                signature_request_id: request.id_document_signature_request,
                channel: request.channel,
                signature_role: request.signature_role,
                expires_at: toIso(request.expires_at),
                token_fingerprint: request.token_fingerprint || null,
                user_agent: shortUserAgent(meta)
            }),
            null,
            transaction
        );
    }

    requestIsAvailable(request) {
        return request && ACTIVE_SIGNATURE_REQUEST_STATUSES.includes(request.status);
    }

    requestIsExpired(request) {
        return request && request.expires_at && new Date(request.expires_at).getTime() <= Date.now();
    }

    validateDocumentAndSignature(request, document, signatures) {
        if (!document || !DOCUMENT_STATUSES_ALLOWED_FOR_REMOTE_REQUEST.includes(document.status)) {
            return false;
        }

        if (![REMOTE_SIGNATURE_ROLES.PATIENT, REMOTE_SIGNATURE_ROLES.TUTOR].includes(request.signature_role)) {
            return false;
        }

        const requiredRoles = this.requiredSignatureRoles(document);
        if (!requiredRoles.includes(request.signature_role)) {
            return false;
        }

        const completedRoles = this.completedSignatureRoles(document, signatures);
        return !completedRoles.includes(request.signature_role);
    }

    async openByToken(token, meta = {}) {
        const normalizedToken = normalizeToken(token);
        if (!validateTokenFormat(normalizedToken)) {
            return unavailable();
        }

        const transaction = await sequelize.transaction();
        try {
            const tokenHash = hashToken(normalizedToken);
            const initialRequest = await this.getRequestByHash(tokenHash, transaction);
            await this.lockPlanPatient(initialRequest, transaction);
            // Match internal capture/request creation: patient (plans), then
            // document, then request. Opposite locking can deadlock local/QR signing.
            const document = this.requestIsAvailable(initialRequest) && !this.requestIsExpired(initialRequest)
                ? await this.getDocument(initialRequest, transaction, true) : null;
            const request = await this.getRequestByHash(tokenHash, transaction, true);

            if (!this.requestIsAvailable(request)) {
                await transaction.rollback();
                return unavailable();
            }

            if (this.requestIsExpired(request)) {
                await this.expireRequest(request, meta, transaction);
                await transaction.commit();
                return unavailable();
            }

            const patient = await this.getPatient(request, transaction);
            const signatures = await this.getDocumentSignatures(request, transaction);

            if (!patient || !this.validateDocumentAndSignature(request, document, signatures) || !await planConsentDocuments.assertCurrent(document, transaction)) {
                await transaction.rollback();
                return unavailable();
            }

            const wasPending = request.status === SIGNATURE_REQUEST_STATUSES.PENDING;
            if (wasPending) {
                await sequelize.query(
                    `UPDATE document_signature_requests
                        SET status = :_opened_status,
                            opened_at = NOW(),
                            opened_ip = :_opened_ip,
                            opened_user_agent = :_opened_user_agent,
                            updated_at = NOW()
                      WHERE ${collateEq('id_document_signature_request', ':_id_document_signature_request')}`,
                    {
                        replacements: {
                            _id_document_signature_request: request.id_document_signature_request,
                            _opened_status: SIGNATURE_REQUEST_STATUSES.OPENED,
                            _opened_ip: requestIp(meta),
                            _opened_user_agent: requestUserAgent(meta)
                        },
                        type: QueryTypes.UPDATE,
                        transaction
                    }
                );

                await this.addEvent(
                    request,
                    DOCUMENT_SIGNATURE_EVENTS.LINK_OPENED,
                    safeEventNotes('Solicitud de firma remota abierta.', {
                        signature_request_id: request.id_document_signature_request,
                        channel: request.channel,
                        signature_role: request.signature_role,
                        expires_at: toIso(request.expires_at),
                        token_fingerprint: request.token_fingerprint || null,
                        opened_ip: requestIp(meta),
                        user_agent: shortUserAgent(meta)
                    }),
                    null,
                    transaction
                );
            }

            const business = await this.getBusiness(request.id_business, transaction);
            await transaction.commit();

            return ok({
                request: {
                    signature_role: request.signature_role,
                    channel: request.channel,
                    expires_at: toIso(request.expires_at)
                },
                document: {
                    title: document.title,
                    document_type: document.document_type,
                    content_html_snapshot: sanitizeDocumentHtml(document.content_html_snapshot),
                    created_at: toIso(document.created_at)
                },
                patient: {
                    display_name: document.patient_name_snapshot || displayName(patient)
                },
                clinic: {
                    name: business.name || null,
                    legal_name: business.legal_name || null,
                    logo_url: business.logo_url || null,
                    phone: business.phone || null,
                    address: business.address || null
                },
                doctor: {
                    name: document.doctor_name_snapshot || null,
                    professional_license: document.professional_license_snapshot || null
                }
            }, 'Documento disponible para firma.');
        } catch (error) {
            await transaction.rollback();
            return publicInternalError();
        }
    }

    async signByToken(token, body = {}, meta = {}) {
        if (body.accepted_electronic_signature !== true) {
            return badRequest('Debes aceptar la firma electronica para continuar.');
        }

        const signatureValidation = validateSignatureImage(body.signature_image);
        if (signatureValidation.error) {
            return signatureValidation.error;
        }

        const normalizedToken = normalizeToken(token);
        if (!validateTokenFormat(normalizedToken)) {
            return unavailable();
        }

        const transaction = await sequelize.transaction();
        try {
            const tokenHash = hashToken(normalizedToken);
            const initialRequest = await this.getRequestByHash(tokenHash, transaction);
            await this.lockPlanPatient(initialRequest, transaction);
            const document = this.requestIsAvailable(initialRequest) && !this.requestIsExpired(initialRequest)
                ? await this.getDocument(initialRequest, transaction, true) : null;
            const request = await this.getRequestByHash(tokenHash, transaction, true);

            if (!this.requestIsAvailable(request)) {
                await transaction.rollback();
                return unavailable();
            }

            if (this.requestIsExpired(request)) {
                await this.expireRequest(request, meta, transaction);
                await transaction.commit();
                return unavailable();
            }

            const patient = await this.getPatient(request, transaction);
            const signatures = await this.getDocumentSignatures(request, transaction, true);

            if (!patient || !this.validateDocumentAndSignature(request, document, signatures) || !await planConsentDocuments.assertCurrent(document, transaction)) {
                await transaction.rollback();
                return unavailable();
            }

            if (signatures.some((signature) => signature.signature_role === request.signature_role)) {
                await transaction.rollback();
                return conflict('Esta firma ya fue capturada.');
            }

            const signerName = normalizeOptionalText(body.signed_by_name, 255) || document.patient_name_snapshot || displayName(patient);
            const idSignature = uuidv4();

            await sequelize.query(
                `INSERT INTO patient_document_signatures (
                    id_patient_document_signature, id_patient_document, id_business, signature_role,
                    signer_name_snapshot, signature_image, signed_at, signed_by_user_id, created_at, created_by
                ) VALUES (
                    :_id_patient_document_signature, :_id_patient_document, :_id_business, :_signature_role,
                    :_signer_name_snapshot, :_signature_image, NOW(), NULL, NOW(), NULL
                )`,
                {
                    replacements: {
                        _id_patient_document_signature: idSignature,
                        _id_patient_document: document.id_patient_document,
                        _id_business: document.id_business,
                        _signature_role: request.signature_role,
                        _signer_name_snapshot: signerName,
                        _signature_image: signatureValidation.image
                    },
                    type: QueryTypes.INSERT,
                    transaction
                }
            );

            const completedRoles = this.completedSignatureRoles(document, [
                ...signatures,
                {
                    signature_role: request.signature_role,
                    signature_image: signatureValidation.image,
                    signed_at: new Date()
                }
            ]);
            const requiredRoles = this.requiredSignatureRoles(document);
            const hasAllRequiredSignatures = requiredRoles.every((role) => completedRoles.includes(role));
            const nextDocumentStatus = hasAllRequiredSignatures ? 'FIRMADO' : 'PENDIENTE_FIRMA';

            await sequelize.query(
                `UPDATE patient_documents
                    SET status = :_status,
                        signed_content_html_snapshot = CASE WHEN :_status = 'FIRMADO' THEN content_html_snapshot ELSE signed_content_html_snapshot END,
                        signed_at = CASE WHEN :_status = 'FIRMADO' THEN NOW() ELSE signed_at END,
                        signed_by_user_id = CASE WHEN :_status = 'FIRMADO' THEN NULL ELSE signed_by_user_id END,
                        updated_at = NOW(),
                        updated_by = NULL
                  WHERE ${collateEq('id_business', ':_id_business')}
                    AND ${collateEq('id_patient_document', ':_id_patient_document')}`,
                {
                    replacements: {
                        _id_business: document.id_business,
                        _id_patient_document: document.id_patient_document,
                        _status: nextDocumentStatus
                    },
                    type: QueryTypes.UPDATE,
                    transaction
                }
            );

            await sequelize.query(
                `UPDATE document_signature_requests
                    SET status = :_signed_status,
                        signed_at = NOW(),
                        used_at = NOW(),
                        signed_ip = :_signed_ip,
                        signed_user_agent = :_signed_user_agent,
                        signed_by_name = :_signed_by_name,
                        updated_at = NOW()
                  WHERE ${collateEq('id_document_signature_request', ':_id_document_signature_request')}`,
                {
                    replacements: {
                        _id_document_signature_request: request.id_document_signature_request,
                        _signed_status: SIGNATURE_REQUEST_STATUSES.SIGNED,
                        _signed_ip: requestIp(meta),
                        _signed_user_agent: requestUserAgent(meta),
                        _signed_by_name: signerName
                    },
                    type: QueryTypes.UPDATE,
                    transaction
                }
            );

            const signedAt = new Date();
            await this.addEvent(
                request,
                DOCUMENT_SIGNATURE_EVENTS.LINK_SIGNED,
                safeEventNotes('Solicitud de firma remota completada.', {
                    signature_request_id: request.id_document_signature_request,
                    channel: request.channel,
                    signature_role: request.signature_role,
                    token_fingerprint: request.token_fingerprint || null,
                    signed_ip: requestIp(meta),
                    user_agent: shortUserAgent(meta),
                    signed_by_name: signerName,
                    document_status: nextDocumentStatus
                }),
                null,
                transaction
            );

            await this.addEvent(
                request,
                hasAllRequiredSignatures ? DOCUMENT_SIGNATURE_EVENTS.SIGNED : DOCUMENT_SIGNATURE_EVENTS.SIGNATURE_CAPTURED,
                hasAllRequiredSignatures ? 'Documento firmado.' : 'Firma capturada. Quedan firmas pendientes.',
                null,
                transaction
            );

            await planConsentDocuments.syncSigned({ ...document, status: nextDocumentStatus, signed_at: signedAt }, transaction, null);

            await transaction.commit();

            return ok({
                status: SIGNATURE_REQUEST_STATUSES.SIGNED,
                document_status: nextDocumentStatus,
                signed_at: toIso(signedAt)
            }, 'Firma registrada correctamente.');
        } catch (error) {
            await transaction.rollback();
            return publicInternalError();
        }
    }
}

module.exports = new PublicDocumentSignatureDao();

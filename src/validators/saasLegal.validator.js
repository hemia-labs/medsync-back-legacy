const { sanitizeDocumentHtml } = require('../services/documentSignature/documentHtml.service');
const { meaningfulDocumentContent } = require('./documentTemplate.validator');

const DOCUMENT_SCOPES = Object.freeze({ terms_conditions: 'user', privacy_notice: 'user', license_agreement: 'business' });
const isDocumentKey = key => Object.prototype.hasOwnProperty.call(DOCUMENT_SCOPES, key);
const validRevision = value => Number.isSafeInteger(value) && value >= 1;

function validateDraft(key, source = {}) {
    const fieldErrors = {}, data = {};
    if(!source || typeof source !== 'object' || Array.isArray(source)) source = {};
    data.title = typeof source.title === 'string' ? source.title.trim() : '';
    data.description = source.description == null ? '' : typeof source.description === 'string' ? source.description.trim() : null;
    data.content_html = typeof source.content_html === 'string' && source.content_html.length <= 200000 ? sanitizeDocumentHtml(source.content_html) : null;
    data.required = source.required;
    data.acceptance_scope = DOCUMENT_SCOPES[key];
    data.expected_revision = source.expected_revision;
    if(!isDocumentKey(key)) fieldErrors.document_key = 'Selecciona un documento legal disponible.';
    if(!data.title || data.title.length > 255) fieldErrors.title = 'Escribe un título de 1 a 255 caracteres.';
    if(data.description === null || data.description.length > 1000) fieldErrors.description = 'La descripción admite hasta 1000 caracteres.';
    if(data.content_html === null) fieldErrors.content_html = 'El contenido debe ser texto HTML de hasta 200000 caracteres.';
    if(typeof data.required !== 'boolean') fieldErrors.required = 'Indica si la aceptación es requerida.';
    if(source.acceptance_scope !== undefined && source.acceptance_scope !== data.acceptance_scope) fieldErrors.acceptance_scope = 'El alcance de aceptación está definido para este documento y no se puede cambiar.';
    if(!validRevision(data.expected_revision)) fieldErrors.expected_revision = 'Vuelve a consultar el borrador antes de guardar.';
    return { isValid: Object.keys(fieldErrors).length === 0, data, fieldErrors };
}

function validatePublish(source = {}) {
    return validRevision(source && source.expected_revision) ? { isValid: true, expected_revision: source.expected_revision } : { isValid: false, fieldErrors: { expected_revision: 'Vuelve a consultar el borrador antes de publicar.' } };
}

function validateAcceptance(source = {}) {
    const fieldErrors = {};
    if(!source || typeof source.id_version !== 'string' || !/^[A-Za-z0-9_-]{1,50}$/.test(source.id_version)) fieldErrors.id_version = 'Selecciona la versión publicada que revisaste.';
    if(!source || source.acknowledged !== true) fieldErrors.acknowledged = 'Confirma expresamente que revisaste y aceptas esta versión.';
    return { isValid: Object.keys(fieldErrors).length === 0, fieldErrors };
}

module.exports = { DOCUMENT_SCOPES, isDocumentKey, validateDraft, validatePublish, validateAcceptance, meaningfulDocumentContent };

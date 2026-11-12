'use strict';

const express = require('express');
const MB = 1024 * 1024;
const GENERAL_LIMIT = MB;
const AUTH_LIMIT = 32 * 1024;
const REGISTRATION_PATH = /^\/api\/(?:auth\/register|account\/(?:contact-verifications(?:\/confirm)?|activation\/contact))\/?$/i;

// Large bodies are deferred to route middleware, AFTER authentication, CSRF
// and tenant checks. Public signing has its own rate/token gate before parsing.
const LARGE_BODY_POLICIES = Object.freeze([
    { method: 'PUT', path: /^\/api\/business\/current\/logo\/?$/i, bytes: 8 * MB },
    { method: 'POST', path: /^\/api\/file\/px\/upload-file\/?$/i, bytes: 16 * MB },
    { method: 'POST', path: /^\/api\/file\/px\/upload-profile\/?$/i, bytes: 4 * MB },
    { method: 'POST', path: /^\/api\/config\/login-image\/save\/?$/i, bytes: 4 * MB },
    { method: 'POST', path: /^\/api\/config\/signatureconten\/save\/?$/i, bytes: 8 * MB },
    { method: 'PUT', path: /^\/api\/config\/signatureconten\/update\/?$/i, bytes: 8 * MB },
    { method: 'POST', path: /^\/api\/user\/professional-profile\/[^/]+\/?$/i, bytes: 4 * MB },
    { method: 'POST', path: /^\/api\/prescription\/config\/save\/?$/i, bytes: 10 * MB },
    { method: 'POST', path: /^\/api\/document\/template\/save\/?$/i, bytes: 8 * MB },
    { method: 'POST', path: /^\/api\/document\/sign\/?$/i, bytes: 4 * MB },
    { method: 'POST', path: /^\/api\/treatment\/plan\/consent\/(?:save|document\/sign)\/?$/i, bytes: 4 * MB },
    { method: 'POST', path: /^\/api\/px\/save\/?$/i, bytes: 4 * MB },
    { method: 'PUT', path: /^\/api\/px\/update\/?$/i, bytes: 4 * MB },
    { method: 'POST', path: /^\/api\/public\/document-signature\/[^/]+\/sign\/?$/i, bytes: 4 * MB, publicSignature: true }
]);

function policyFor(req) {
    const path = String(req.originalUrl || req.url || '').split('?')[0];
    return LARGE_BODY_POLICIES.find(policy => policy.method === req.method && policy.path.test(path));
}

function parseError(error, res, next, bytes) {
    if (!error) return next();
    let status;
    let code;
    let message;
    if (error.type === 'entity.too.large' || error.type === 'parameters.too.many') {
        status = 413;
        code = 'PAYLOAD_TOO_LARGE';
        message = 'La solicitud supera el tamaño permitido. Reduce el tamaño del archivo o del contenido e intenta de nuevo.';
    } else if (error.type === 'encoding.unsupported' || error.type === 'charset.unsupported') {
        status = 415;
        code = 'PAYLOAD_ENCODING_UNSUPPORTED';
        message = 'El formato o la compresión de la solicitud no está permitido.';
    } else if (error.type === 'entity.parse.failed' || error.type === 'request.size.invalid') {
        status = 400;
        code = 'PAYLOAD_INVALID';
        message = 'No fue posible leer la solicitud. Revisa los datos e intenta de nuevo.';
    } else return next(error);
    if (REGISTRATION_PATH.test(String(res.req?.originalUrl || '').split('?')[0])) return res.status(status).json({code,message});
    return res.status(status).json({ status, success: false, code, data: null, message, limitBytes: bytes });
}

const parsers = new Map();
function parse(req, res, next, bytes) {
    if (!parsers.has(bytes)) {
        parsers.set(bytes, [
            express.json({ limit: bytes, inflate: false }),
            express.urlencoded({ extended: false, limit: bytes, parameterLimit: 1000, inflate: false })
        ]);
    }
    const [json, form] = parsers.get(bytes);
    json(req, res, error => {
        if (error) return parseError(error, res, next, bytes);
        form(req, res, formError => parseError(formError, res, next, bytes));
    });
}

function defaultBodyParser(req, res, next) {
    if (policyFor(req)) return next();
    const path = String(req.originalUrl || req.url || '').split('?')[0];
    if (REGISTRATION_PATH.test(path) || /^\/api\/saas-legal\/(?:central\/accept|integration\/context)\/?$/i.test(path)) {
        return parse(req, res, next, 8 * 1024);
    }
    return parse(req, res, next, /^\/api\/auth(?:\/|$)/i.test(path) ? AUTH_LIMIT : GENERAL_LIMIT);
}

function protectedBodyParser(req, res, next) {
    const policy = policyFor(req);
    if (!policy || policy.publicSignature || !req.tokenDecode || !req.tokenDecode.id_login) {
        return res.status(401).json({ status: 401, data: null, message: 'Se requiere una sesión activa para cargar este contenido.' });
    }
    return parse(req, res, next, policy.bytes);
}

function publicSignatureBodyParser(req, res, next) {
    const policy = policyFor(req);
    if (!policy || !policy.publicSignature || !req.signatureBodyAuthorized) {
        return res.status(400).json({ status: 400, data: null, code: 'SIGNATURE_LINK_NOT_AVAILABLE', message: 'Este enlace ya no esta disponible. Solicita uno nuevo al consultorio.' });
    }
    return parse(req, res, next, policy.bytes);
}

module.exports = { defaultBodyParser, protectedBodyParser, publicSignatureBodyParser, policyFor, LARGE_BODY_POLICIES, GENERAL_LIMIT, AUTH_LIMIT };

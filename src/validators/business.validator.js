const responseData = require('../util/responsedata');

const requiredFields = new Set(['name', 'phone', 'address']);
const labels = { name: 'El nombre comercial', legalName: 'La razón social', email: 'El correo de contacto', phone: 'El teléfono del consultorio', address: 'El domicilio', logoUrl: 'El enlace del logo' };
const fields = Object.keys(labels);
const maxLengths = { name: 500, legalName: 500, email: 254, address: 1000, logoUrl: 1000 };
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const normalizePhone = value => {
    const compact = value.replace(/[()\s.\-]/g, '');
    return /^\+52\d{10}$/.test(compact) ? compact.slice(3) : compact;
};

function validateBusinessProfile(body, { partial = false } = {}) {
    if(!body || typeof body !== 'object' || Array.isArray(body)) return { isValid: false, message: 'Los datos del consultorio deben ser un objeto válido.', fieldErrors: {}, data: {} };
    const data = {}, fieldErrors = {};
    for(const field of fields) {
        const alias = field === 'legalName' ? 'legal_name' : field === 'logoUrl' ? 'logo_url' : null;
        const present = own(body, field) || alias && own(body, alias);
        if(!present && partial) continue;
        const raw = own(body, field) ? body[field] : alias && own(body, alias) ? body[alias] : '';
        if(raw != null && typeof raw !== 'string') {
            fieldErrors[field] = `${labels[field]} debe capturarse como texto.`;
            continue;
        }
        data[field] = String(raw == null ? '' : raw).trim();
        if(requiredFields.has(field) && !data[field]) { fieldErrors[field] = `${labels[field]} es obligatorio.`; continue; }
        if(maxLengths[field] && data[field].length > maxLengths[field]) { fieldErrors[field] = `${labels[field]} no debe superar ${maxLengths[field]} caracteres.`; continue; }
        if(!data[field]) continue;
        if(field === 'phone') {
            data[field] = normalizePhone(data[field]);
            if(!/^\d{10}$/.test(data[field])) fieldErrors[field] = 'Ingresa un teléfono nacional de 10 dígitos. Puedes usar +52, espacios, guiones o paréntesis.';
        }
        if(field === 'email' && (data[field].length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(data[field]))) fieldErrors[field] = 'Ingresa un correo de contacto válido o deja el campo vacío.';
        if(field === 'logoUrl') {
            try {
                const url = new URL(data[field]);
                if(!/^https?:$/.test(url.protocol) || !url.hostname || url.username || url.password || /[\s<>"'\\\u0000-\u001f\u007f]/.test(data[field])) throw new Error();
                data[field] = url.href;
            } catch(_) { fieldErrors[field] = 'Usa un enlace completo http:// o https:// para el logo, sin usuario ni contraseña, o deja el campo vacío.'; }
        }
    }
    return { isValid: Object.keys(fieldErrors).length === 0, message: Object.values(fieldErrors)[0] || '', fieldErrors, data };
}

function validateBusinessUpdate(req) {
    return validateBusinessProfile(req.body, { partial: true });
}

function validateBusinessUpdatePayload(req, res, next) {
    const result = validateBusinessUpdate(req);
    if(!result.isValid) {
        const response = responseData.bad_request(result.message, { fieldErrors: result.fieldErrors });
        res.status(response.status).send(response);
        return;
    }
    req.body = { ...req.body, ...result.data };
    next();
}

module.exports = { normalizePhone, validateBusinessProfile, validateBusinessUpdate, validateBusinessUpdatePayload };

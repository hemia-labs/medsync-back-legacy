const { sanitizeDocumentHtml } = require('../services/documentSignature/documentHtml.service');

function meaningfulDocumentContent(html) {
    // The caller supplies sanitized HTML: a retained image is actual content,
    // including image-only scans; an empty <img> or formatting is not.
    if(/<img\b[^>]*\bsrc\s*=\s*["'][^"']+["']/i.test(html)) return true;
    const text = html.replace(/<[^>]*>/g, '')
        .replace(/&#(?:x([a-f0-9]+)|(\d+));?/gi, (_match, hex, decimal) => {
            const point = Number.parseInt(hex || decimal, hex ? 16 : 10);
            return point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : '';
        })
        .replace(/&(?:nbsp|NonBreakingSpace|ensp|emsp\d*|numsp|puncsp|thinsp|hairsp|MediumSpace|ThickSpace|Negative\w*Space|VeryThinSpace|NoBreak|ZeroWidthSpace|zwnj|zwj|lrm|rlm|shy|NewLine|Tab);/gi, '')
        .replace(/[\s\u0000-\u001f\u007f\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '');
    return Boolean(text);
}

function validateDocumentTemplate(body = {}) {
    if(!body || typeof body !== 'object' || Array.isArray(body)) body = {};
    const fieldErrors = {};
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if(!name) fieldErrors.name = 'Escribe un nombre para el formato; no puede contener sólo espacios.';
    const content = typeof body.content_html === 'string' ? sanitizeDocumentHtml(body.content_html) : '';
    if(!meaningfulDocumentContent(content)) fieldErrors.content_html = 'Agrega contenido al documento. Los espacios, las etiquetas vacías y el contenido no permitido no forman un formato válido.';
    return { isValid: Object.keys(fieldErrors).length === 0, message: Object.values(fieldErrors)[0] || '', fieldErrors, data: { name, content_html: content } };
}

module.exports = { meaningfulDocumentContent, validateDocumentTemplate };

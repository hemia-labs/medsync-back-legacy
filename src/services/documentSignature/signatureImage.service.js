const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const configured = Number(process.env.SIGNATURE_PUBLIC_MAX_SIGNATURE_IMAGE_BYTES);
const MAX_BYTES = Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : DEFAULT_MAX_BYTES;
function validateSignatureImage(signatureImage) {
    const image = String(signatureImage || '').trim();
    const prefix = 'data:image/png;base64,';
    const invalid = message => ({ error: { status: 400, success: false, data: null, message } });
    if (!image) return invalid('La firma es requerida.');
    if (!image.startsWith(prefix)) return invalid('La firma debe ser una imagen PNG en base64.');
    const base64 = image.slice(prefix.length);
    if (!base64 || !/^[A-Za-z0-9+/=\r\n]+$/.test(base64)) return invalid('La firma no tiene un formato valido.');
    const normalized = base64.replace(/\s/g, '');
    if (normalized.length % 4 !== 0) return invalid('La firma no tiene un formato base64 valido.');
    const bytes = Buffer.from(normalized, 'base64');
    if (bytes.length > MAX_BYTES) return invalid('La firma es demasiado grande.');
    if (bytes.length < 8 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return invalid('La firma debe ser una imagen PNG valida.');
    return { image: `${prefix}${normalized}` };
}
module.exports = { validateSignatureImage };

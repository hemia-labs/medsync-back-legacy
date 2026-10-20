'use strict';

const { v4: uuidv4 } = require('uuid');
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const configuredLimit = Number(process.env.MAX_IMAGE_UPLOAD_BYTES || DEFAULT_MAX_BYTES);
const maxImageBytes = Number.isSafeInteger(configuredLimit) && configuredLimit >= 0 ? configuredLimit : DEFAULT_MAX_BYTES;

function decodeImage(dataUrl) {
    if (typeof dataUrl !== 'string') return null;
    const header = /^data:image\/(jpeg|jpg|png|webp);base64,/i.exec(dataUrl);
    if (!header) return null;
    const encodedLength = dataUrl.length - header[0].length;
    // Reject oversized input before allocating the decoded Buffer or scanning
    // the full payload. Base64/JSON still arrive under the existing body limits.
    if (!encodedLength || encodedLength > 4 * Math.ceil(maxImageBytes / 3)) return null;
    const encoded = dataUrl.slice(header[0].length);
    if (encodedLength % 4 === 1 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null;
    const padding = encoded.endsWith('==') ? 2 : (encoded.endsWith('=') ? 1 : 0);
    if (padding && encodedLength % 4 !== 0) return null;
    const expectedBytes = Math.floor(encodedLength * 3 / 4) - padding;
    if (expectedBytes < 1 || expectedBytes > maxImageBytes) return null;
    const body = Buffer.from(encoded, 'base64');
    if (body.length !== expectedBytes) return null;
    const extension = header[1].toLowerCase() === 'jpeg' ? 'jpg' : header[1].toLowerCase();
    return { body, key: `${uuidv4()}.${extension}`, contentType: extension === 'jpg' ? 'image/jpeg' : `image/${extension}` };
}

module.exports = { decodeImage, maxImageBytes };

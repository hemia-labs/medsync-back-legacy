'use strict';
const { createHash } = require('node:crypto');
const config = require('../../config/config');
const s3 = require('../../config/aws/s3');
const { decodeImage, maxImageBytes } = require('../../util/file/image');
const { compensateUpload, queueUploadCleanup } = require('./compensateUpload');

const isPrivateKey = value => typeof value === 'string' && value.startsWith('consultorios/');
function tenantPrefix(business) {
    if (typeof business !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(business)) throw new Error('Consultorio inválido.');
    return `consultorios/${business}/`;
}
function assertKey(key, business) {
    if (!isPrivateKey(key) || !key.startsWith(tenantPrefix(business)) || !/^consultorios\/[a-zA-Z0-9_-]+\/(?:logos|profesionales\/[a-zA-Z0-9_-]+\/firmas)\/[a-f0-9-]+\.(?:png|jpg|webp)$/.test(key)) throw new Error('Imagen no disponible para este consultorio.');
    return key;
}
function bucket() {
    if (!config.S3_PRIVATE_BUCKET) throw new Error('Falta configurar el almacenamiento privado.');
    return config.S3_PRIVATE_BUCKET;
}
function digest(value) {
    if (!value) return null;
    if (isPrivateKey(value)) return /-([a-f0-9]{64})\.(?:png|jpg|webp)$/.exec(value)?.[1] || null;
    return createHash('sha256').update(value).digest('hex');
}
async function upload(imageData, business, professional = null) {
    const prefix = tenantPrefix(business);
    if (professional !== null && (typeof professional !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(professional))) throw new Error('Profesional inválido.');
    const image = decodeImage(imageData);
    const bytes = image && image.body;
    const valid = bytes && bytes.length <= 5 * 1024 * 1024 && ((image.contentType === 'image/png' && bytes.subarray(0,8).toString('hex') === '89504e470d0a1a0a') ||
        (image.contentType === 'image/jpeg' && bytes.subarray(0,3).toString('hex') === 'ffd8ff') ||
        (image.contentType === 'image/webp' && bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP'));
    if (!valid) throw Object.assign(new Error('Usa una imagen PNG, JPEG o WebP válida de hasta 5 MB.'), { status: 400 });
    const folder = professional === null ? 'logos' : `profesionales/${professional}/firmas`;
    const key = prefix + folder + '/' + image.key.replace('.', '-' + digest(imageData) + '.');
    const object = await s3.uploadBufferToBucket(bucket(), bytes, key, image.contentType);
    return { ...object, Key: key };
}
async function signedImage(value, business) {
    if (!isPrivateKey(value)) return value;
    return s3.signGetObject(bucket(), assertKey(value, business), 300);
}
async function inlineImage(value, business) {
    if (!isPrivateKey(value)) return value;
    const object = await s3.readObject(bucket(), assertKey(value, business));
    if (!Buffer.isBuffer(object.Body) || object.Body.length > maxImageBytes || !/^image\/(png|jpeg|webp)$/.test(object.ContentType)) throw new Error('Imagen privada inválida.');
    return `data:${object.ContentType};base64,${object.Body.toString('base64')}`;
}
async function remove(key, business) {
    if (isPrivateKey(key)) await compensateUpload(bucket(), { Key: assertKey(key, business) });
}
async function pending(object) {
    if (object) await queueUploadCleanup(bucket(), object, 'persistence_unknown_verify_before_delete');
}
module.exports = { isPrivateKey, assertKey, digest, upload, signedImage, inlineImage, remove, pending };

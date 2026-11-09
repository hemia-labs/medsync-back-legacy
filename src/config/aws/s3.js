const fs = require('node:fs');
const { S3Client, DeleteObjectCommand, GetObjectCommand, ListBucketsCommand } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const config = require('../config');
const { validatedAwsRegion } = require('./region');
const { maxImageBytes } = require('../../util/file/image');

let s3;
function getS3() {
    if (!s3) {
        s3 = new S3Client({
            region: validatedAwsRegion(config.AWS_REGION),
            ignoreConfiguredEndpointUrls: true,
            credentials: config.AWS_ACCESS_KEY && config.AWS_SECRET_KEY ? {
                accessKeyId: config.AWS_ACCESS_KEY,
                secretAccessKey: config.AWS_SECRET_KEY,
                sessionToken: process.env.AWS_SESSION_TOKEN || undefined
            } : undefined
        });
    }
    return s3;
}

async function upload(client, params) {
    const result = await new Upload({ client, params, queueSize: 1 }).done();
    return { ...result, Key: params.Key, key: params.Key };
}

function uploadToBucket(Bucket, tempFilePath, Key) {
    const client = getS3();
    return upload(client, { Bucket, Key, Body: fs.createReadStream(tempFilePath) });
}

function uploadBufferToBucket(Bucket, Body, Key, ContentType) {
    if (!Buffer.isBuffer(Body)) throw new TypeError('Se requiere una imagen decodificada.');
    return upload(getS3(), { Bucket, Key, Body, ContentType });
}

async function readObject(Bucket, Key) {
    const object = await getS3().send(new GetObjectCommand({ Bucket, Key }));
    const chunks = [];
    let size = 0;
    // Consume or close the v3 stream so the HTTP connection can be released.
    for await (const chunk of object.Body) {
        size += chunk.length;
        if (size > maxImageBytes) throw new Error('Imagen privada inválida.');
        chunks.push(chunk);
    }
    return { ...object, Body: Buffer.concat(chunks, size) };
}

module.exports = {
    getBuckets: () => getS3().send(new ListBucketsCommand({})),
    uploadToBucket,
    uploadBufferToBucket,
    deleteFileToBucket: (Bucket, Key) => getS3().send(new DeleteObjectCommand({ Bucket, Key })),
    signGetObject: (Bucket, Key, expiresIn) => getSignedUrl(
        getS3(), new GetObjectCommand({ Bucket, Key, ResponseCacheControl: 'private, no-store' }), { expiresIn }
    ),
    readObject
};

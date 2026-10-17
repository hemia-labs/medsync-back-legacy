
const config = require('../config');
const AWS = require('aws-sdk');
const fs = require('fs');
const { validatedAwsRegion } = require('./region');

let s3;
function getS3() {
    if (!s3) {
        s3 = new AWS.S3({
            apiVersion: config.AWS_API_VERSION,
            accessKeyId: config.AWS_ACCESS_KEY,
            secretAccessKey: config.AWS_SECRET_KEY,
            region: validatedAwsRegion(config.AWS_REGION)
        });
    }
    return s3;
}

/**
 * Obtiene la lista de buckets
 * @returns 
 */
const getBuckets = () => {
    return getS3().listBuckets().promise();
};

/**
 * Realiza la carga de archivos a un bucket
 * @param {String} bucketName Nombre del Bucket
 * @param {String} tempFilePath path del archivo
 * @param {String} key Key
 * @returns 
 */
const uploadToBucket = (bucketName, tempFilePath, key) => {
    const client = getS3();
    const stream = fs.createReadStream(tempFilePath);
    const params = {
        Bucket:bucketName,
        Key: key,
        Body: stream
    };
     return client.upload(params).promise();
};

/**
 * Elimina un archivo de un bucket especifico
 * @param {String} bucketName Nombre del Bucket
 * @param {String} key Key
 * @returns 
 */
const deleteFileToBucket = (bucketName, key) => {
    const params = {
        Bucket:bucketName,
        Key: key
    };
     return getS3().deleteObject(params).promise();
};

module.exports = {
    getBuckets,
    uploadToBucket,
    deleteFileToBucket
};

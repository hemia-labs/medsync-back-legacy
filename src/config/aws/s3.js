
const config = require('../config');
const AWS = require('aws-sdk');
const fs = require('fs');
AWS.config.update({ "accessKeyId": config.AWS_ACCESS_KEY, "secretAccessKey": config.AWS_SECRET_KEY, "region": config.AWS_REGION });

const s3 = new AWS.S3({apiVersion: config.AWS_API_VERSION});

/**
 * Obtiene la lista de buckets
 * @returns 
 */
const getBuckets = () => {
    return s3.listBuckets().promise();
};

/**
 * Realiza la carga de archivos a un bucket
 * @param {String} bucketName Nombre del Bucket
 * @param {String} tempFilePath path del archivo
 * @param {String} key Key
 * @returns 
 */
const uploadToBucket = (bucketName, tempFilePath, key) => {
    const stream = fs.createReadStream(tempFilePath);
    const params = {
        Bucket:bucketName,
        Key: key,
        Body: stream
    };
     return s3.upload(params).promise();
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
     return s3.deleteObject(params).promise();
};

module.exports = {
    getBuckets,
    uploadToBucket,
    deleteFileToBucket
};

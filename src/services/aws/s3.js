const s3 = require('../../config/aws/s3');
const config = require('../../config/config');


async function getBuckets () {
    return await s3.getBuckets();
};

async function uploadFile (bucketName, tempFilePath, key) {
    return await s3.uploadToBucket(bucketName, tempFilePath, key);
};

async function deleteFile (bucketName, key) {
    return await s3.deleteFileToBucket(bucketName, key);
};

function getBucketbyCode (code){
    switch (code) {
        case 'CFCD20':    
            return config.BUCKETS.FIRMAS;
        case 'C4CA42':    
            return config.BUCKETS.PHOTOS;
        case 'C81E72':    
            return config.BUCKETS.XRAY;
        default: return null;
    }
}

module.exports={
    getBuckets,
    uploadFile,
    getBucketbyCode,
    deleteFile
};
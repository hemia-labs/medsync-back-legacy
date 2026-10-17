'use strict';

// AWS SDK v2 does not validate the region before building request endpoints.
// Keep the S3 default while excluding host/path/port injection (GHSA-j965-2qgj-vjmq).
function validatedAwsRegion(value) {
    const region = value === undefined || value === null || value === '' ? 'us-east-1' : value;
    if (typeof region !== 'string' || region.length > 63 || !/^[a-z]{2,4}(?:-[a-z0-9]+){1,3}-[0-9]{1,2}$/.test(region)) {
        const error = new Error('AWS_REGION tiene un formato no permitido.');
        error.code = 'AWS_REGION_INVALID';
        throw error;
    }
    return region;
}

module.exports = { validatedAwsRegion };

/* Read-only S18 check. Never prints bucket names, object keys, URLs or credentials.
 * No writes, uploads, ACL/policy changes or database/data export.
 * A denied control-plane query is UNKNOWN, not proof of private storage.
 */
'use strict';
const config = require('../../src/config/config');
const { S3Client, GetPublicAccessBlockCommand, GetBucketPolicyStatusCommand, GetBucketAclCommand } = require('@aws-sdk/client-s3');
const { validatedAwsRegion } = require('../../src/config/aws/region');
let s3;
const safeCode = error => /^[A-Za-z0-9_]+$/.test(error.name || '') ? error.name : 'UNAVAILABLE';
async function inspect(category, bucket) {
    if (!bucket) return { category, configured: false };
    const result = { category, configured: true };
    try {
        const response = await s3.send(new GetPublicAccessBlockCommand({ Bucket: bucket }), { abortSignal: AbortSignal.timeout(10000) });
        result.bucketPublicAccessBlock = response.PublicAccessBlockConfiguration;
    } catch (error) { result.bucketPublicAccessBlock = { unknown: safeCode(error) }; }
    try {
        const response = await s3.send(new GetBucketPolicyStatusCommand({ Bucket: bucket }), { abortSignal: AbortSignal.timeout(10000) });
        result.policyPublic = Boolean(response.PolicyStatus && response.PolicyStatus.IsPublic);
    } catch (error) { result.policyPublic = { unknown: safeCode(error) }; }
    try {
        const response = await s3.send(new GetBucketAclCommand({ Bucket: bucket }), { abortSignal: AbortSignal.timeout(10000) });
        result.bucketPublicAcl = (response.Grants || []).some(grant => /\/(AllUsers|AuthenticatedUsers)$/.test(grant.Grantee && grant.Grantee.URI || ''));
    } catch (error) { result.bucketPublicAcl = { unknown: safeCode(error) }; }
    return result;
}
(async () => {
    if (!config.AWS_ACCESS_KEY || !config.AWS_SECRET_KEY) {
        console.log(JSON.stringify({ checkedAt: new Date().toISOString(), outcome: 'UNVERIFIED', reason: 'AWS credentials not configured' }, null, 2));
        return;
    }
    s3 = new S3Client({
        credentials: { accessKeyId: config.AWS_ACCESS_KEY, secretAccessKey: config.AWS_SECRET_KEY, sessionToken: process.env.AWS_SESSION_TOKEN },
        region: validatedAwsRegion(config.AWS_REGION),
        ignoreConfiguredEndpointUrls: true,
        maxAttempts: 1
    });
    const results = [];
    for (const [category, bucket] of Object.entries(config.BUCKETS)) results.push(await inspect(category, bucket));
    console.log(JSON.stringify({ checkedAt: new Date().toISOString(), readOnly: true, results,
        limits: 'Bucket controls only. Account controls, object ACLs, public object access, historical URLs and CloudFront/CDN are not verified by this check.' }, null, 2));
})().catch(error => { console.error('S18 storage audit:', safeCode(error)); process.exitCode = 1; });

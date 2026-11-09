'use strict';

// Local-only compatibility/security checks: no real DB, SMTP, AWS or external HTTP.
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { createRequire } = require('node:module');
const axios = require('axios');
const nodemailer = require('nodemailer');
const proxyaddr = require('proxy-addr');
const { validatedAwsRegion } = require('../../src/config/aws/region');

function replaceModule(relativePath, exports) {
    const id = require.resolve(relativePath);
    require.cache[id] = { id, filename: id, loaded: true, exports };
}

async function main() {
    const invalidMappedTrust = proxyaddr.compile('::ffff:10.0.0.0/8');
    assert.equal(invalidMappedTrust('203.0.113.17'), false, 'Malformed mapped subnet must not trust arbitrary IPv4 clients.');
    const privateTrust = proxyaddr.compile('10.0.0.0/8');
    assert.equal(privateTrust('10.10.1.1'), true);
    assert.equal(privateTrust('203.0.113.17'), false);

    for (const region of ['us-east-1', 'mx-central-1', 'us-gov-west-1', 'eu-isoe-west-1', 'eusc-de-east-1']) {
        assert.equal(validatedAwsRegion(region), region);
    }
    assert.equal(validatedAwsRegion(''), 'us-east-1');
    for (const region of ['us-east-1.attacker.example', 'us-east-1/path', 'http://us-east-1', 'us-east-1:443', 'us-east-1\n', {}, ' ']) {
        assert.throws(() => validatedAwsRegion(region), { code: 'AWS_REGION_INVALID' });
    }

    const uuid = require('uuid');
    const sequelizeRequire = createRequire(require.resolve('sequelize'));
    assert.equal(sequelizeRequire('uuid/package.json').version, '11.1.1');
    assert.equal(uuid.validate(sequelizeRequire('uuid').v4()), true);
    const sequelizeUtils = require('sequelize/lib/utils');
    const { DataTypes } = require('sequelize');
    assert.equal(uuid.version(sequelizeUtils.toDefaultValue(DataTypes.UUIDV1())), 1);
    assert.equal(uuid.version(sequelizeUtils.toDefaultValue(DataTypes.UUIDV4())), 4);

    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ method: req.method, path: req.url, body: JSON.parse(Buffer.concat(chunks).toString()) }));
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        const client = axios.default.create({ baseURL: `http://127.0.0.1:${server.address().port}`, proxy: false });
        const response = await client.post('/checkout', { total: 180 });
        assert.deepEqual(response.data, { method: 'POST', path: '/checkout', body: { total: 180 } });
    } finally {
        await new Promise(resolve => server.close(resolve));
    }

    const messages = [];
    const originalCreateTransport = nodemailer.createTransport;
    nodemailer.createTransport = () => {
        const transport = originalCreateTransport({ streamTransport: true, buffer: true, newline: 'unix' });
        const originalSendMail = transport.sendMail.bind(transport);
        transport.sendMail = async message => {
            const result = await originalSendMail(message);
            messages.push({ message, result });
            return result;
        };
        return transport;
    };
    try {
        replaceModule('../../src/config/env', {});
        replaceModule('../../src/config/config', { SERVICEMAIL: 'test', USERGMAIL: 'sender@example.invalid', PASSWORDGMAIL: 'test' });
        replaceModule('../../src/services/email/email.service', { sendTransactionalEmail: message => provider.send(message) });
        const NodemailerProvider = require('../../src/services/email/providers/nodemailer.provider');
        const provider = new NodemailerProvider();
        provider.config = { host: 'smtp.example.invalid', port: 587, secure: false, user: 'test', password: 'test', from: 'sender@example.invalid', replyTo: 'reply@example.invalid' };
        const sent = await provider.send({ to: 'recipient@example.invalid', subject: 'Consentimiento', html: '<p>Documento</p>', text: 'Documento' });
        assert.equal(sent.success, true);
        assert.ok(sent.messageId);
        assert.equal(messages[0].message.replyTo, 'reply@example.invalid');
        assert.match(messages[0].result.message.toString(), /Content-Type: multipart\/alternative/);
        const legacy = require('../../src/mail/mail');
        assert.deepEqual(await legacy.SendMail('recipient@example.invalid', '<p>Documento</p>', 'Consentimiento', 'Documento'), { process: true, errorCode: null });
        assert.equal(messages.length, 2);
        assert.deepEqual(messages[1].result.envelope.to, ['recipient@example.invalid']);
    } finally {
        nodemailer.createTransport = originalCreateTransport;
    }

    // Fail before constructing a client or opening a local upload stream.
    let clientsCreated = 0;
    replaceModule('../../src/config/config', { AWS_REGION: 'us-east-1.attacker.example' });
    replaceModule('@aws-sdk/client-s3', { ...require('@aws-sdk/client-s3'), S3Client: class { constructor() { clientsCreated += 1; } } });
    const s3 = require('../../src/config/aws/s3');
    for (const operation of [() => s3.getBuckets(), () => s3.deleteFileToBucket('unused', 'unused'),
        () => s3.uploadToBucket('unused', path.join(__dirname, 'does-not-exist'), 'unused'),
        () => s3.uploadBufferToBucket('unused', Buffer.from('synthetic'), 'unused.png', 'image/png')]) {
        assert.throws(operation, { code: 'AWS_REGION_INVALID' });
    }
    assert.equal(clientsCreated, 0);
    console.log('PASS dependency regression: proxy trust, region validation, UUID consumers, Axios local HTTP and central SMTP/legacy compatibility dispatch (no delivery).');
}

main().catch(error => { console.error(error); process.exitCode = 1; });

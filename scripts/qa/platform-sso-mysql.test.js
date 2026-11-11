'use strict';
// Opt-in integration test. Dedicated loopback MySQL only; never loads application env files.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const mysql = require('mysql2/promise');
const { Sequelize, QueryTypes } = require('sequelize');
const jwt = require('jsonwebtoken');
const { createSession } = require('../../src/auth/platformSsoSession');

test('SSO session and refresh revocation use the existing MySQL schema atomically', async t => {
    const port = Number(process.env.QA_SSO_MYSQL_PORT);
    assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535 && port !== 3306,
        'Set QA_SSO_MYSQL_PORT to a dedicated local QA server, not the usual database');
    const database = 'qa_platform_sso_' + randomUUID().replaceAll('-', '');
    const connection = { host: '127.0.0.1', port, user: 'root', password: '' };
    let setup = await mysql.createConnection(connection);
    await setup.query('CREATE DATABASE `' + database + '`');
    await setup.end();
    const db = new Sequelize(database, 'root', '', { host: connection.host, port, dialect: 'mysql',
        logging: false, pool: { max: 1, min: 0 }, retry: { max: 0 } });
    const binding = { sub: 'synthetic-subject', email: 'operator@example.test', id_login: 'operator' };
    const key = 'synthetic-signing-key-only-for-isolated-tests';
    const identity = { ...binding, email_verified: true, exp: Math.floor(Date.now() / 1000) + 600 };
    async function seed() {
        for (const table of ['audit', 'session', 'refresh_token']) await db.query('DELETE FROM `' + table + '`');
        await db.query("INSERT INTO refresh_token VALUES ('current','operator',1,NULL,NULL)," +
            "('rotated','operator',0,NULL,NULL),('revoked','operator',0,'2025-01-01','manual')," +
            "('unrelated','another',1,NULL,NULL)");
        await db.query("INSERT INTO `session` (id_session,id_login,active,`last`,sec) VALUES ('previous','operator',1,1,1),('unrelated','another',1,1,1)");
    }
    const rows = (sql) => db.query(sql, { type: QueryTypes.SELECT });
    try {
        await db.query('CREATE TABLE rol (id_rol VARCHAR(50) PRIMARY KEY, code VARCHAR(50), active TINYINT)');
        await db.query('CREATE TABLE login (id_login VARCHAR(50) PRIMARY KEY, id_business VARCHAR(50), id_rol VARCHAR(50), name VARCHAR(100), email VARCHAR(100), active TINYINT, locked TINYINT)');
        // Production contract: refresh_token has `last` and revoked_at, never `active`.
        await db.query('CREATE TABLE refresh_token (id_refresh_token VARCHAR(50) PRIMARY KEY, id_login VARCHAR(50), `last` TINYINT, revoked_at DATETIME, revoked_reason VARCHAR(80))');
        await db.query('CREATE TABLE `session` (id_session VARCHAR(50) PRIMARY KEY, id_login VARCHAR(50), `last` TINYINT, active TINYINT, sec INT, created_at DATETIME, created_by VARCHAR(50), updated_at DATETIME)');
        await db.query('CREATE TABLE audit (action VARCHAR(80), target_id VARCHAR(50))');
        await db.query("INSERT INTO rol VALUES ('role','super_admin',1)");
        await db.query("INSERT INTO login VALUES ('operator',NULL,'role','QA operator','operator@example.test',1,0)");
        const audit = { record: (action, context, options) => {
            assert.equal(options.strict, true);
            return db.query('INSERT INTO audit VALUES (:action,:target)', {
                replacements: { action, target: context.target_id }, transaction: options.transaction,
            });
        } };
        await t.test('creates the session, revokes own tokens and preserves other users and revocation history', async () => {
            await seed();
            const result = await createSession({ bindings: [binding], issuer: 'https://identity.example.test' }, identity, db, key, audit);
            const claims = jwt.verify(result.token, key);
            assert.equal(claims.id_login, 'operator');
            assert.equal(claims.auth_method, 'hemia_sso');
            assert.ok(result.ttl > 0 && result.ttl <= 600);
            const tokens = await rows('SELECT * FROM refresh_token');
            for (const id of ['current', 'rotated']) {
                const token = tokens.find(row => row.id_refresh_token === id);
                assert.equal(token.last, 0);
                assert.ok(token.revoked_at);
                assert.equal(token.revoked_reason, 'sso_login');
            }
            assert.equal(tokens.find(row => row.id_refresh_token === 'revoked').revoked_reason, 'manual');
            assert.equal(tokens.find(row => row.id_refresh_token === 'unrelated').last, 1);
            assert.equal(tokens.find(row => row.id_refresh_token === 'unrelated').revoked_at, null);
            const sessions = await rows('SELECT * FROM `session`');
            assert.equal(sessions.find(row => row.id_session === 'previous').active, 0);
            assert.equal(sessions.find(row => row.id_session === 'unrelated').active, 1);
            assert.equal(sessions.find(row => row.id_session === claims.id_session).sec, 2);
            assert.equal((await rows('SELECT * FROM audit'))[0].action, 'PLATFORM_SSO_LOGIN');
        });
        await t.test('audit failure rolls back revocation and the new session', async () => {
            await seed();
            const beforeTokens = await rows('SELECT * FROM refresh_token ORDER BY id_refresh_token');
            const beforeSessions = await rows('SELECT * FROM `session` ORDER BY id_session');
            await assert.rejects(createSession({ bindings: [binding] }, identity, db, key, {
                record: async () => { throw new Error('synthetic audit failure'); },
            }), /synthetic audit failure/);
            assert.deepEqual(await rows('SELECT * FROM refresh_token ORDER BY id_refresh_token'), beforeTokens);
            assert.deepEqual(await rows('SELECT * FROM `session` ORDER BY id_session'), beforeSessions);
            assert.equal((await rows('SELECT * FROM audit')).length, 0);
        });
    } finally {
        await db.close();
        setup = await mysql.createConnection(connection);
        try { await setup.query('DROP DATABASE `' + database + '`'); } finally { await setup.end(); }
    }
});

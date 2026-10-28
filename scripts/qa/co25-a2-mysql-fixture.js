'use strict';
// New disposable MySQL instance and schema; no env loader or existing databases.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const mysql = require('mysql2/promise');
const { Sequelize, QueryTypes } = require('sequelize');
const root = path.resolve(__dirname, '../../..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function createFixture() {
    const binary = path.join(root, '_qa/medsync-pulse-p2/mysql/mysql-8.0.46-winx64/bin/mysqld.exe');
    if (!fs.existsSync(binary)) throw Error('Isolated MySQL binary unavailable');
    const requested = process.env.CO25_A2_MYSQL_DIR;
    const folder = requested ? path.resolve(requested) : path.join(root, '_qa/co25-a2/mysql-' + randomUUID());
    if (!folder.startsWith(path.join(root, '_qa/co25-a2/mysql-')) || (requested && !fs.existsSync(path.join(folder, 'synthetic-only.marker')))) throw Error('Refuse non-QA datadir');
    fs.mkdirSync(folder, { recursive: true });
    const datadir = path.join(folder, 'data');
    const freePort = net.createServer();
    await new Promise(resolve => freePort.listen(0, '127.0.0.1', resolve));
    const port = freePort.address().port;
    await new Promise(resolve => freePort.close(resolve));
    const log = fs.openSync(path.join(folder, 'mysql.log'), 'a');
    const args = ['--no-defaults', '--basedir=' + path.dirname(path.dirname(binary)), '--datadir=' + datadir];
    if (!requested) {
        console.log('Initializing a new isolated MySQL datadir');
        const init = spawnSync(binary, [...args, '--initialize-insecure'], { windowsHide: true, stdio: ['ignore', log, log], timeout: 180000 });
        if (init.status !== 0) { fs.closeSync(log); throw Error('QA MySQL initialization failed; inspect synthetic log'); }
        fs.writeFileSync(path.join(folder, 'synthetic-only.marker'), 'CO25 A2 synthetic fixture');
    }
    const child = spawn(binary, [...args, '--port=' + port, '--bind-address=127.0.0.1', '--mysqlx=OFF', '--event-scheduler=OFF'], { windowsHide: true, stdio: ['ignore', log, log] });
    let connection, db;
    try {
        for (let i = 0; i < 150; i++) {
            try { connection = await mysql.createConnection({ host: '127.0.0.1', port, user: 'root', password: '', connectTimeout: 500 }); break; }
            catch (_) { if (child.exitCode !== null) throw Error('QA MySQL stopped at startup'); await pause(100); }
        }
        if (!connection) throw Error('QA MySQL startup timeout');
        const [[identity]] = await connection.query('SELECT @@port port,@@datadir datadir,VERSION() version');
        if (Number(identity.port) !== port || path.resolve(identity.datadir) !== path.resolve(datadir)) throw Error('Refuse unknown database instance');
        if (requested) await connection.query('DROP DATABASE IF EXISTS qa_co25_a2');
        await connection.query('CREATE DATABASE qa_co25_a2 CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
        await connection.changeUser({ database: 'qa_co25_a2' });
        await connection.query('SET FOREIGN_KEY_CHECKS=0');
        for (const table of ['business', 'rol', 'login', 'doctor_professional_profile', 'person', 'tracing', 'appointment', 'appointment_config', 'appointment_working_day', 'appointment_time_range', 'appointment_blocked_date', 'appointment_blocked_hour', 'cat_permission', 'permission_rol', 'business_role_permission']) {
            const source = fs.readFileSync(path.join(root, 'u575589445_orrico/Tables', table + '.sql'), 'utf8');
            await connection.query(source.match(/CREATE TABLE[\s\S]*?;\s*$/)[0]);
        }
        await connection.query('SET FOREIGN_KEY_CHECKS=1');
        for (const statement of fs.readFileSync(path.join(root, 'hemia-assistance-back-legacy/Scripts_/20261021_agenda_co21_up.sql'), 'utf8').replace(/^--.*$/gm, '').split(';').map(s => s.trim()).filter(Boolean)) await connection.query(statement);
        const procedure = fs.readFileSync(path.join(root, 'u575589445_orrico/Procedures/SP_appointment_config_get.sql'), 'utf8');
        await connection.query(procedure.slice(procedure.indexOf('CREATE DEFINER'), procedure.lastIndexOf('//')).replace(/CREATE DEFINER=[^ ]+ PROCEDURE/, 'CREATE PROCEDURE').trim());
        await connection.end(); connection = null;
        db = new Sequelize('qa_co25_a2', 'root', '', { host: '127.0.0.1', port, dialect: 'mysql', logging: false, pool: { max: 2, min: 0, idle: 1000 } });
        const id = require.resolve('../../src/db/Sequelize.connection');
        require.cache[id] = { id, filename: id, loaded: true, exports: db };
        const dao = require('../../src/Dao/mysql/appointment.Dao');
        const query = (sql, replacements = {}) => db.query(sql, { replacements, type: /^\s*SELECT/i.test(sql) ? QueryTypes.SELECT : QueryTypes.RAW });
        const body = { id_business: 'qa-clinic', id_login: 'qa-actor' };
        await query("INSERT INTO business(id_business,name,slug) VALUES('qa-clinic','QA Clinic','qa-clinic'),('other-clinic','Other QA','other-qa')");
        await query("INSERT INTO rol(id_rol,desc_rol) VALUES('qa-role','QA')");
        await query("INSERT INTO login(id_login,id_business,id_rol,active) VALUES('qa-actor','qa-clinic','qa-role',1)");
        await query("INSERT INTO cat_permission(id_cat_permission,code,name,description) VALUES('qa-monitor','px.tab.monitoring','QA','QA')");
        await query("INSERT INTO permission_rol(id_permission_rol,id_cat_permission,id_rol) VALUES('qa-monitor-role','qa-monitor','qa-role')");
        await query("INSERT INTO doctor_professional_profile(id_doctor_professional_profile,id_business,id_login,professional_name) VALUES('qa-doctor','qa-clinic','qa-actor','Doctor QA')");
        await query("INSERT INTO person(id_person,id_business,name,surname,active) VALUES('qa-patient','qa-clinic','Paciente','Sintetico',1)");
        await query("INSERT INTO tracing(id_tracing,id_business,id_person,treatment_now,treatment_after,quote_date_after) VALUES('qa-trace','qa-clinic','qa-patient','PRIVATE_CLINICAL_NOW','PRIVATE_CLINICAL_AFTER','2029-12-31')");
        for (const profile of [null, 'qa-doctor']) await dao.readConfig(body.id_business, profile);
        await query('UPDATE appointment_config SET enabled=1');
        await query('UPDATE appointment_working_day SET enabled=1');
        await query('DELETE FROM appointment_time_range');
        await query("INSERT INTO appointment_time_range(id_appointment_time_range,id_business,id_appointment_working_day,start_time,end_time) SELECT UUID(),id_business,id_appointment_working_day,'00:00','23:59' FROM appointment_working_day");
        return { db, dao, query, body, folder, port, version: identity.version, async close() {
            try { await db.query('SHUTDOWN'); } catch (_) { /* Server can close the connection first. */ }
            await db.close(); if (child.exitCode === null) child.kill(); fs.closeSync(log);
        } };
    } catch (error) {
        if (connection) await connection.end().catch(() => {});
        if (db) await db.close().catch(() => {});
        child.kill(); fs.closeSync(log); throw error;
    }
}
async function createHttp(f) {
    const inject = (file, exports) => { const id = require.resolve(file); require.cache[id] = { id, filename: id, loaded: true, exports }; };
    // Isolate authentication/session infrastructure; use the real route, permission gate,
    // controller, DAO, validators, SQL and transaction boundaries.
    inject('../../src/auth/authenticate', { Auth(req, res, next) {
        if (req.headers['x-qa-role'] === 'anonymous') return res.status(401).json({ status: 401 });
        req.tokenDecode = { ...f.body, id_login: req.headers['x-qa-role'] === 'monitoring' ? 'qa-monitoring' : 'qa-actor', id_business: req.headers['x-qa-tenant'] || f.body.id_business }; next();
    } });
    inject('../../src/middleware/requireTenantOperational.middleware', (_req, _res, next) => next());
    inject('../../src/middleware/csrf.middleware', { csrfProtection: () => (_req, _res, next) => next() });
    inject('../../src/Dao/mysql/user.dao', { hasPermission: async (actor, permission) => actor === 'qa-actor' ? permission === 'px.dates' : permission === 'px.tab.monitoring' });
    inject('../../src/services/security/securityLogger.service', { record() {} });
    const express = require('express'), app = express();
    app.use(express.json());
    const writes = [];
    app.use((req, _res, next) => { if (req.method !== 'GET') writes.push({ method: req.method, path: req.path, body: req.body }); next(); });
    app.use('/api/appointment', require('../../src/routes/mysql/appointment'));
    const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    return { app, writes, url: 'http://127.0.0.1:' + server.address().port, close: () => new Promise(resolve => server.close(resolve)) };
}
module.exports = { createFixture, createHttp };

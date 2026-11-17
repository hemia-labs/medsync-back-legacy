'use strict';
// Self-contained MySQL 8.4 container; never consumes .env or connects to a live database.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const mysql = require('mysql2/promise');
const { Sequelize, QueryTypes } = require('sequelize');
const { audit, apply, TEMPLATE_ID } = require('../migrations/clinical-history-base-template');
const { baseClinicalHistoryTemplate } = require('../../src/domain/clinicalHistory/clinicalHistoryBaseTemplate');
const name = 'medsync-history-base-' + Date.now();
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const stub = (file, exports) => { const id = require.resolve(file); require.cache[id] = { id, filename: id, loaded: true, exports }; };
(async () => {
    let db, sequelize, second, started = false;
    const backup = await fs.mkdtemp(path.join(os.tmpdir(), name));
    try {
        docker('run', '--detach', '--rm', '--name', name, '--memory', '768m', '--cpus', '1', '-e', 'MYSQL_ALLOW_EMPTY_PASSWORD=yes', '-e', 'MYSQL_ROOT_HOST=%', '-e', 'MYSQL_DATABASE=qa_history', '-p', '127.0.0.1::3306', 'mysql:8.4'); started = true;
        const port = Number(docker('port', name, '3306/tcp').split(':').at(-1));
        const options = { host: '127.0.0.1', port, user: 'root', password: '', database: 'qa_history' };
        for (let i = 0; i < 60; i++) { try { db = await mysql.createConnection(options); break; } catch { await pause(500); } }
        if (!db) throw Error('ISOLATED_MYSQL_NOT_READY');
        await db.query(`CREATE TABLE clinical_history_templates (id_clinical_history_template VARCHAR(50) PRIMARY KEY,
            business_id VARCHAR(50) NULL, name VARCHAR(160), description VARCHAR(500), is_system_template TINYINT,
            is_active TINYINT, deleted_at DATETIME NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP) COLLATE utf8mb4_unicode_ci`);
        await db.query(`CREATE TABLE clinical_history_template_versions (id_clinical_history_template_version VARCHAR(50) PRIMARY KEY,
            clinical_history_template_id VARCHAR(50), version_number INT, schema_json LONGTEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(clinical_history_template_id,version_number), FOREIGN KEY(clinical_history_template_id) REFERENCES clinical_history_templates(id_clinical_history_template)) COLLATE utf8mb4_unicode_ci`);
        sequelize = new Sequelize('qa_history', 'root', '', { host: options.host, port, dialect: 'mysql', logging: false, pool: { max: 1 } });
        stub('../../src/db/Sequelize.connection', sequelize);
        stub('../../src/services/aws/privateImages', {}); // No storage calls are part of template resolution.
        const templates = require('../../src/Dao/mysql/clinicalHistoryTemplate.dao');
        const histories = require('../../src/Dao/mysql/clinicalHistory.dao');
        assert.equal((await templates.getCurrentTemplateForBusiness('new-clinic')).template, null);
        assert.equal((await audit(db)).ready, false);
        console.log('PASS reproduction: a new clinic cannot resolve a template on an empty installation');
        // A version failure must leave no half-installed template.
        await db.query("CREATE TRIGGER qa_fail_version BEFORE INSERT ON clinical_history_template_versions FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='synthetic failure'");
        await assert.rejects(apply(db, path.join(backup, 'failure')));
        assert.equal((await db.query('SELECT COUNT(*) count FROM clinical_history_templates'))[0][0].count, 0);
        await db.query('DROP TRIGGER qa_fail_version');
        console.log('PASS real transaction rollback');
        second = await mysql.createConnection(options);
        const results = await Promise.all([apply(db, path.join(backup, 'a')), apply(second, path.join(backup, 'b'))]);
        assert.equal(results.filter(result => result.created).length, 1);
        assert.equal((await apply(db, path.join(backup, 'reentry'))).created, false);
        assert.equal((await db.query('SELECT COUNT(*) count FROM clinical_history_templates'))[0][0].count, 1);
        console.log('PASS concurrent installation and reentry without duplicates');
        const current = await templates.getCurrentTemplateForBusiness('new-clinic');
        assert.equal(current.source, 'SYSTEM'); assert.equal(current.template.id_clinical_history_template, TEMPLATE_ID);
        assert.equal(templates.validateSchema(current.template.schema_json).ok, true);
        const snapshot = await histories.resolveTemplateSnapshot('new-clinic');
        assert.equal(snapshot.templateVersionId, current.template.id_clinical_history_template_version);
        assert.deepEqual(JSON.parse(snapshot.templateSnapshotJson), current.template.schema_json);
        console.log('PASS actual DAOs: default resolution and immutable history snapshot');
        await db.query("INSERT INTO clinical_history_templates VALUES ('custom','custom-clinic','Custom','Synthetic',0,1,NULL,NOW(),NOW())");
        const custom = structuredClone(baseClinicalHistoryTemplate); custom.sections[1].label = 'Custom QA';
        await db.query("INSERT INTO clinical_history_template_versions VALUES ('custom-v1','custom',1,?,NOW())", [JSON.stringify(custom)]);
        assert.equal((await templates.getCurrentTemplateForBusiness('custom-clinic')).source, 'BUSINESS');
        assert.equal((await templates.getCurrentTemplateForBusiness('another-new-clinic')).source, 'SYSTEM');
        const before = await sequelize.query('SELECT * FROM clinical_history_template_versions ORDER BY id_clinical_history_template_version', { type: QueryTypes.SELECT });
        await apply(db, path.join(backup, 'preserve'));
        assert.deepEqual(await sequelize.query('SELECT * FROM clinical_history_template_versions ORDER BY id_clinical_history_template_version', { type: QueryTypes.SELECT }), before);
        console.log('PASS existing custom formats and other tenants preserved');
    } finally {
        if (second) await second.end(); if (db) await db.end(); if (sequelize) await sequelize.close();
        if (started) docker('rm', '-f', name);
        await fs.rm(backup, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });

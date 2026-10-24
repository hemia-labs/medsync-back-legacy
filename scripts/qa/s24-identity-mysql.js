'use strict';
// Synthetic schema only, on a separately started loopback server. Never loads env.
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const { randomUUID } = require('node:crypto');
const { inventory, normalizePhone, normalizeEmail } = require('../../src/services/registration/identity');
const migration = require('../migrations/s24-registration-identity');
const schema = require('../migrations/s24IdentitySchema');
const fs = require('node:fs/promises');
const path = require('node:path');

async function run() {
    if (process.env.S24_QA_ISOLATED !== '1') throw new Error('Set S24_QA_ISOLATED=1 for the synthetic loopback server');
    const port = Number(process.env.S24_QA_PORT || 33324);
    if (port === 3306 || !Number.isInteger(port)) throw new Error('Refusing default/shared MySQL port');
    const database = 's24_qa_' + randomUUID().replace(/-/g, '');
    const config = { host: '127.0.0.1', port, user: 'root', password: '', multipleStatements: false, namedPlaceholders: true };
    const db = await mysql.createConnection(config);
    let competitor;
    const results = [];
    const passed = name => results.push(name);
    try {
        await db.query('CREATE DATABASE ' + mysql.escapeId(database) + ' CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
        await db.changeUser({ database });
        await db.query(`CREATE TABLE business (id_business VARCHAR(50) PRIMARY KEY, subscription_status VARCHAR(30) NOT NULL,
            plan VARCHAR(100), status VARCHAR(30) DEFAULT 'active', active TINYINT DEFAULT 1)
            ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
        await db.query(`CREATE TABLE login (id_login VARCHAR(50) PRIMARY KEY,id_business VARCHAR(50),id_rol VARCHAR(50) DEFAULT 'admin',name VARCHAR(200),
            telephone VARCHAR(50),email VARCHAR(500),password VARCHAR(500),active TINYINT DEFAULT 1,locked TINYINT DEFAULT 0,
            created_at DATETIME,updated_at DATETIME)
            ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
        await db.query("INSERT INTO business (id_business,subscription_status) VALUES ('legacy','active'),('pending','pending_activation')");
        await db.query("INSERT INTO login(id_login,id_business,telephone,email,active) VALUES ('old','legacy','5512345678','Old@Example.test',0)");
        let before = await migration.audit(db);
        assert.equal(before.readyForInitialMigration, false, 'Never backfill a pending account as legacy');
        await db.query("UPDATE business SET subscription_status='active' WHERE id_business='pending'");
        before = await migration.audit(db);
        assert.equal(before.readyForInitialMigration, true);
        await migration.apply(db, before);
        assert.equal((await migration.audit(db)).objectsPresent, 7);
        await assert.rejects(migration.apply(db, await migration.audit(db)), /S24_PREFLIGHT_FAILED/);
        passed('migration preflight, fresh apply and safe refusal of existing schema');
        const [[old]] = await db.query("SELECT COUNT(*) n, SUM(verified_at IS NOT NULL) verified FROM auth_identity WHERE id_login='old'");
        assert.equal(old.n, 2); assert.equal(Number(old.verified), 0);
        passed('inactive accounts reserve both contacts without asserting verification');

        for (const value of ['5512345678',' +52 (55) 1234-5678 ','525512345678','555.123.4567','0012345','+15551234567','abc',null,'\t5512345678']) {
            const [[row]] = await db.query('SELECT s24_phone(?) value', [value]);
            assert.equal(row.value, normalizePhone(value), 'SQL/JS phone normalization');
        }
        for (const value of [' A+tag@Example.test ','a.b@example.test','a@b','á@example.test','x@y.test\n','x`y@example.test',null,'x'.repeat(250)+'@example.test']) {
            const [[row]] = await db.query('SELECT s24_email(?) value', [value]);
            assert.equal(row.value, normalizeEmail(value), 'SQL/JS email normalization');
        }
        assert.equal(inventory([{id_login:'a',telephone:'5512345678',email:'a@b.test'},
            {id_login:'b',telephone:'+52 55 1234 5678',email:'A@B.test'}]).ready, false);
        passed('canonical parity, aliases and normalized duplicate audit');

        const insert = (connection, id, phone, email, business='legacy') => connection.query(
            'INSERT INTO login(id_login,id_business,telephone,email) VALUES (?,?,?,?)',[id,business,phone,email]);
        const conflict = promise => assert.rejects(promise, error => error.sqlMessage === 'REG_IDENTITY_CONFLICT');
        await conflict(insert(db,'dupe-inactive','+52 (55) 1234-5678','new@example.test'));
        await conflict(insert(db,'dupe-email','5550000001',' OLD@EXAMPLE.TEST '));
        const [[orphan]] = await db.query("SELECT COUNT(*) n FROM auth_identity WHERE normalized_value='5550000001'");
        assert.equal(orphan.n,0,'Second identity failure rolls back the first claim and login row');
        await assert.rejects(insert(db,'invalid','not-a-phone','new@example.test'), error => error.sqlMessage==='REG_IDENTITY_INVALID');
        passed('direct insert conflict, inactive ownership and atomic statement rollback');

        // Exercise the repository's actual stored writers, with only DEFINER stripped.
        for (const name of ['SP_login_Save','SP_login_Update']) {
            const text = await fs.readFile(path.resolve(__dirname, '../../../u575589445_orrico/Procedures',name+'.sql'),'utf8');
            const sql = text.slice(text.indexOf('CREATE '), text.lastIndexOf('//')).replace(/CREATE DEFINER=.*? PROCEDURE/, 'CREATE PROCEDURE').trim();
            await db.query(sql);
        }
        await db.query("CALL SP_login_Save('admin','Fixture','staff@example.test','5550000002','fixture-hash','legacy')");
        await conflict(db.query("CALL SP_login_Save('admin','Fixture','other@example.test','5512345678','fixture-hash','legacy')"));
        const [[staff]] = await db.query("SELECT id_login FROM login WHERE telephone='5550000002'");
        await conflict(db.query("CALL SP_login_Update(?,'admin','Fixture','old@example.test','5550000002',1,'legacy',0)",[staff.id_login]));
        await db.query("UPDATE login SET active=0 WHERE id_login=?",[staff.id_login]);
        await conflict(insert(db,'reactivation-dupe','5550000002','reactivate@example.test'));
        await db.query("UPDATE login SET active=1 WHERE id_login=?",[staff.id_login]);
        passed('real legacy create/update procedures and deactivate/reactivate retain ownership');

        await db.query("UPDATE business SET subscription_status='pending_activation' WHERE id_business='pending'");
        await insert(db,'pending-old','5550000003','pending-old@example.test','pending');
        const [[reservation]] = await db.query("SELECT reservation_status, TIMESTAMPDIFF(SECOND,NOW(3),expires_at) ttl FROM auth_identity WHERE kind='phone' AND id_login='pending-old'");
        assert.equal(reservation.reservation_status,'pending'); assert.ok(reservation.ttl>=86395 && reservation.ttl<=86400);
        await db.query("UPDATE auth_identity SET expires_at=DATE_SUB(NOW(3),INTERVAL 1 SECOND) WHERE id_login='pending-old'");
        await db.query("UPDATE login SET name='Unrelated change' WHERE id_login='pending-old'");
        const [[expiry]] = await db.query("SELECT expires_at<=NOW(3) expired FROM auth_identity WHERE kind='phone' AND id_login='pending-old'");
        assert.equal(expiry.expired,1);
        await insert(db,'pending-new','5550000003','pending-new@example.test','pending');
        const [[owner]] = await db.query("SELECT id_login FROM auth_identity WHERE kind='phone' AND normalized_value='5550000003'");
        assert.equal(owner.id_login,'pending-new');
        await conflict(db.query("UPDATE login SET active=1 WHERE id_login='pending-old'"));
        passed('24h expiry, no implicit renewal, atomic reclamation and lost-owner denial');

        await db.beginTransaction();
        await insert(db,'rollback','5550000004','rollback@example.test','pending');
        await db.query("INSERT INTO registration_attempt(attempt_id,scope_hash,payload_hash,id_login,id_business,expires_at) VALUES (?,?,?,'rollback','pending',DATE_ADD(NOW(),INTERVAL 24 HOUR))",[randomUUID(),'a'.repeat(64),'b'.repeat(64)]);
        await db.rollback();
        for (const table of ['login','auth_identity','registration_attempt']) {
            const [[row]] = await db.query(`SELECT COUNT(*) n FROM ${table} WHERE id_login='rollback'`); assert.equal(row.n,0);
        }
        passed('outer rollback removes login, identities and attempt together');

        competitor = await mysql.createConnection({...config,database});
        await competitor.query('SET SESSION innodb_lock_wait_timeout=5');
        await db.beginTransaction();
        await insert(db,'winner','5550000005','winner@example.test');
        let finished=false;
        const second = insert(competitor,'loser','5550000005','loser@example.test').then(()=>({ok:true}),error=>({error})).finally(()=>{finished=true;});
        await new Promise(resolve=>setTimeout(resolve,100));
        assert.equal(finished,false,'Competing insert waits for the registry row lock');
        await db.commit();
        const outcome=await second;
        assert.equal(outcome.error.sqlMessage,'REG_IDENTITY_CONFLICT');
        const [[count]] = await db.query("SELECT COUNT(*) n FROM login WHERE telephone='5550000005'");
        assert.equal(count.n,1);
        passed('two concurrent connections yield exactly one account');

        await db.query(`CREATE TABLE rol(id_rol VARCHAR(50) PRIMARY KEY,code VARCHAR(30),desc_rol VARCHAR(50),active TINYINT)
            ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
        await db.query('CREATE TABLE session(id_session VARCHAR(50) PRIMARY KEY,id_login VARCHAR(50),active TINYINT,`last` TINYINT) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci');
        await db.query("INSERT INTO rol VALUES ('admin','admin','Administrator',1)");
        await db.query("UPDATE login SET id_rol='admin' WHERE id_login='pending-new'");
        await db.query("INSERT INTO session VALUES ('session-new','pending-new',1,1),('session-old','pending-old',1,1)");
        const dbModule = require.resolve('../../src/db/Sequelize.connection');
        const original = require.cache[dbModule];
        require.cache[dbModule]={exports:{query:async(sql,options)=>(await db.query(sql,options.replacements))[0]}};
        try {
            delete require.cache[require.resolve('../../src/auth/activePrincipal')];
            const activePrincipal=require('../../src/auth/activePrincipal');
            const claims={id_login:'pending-new',id_business:'pending',id_session:'session-new'};
            assert.equal((await activePrincipal(claims)).subscription_status,'pending_activation');
            assert.equal(await activePrincipal({...claims,id_business:'another'}),null);
            assert.equal(await activePrincipal({id_login:'pending-old',id_business:'pending',id_session:'session-old'}),null);
            await db.query("UPDATE auth_identity SET expires_at=DATE_SUB(NOW(3),INTERVAL 1 SECOND) WHERE id_login='pending-new' AND kind='phone'");
            assert.equal(await activePrincipal(claims),null);
            await db.query("UPDATE auth_identity SET reservation_status='verified',expires_at=NULL,verified_at=NOW(3) WHERE id_login='pending-new' AND kind='phone'");
            assert.ok(await activePrincipal(claims));
            await db.query("UPDATE session SET active=0 WHERE id_session='session-new'");
            assert.equal(await activePrincipal(claims),null);
            passed('actual principal SQL: owned, expired, verified, revoked and cross-tenant sessions');
        } finally { if(original) require.cache[dbModule]=original; else delete require.cache[dbModule]; }
        console.log(JSON.stringify({result:'PASS',server:'isolated loopback MySQL',database,connections:2,checks:results},null,2));
    } finally {
        if(competitor) await competitor.end();
        await db.end(); // Keep the synthetic schema as evidence; never DROP user data.
    }
}
run().catch(error=>{console.error(error);process.exitCode=1;});

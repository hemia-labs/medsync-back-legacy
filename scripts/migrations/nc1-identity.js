'use strict';
// Additive; no catalog FK or implicit connection. Reviewed CLI is a separate explicit operator action.
const {models,prefix}=require('../../src/domain/identity/storage');
const {snake,enums}=require('../../src/domain/identity/contract');
const {createHash}=require('node:crypto');
const {InstallationError}=require('./nc1-install-error');
const refTypes={family:'VARCHAR(48) CHARACTER SET ascii COLLATE ascii_bin',release_id:'VARCHAR(50) CHARACTER SET ascii COLLATE ascii_bin',code:'VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin'};
function refColumns(p,family) {
    return [...Object.entries(refTypes).map(([k,t])=>`${p}_${k} ${t} NULL`),
        `CHECK (${p}_code IS NULL OR REGEXP_LIKE(${p}_code,'^[!-~]+$','c'))`,
        `CHECK (${p}_release_id IS NULL OR REGEXP_LIKE(${p}_release_id,'^[A-Za-z0-9][A-Za-z0-9._-]{0,49}$','c'))`,
        `CHECK (${p}_family IS NULL OR ${p}_family = '${family}')`,
        `CHECK ((${p}_family IS NULL AND ${p}_release_id IS NULL AND ${p}_code IS NULL) OR (${p}_family IS NOT NULL AND ${p}_code IS NOT NULL))`];
}
const tables=[];
for(const m of Object.values(models)) {
    const cols=[`id_business VARCHAR(50) NOT NULL`,`${m.key} VARCHAR(50) NOT NULL`,...Object.entries(m.scalars).map(([k,t])=>`${snake(k)} ${t} NULL`),
        ...Object.entries(m.refs).flatMap(([k,f])=>refColumns(prefix(k),f)),
        'revision BIGINT UNSIGNED NOT NULL DEFAULT 1','updated_at DATETIME(3) NOT NULL','updated_by VARCHAR(50) NOT NULL','request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL',
        `PRIMARY KEY(id_business,${m.key})`,'CHECK (revision > 0)',
        ...Object.keys(m.scalars).filter(k=>enums[k]).map(k=>`CHECK (${snake(k)} IS NULL OR ${snake(k)} IN (${enums[k].map(v=>`'${v}'`).join(',')}))`)];
    if(m.table!=='care_establishment') cols.push(`FOREIGN KEY(id_business,${m.key}) REFERENCES ${m.table==='patient_identity'?'person':'doctor_professional_profile'}(id_business,${m.key}) ON DELETE RESTRICT ON UPDATE RESTRICT`);
    if(m.table==='care_establishment') cols.push('CHECK (display_name IS NOT NULL)','CHECK (active IN (0,1))','CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to > valid_from)');
    tables.push([m.table,`CREATE TABLE ${m.table} (${cols.join(',\n')}) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`]);
    if(m.list) tables.push([m.listTable,`CREATE TABLE ${m.listTable} (id_business VARCHAR(50) NOT NULL, ${m.key} VARCHAR(50) NOT NULL, ordinal INT UNSIGNED NOT NULL,
        family ${refTypes.family} NOT NULL, release_id ${refTypes.release_id} NULL, code ${refTypes.code} NOT NULL,
        PRIMARY KEY(id_business,${m.key},ordinal), UNIQUE KEY uq_code(id_business,${m.key},code), CHECK (family='${m.listFamily}'), CHECK (REGEXP_LIKE(code,'^[!-~]+$','c')), CHECK (release_id IS NULL OR REGEXP_LIKE(release_id,'^[A-Za-z0-9][A-Za-z0-9._-]{0,49}$','c')),
        FOREIGN KEY(id_business,${m.key}) REFERENCES ${m.table}(id_business,${m.key}) ON DELETE RESTRICT ON UPDATE RESTRICT
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`]);
}
const statements=tables.map(([,sql])=>sql);
const parents=[['person','id_person'],['doctor_professional_profile','id_doctor_professional_profile']];
const parentIndexes=parents.map(([table,key])=>`ALTER TABLE ${table} ADD UNIQUE KEY uq_nc1_parent (id_business,${key})`);
const checksum=createHash('sha256').update([...parentIndexes,...statements].join('\n')).digest('hex');
async function applySteps(connection) {
    // A manifest after each successful DDL allows restart, but never adopts an unknown existing table.
    await connection.query('CREATE TABLE IF NOT EXISTS nc1_identity_steps (name VARCHAR(100) PRIMARY KEY, sha CHAR(64) NOT NULL, definition_sha CHAR(64) NOT NULL)');
    for(const [name,sql] of tables) {
        const hash=createHash('sha256').update(sql).digest('hex');
        const [done]=await connection.execute('SELECT sha,definition_sha FROM nc1_identity_steps WHERE name=?',[name]);
        const [exists]=await connection.execute('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?',[name]);
        if(done.length) {
            if(done[0].sha!==hash||!exists.length)throw new InstallationError('Deriva de migracion: '+name);
            const [[definition]]=await connection.query('SHOW CREATE TABLE '+name);
            const actual=createHash('sha256').update(definition['Create Table']).digest('hex');
            if(done[0].definition_sha!==actual)throw new InstallationError('Deriva de estructura: '+name);
            continue;
        }
        if(exists.length)throw new InstallationError('Tabla existente sin evidencia compatible: '+name);
        await connection.query(sql);
        const [[definition]]=await connection.query('SHOW CREATE TABLE '+name);
        const actual=createHash('sha256').update(definition['Create Table']).digest('hex');
        await connection.execute('INSERT INTO nc1_identity_steps VALUES (?,?,?)',[name,hash,actual]);
    }
}
async function apply(connection,{isolated=false,expectedDatabase,expectedChecksum,actor}={}) {
    const [[db]]=await connection.query('SELECT DATABASE() AS name');
    const qa=isolated && /^nc1_qa_[a-z0-9_]+$/.test(db.name||'');
    if(!qa && (!actor || !/^[A-Za-z0-9@._-]{1,100}$/.test(actor) || expectedDatabase!==db.name || expectedChecksum!==checksum))throw new InstallationError('Solo QA aislada nc1_qa_* o instalacion explicita con database/checksum/actor');
    const lockName="nc1_"+createHash("sha256").update(db.name).digest("hex").slice(0,48);
    const [[lock]]=await connection.execute("SELECT GET_LOCK(?,0) AS acquired",[lockName]);
    if(Number(lock.acquired)!==1)throw new InstallationError('NC1 migration already running');
    let run;
    try {
        // Validate both parents before performing any DDL. No data rewrite or orphan adoption.
        for(const [table,key] of parents) {
            const [cols]=await connection.execute('SELECT COLUMN_NAME name,COLUMN_TYPE type,COLLATION_NAME coll FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME IN (?,?)',[table,'id_business',key]);
            if(cols.length!==2 || cols.some(c=>c.type!=='varchar(50)' || c.coll!=='utf8mb4_unicode_ci'))throw new InstallationError('NC1 parent incompatible: '+table);
            const [[t]]=await connection.execute('SELECT ENGINE engine FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?',[table]);
            if(t.engine!=='InnoDB')throw new InstallationError('NC1 parent engine incompatible: '+table);
        }
        await connection.query('CREATE TABLE IF NOT EXISTS nc1_identity_audit (run_id CHAR(36) PRIMARY KEY,actor VARCHAR(100) NOT NULL,database_name VARCHAR(64) NOT NULL,ddl_sha CHAR(64) NOT NULL,state VARCHAR(16) NOT NULL,started_at DATETIME(3) NOT NULL,finished_at DATETIME(3) NULL)');
        run=require('node:crypto').randomUUID();
        await connection.execute("INSERT INTO nc1_identity_audit VALUES (?,?,?,?,'running',UTC_TIMESTAMP(3),NULL)",[run,actor||'isolated-qa',db.name,checksum]);
        for(const [index,[table,key]] of parents.entries()) {
            const [rows]=await connection.execute("SELECT COLUMN_NAME col,NON_UNIQUE non_unique,SUB_PART prefix_length FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND INDEX_NAME='uq_nc1_parent' ORDER BY SEQ_IN_INDEX",[table]);
            if(!rows.length)await connection.query(parentIndexes[index]);
            else if(rows.map(r=>r.col).join(',')!==['id_business',key].join(',')||rows.some(r=>Number(r.non_unique)!==0||r.prefix_length!==null))throw new InstallationError('NC1 parent index drift: '+table);
        }
        await applySteps(connection);
        await connection.execute("UPDATE nc1_identity_audit SET state='complete',finished_at=UTC_TIMESTAMP(3) WHERE run_id=?",[run]);
        return {runId:run,database:db.name,checksum};
    } catch(e) {
        if(run)await connection.execute("UPDATE nc1_identity_audit SET state='failed',finished_at=UTC_TIMESTAMP(3) WHERE run_id=?",[run]);
        throw e;
    } finally {await connection.execute("SELECT RELEASE_LOCK(?)",[lockName]);}
}
module.exports={tables,statements,refTypes,checksum,parentIndexes,apply};

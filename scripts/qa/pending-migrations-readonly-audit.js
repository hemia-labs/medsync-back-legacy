'use strict';
// Inventory only: never runs migration entry points, seed INSERTs, backfills,
// routine replacement or the historical dummy-appointment cleanup.
const fs = require('node:fs/promises');
const path = require('node:path');
const mysql = require('mysql2/promise');
const config = require('../../src/config/config');
const migrationRoot = path.resolve(__dirname, '../migrations');
const newTables = ['business_role_permission','treatment_plan_consent_version','treatment_plan_audit',
    'treatment_plan_consent_document','patient_allergy_events','tracing_revision'];
const addedColumns = {
    allergy: {review_status:'VARCHAR(30) NULL',revision:'INT UNSIGNED NOT NULL DEFAULT 0',reviewed_at:'DATETIME(3) NULL',reviewed_by:'VARCHAR(36) NULL'},
    clinical_histories: {revision:'INT UNSIGNED NOT NULL DEFAULT 0',responsible_snapshot_json:'LONGTEXT NULL',finalizer_snapshot_json:'LONGTEXT NULL'},
    tracing: {revision:'INT UNSIGNED NOT NULL DEFAULT 1',status:"VARCHAR(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'active'",
        updated_at:'DATETIME DEFAULT NULL',updated_by:'VARCHAR(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL',
        cancelled_at:'DATETIME DEFAULT NULL',cancelled_by:'VARCHAR(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL',cancellation_reason:'VARCHAR(1000) COLLATE utf8mb4_unicode_ci DEFAULT NULL'},
    appointment: {doctor_profile_id:'VARCHAR(50) COLLATE utf8mb4_unicode_ci NULL',doctor_name_snapshot:'VARCHAR(250) COLLATE utf8mb4_unicode_ci NULL'},
    appointment_config: {doctor_profile_id:'VARCHAR(50) COLLATE utf8mb4_unicode_ci NULL'}, prescription_config: {doctor_profile_id:'VARCHAR(50) COLLATE utf8mb4_unicode_ci NULL'}
};
const tableSources = {
    business_role_permission:'sql/business_role_permission.sql', treatment_plan_consent_version:'co8-treatment-plan-continuity.sql',
    treatment_plan_audit:'co8-treatment-plan-continuity.sql', treatment_plan_consent_document:'co9-treatment-consent-document.sql',
    patient_allergy_events:'apply-cd13-allergy-state.js', tracing_revision:'s16-tracing-safety.js'
};
const tableColumnCounts = [6,10,8,10,7,10];
const tableIndexCounts = [3,4,2,2,2,3];
const tableForeignKeyCounts = [3,1,1,2,0,1];
const addedIndexes = {
    appointment:[{name:'idx_appointment_doctor_date',unique:false,columns:'id_business,doctor_profile_id,active,appointment_date,start_time,end_time'}],
    appointment_config:[{name:'ux_appointment_config_doctor',unique:true,columns:'id_business,doctor_profile_id'}],
    prescription_config:[{name:'ux_prescription_config_doctor',unique:true,columns:'id_business,doctor_profile_id'}]
};
const routines = ['SP_appointment_config_get','SP_appointment_config_save','SP_appointment_get','SP_appointment_list','SP_appointment_save'];
const permissionCodes = ['tracing.create','tracing.correct','tracing.cancel','dashboard.operations','dashboard.clinical','dashboard.financial','dashboard.scope.all','clinical_history.intake'];
const normalize = sql => sql.replace(/CREATE\s+DEFINER\s*=\s*`[^`]+`@`[^`]+`\s+/i,'CREATE ').replace(/`/g,'').replace(/\s+/g,' ').replace(/;\s*$/,'').trim().toLowerCase();
const normalizedType = value => String(value).toLowerCase().replace(/\b(tinyint|smallint|mediumint|int|bigint)\(\d+\)/g,'$1').replace(/\s+/g,' ').trim();
const normalizedDefault = value => value == null || /^null$/i.test(String(value)) ? null
    : /^current_timestamp(?:\(\d*\))?$/i.test(String(value)) ? String(value).toUpperCase().replace(/\(\)$/,'')
    : String(value).replace(/^'(.*)'$/s,'$1');
function parseColumn(name, definition) {
    const type=definition.match(/^(?:varchar\(\d+\)|char\(\d+\)|longtext|datetime(?:\(\d+\))?|tinyint(?:\(\d+\))?|int(?:\(\d+\))?)(?:\s+unsigned)?/i);
    if(!type)throw new Error(`Unsupported expected column: ${name}`);
    return {name,type:normalizedType(type[0]),nullable:!(/\bNOT NULL\b|\bPRIMARY KEY\b/i.test(definition)),
        default:normalizedDefault((definition.match(/\bDEFAULT\s+('(?:[^']|'')*'|\S+)/i)||[])[1]),
        collation:(definition.match(/\bCOLLATE\s+(\w+)/i)||[])[1]||null,
        onUpdate:/\bON UPDATE\s+CURRENT_TIMESTAMP/i.test(definition)};
}
// These controlled migrations contain no commas in column definitions; split only
// outside parentheses so composite keys and datatype precision stay intact.
function splitDefinitions(body) {
    const result=[];let depth=0,start=0,quote=null;
    for(let i=0;i<body.length;i++){
        const char=body[i];
        if(quote){if(char===quote&&body[i-1]!=='\\')quote=null;continue;}
        if(char==="'"||char==='"'||char==='`'){quote=char;continue;}
        if(char==='(')depth++;else if(char===')')depth--;else if(char===','&&depth===0){result.push(body.slice(start,i).trim());start=i+1;}
    }
    result.push(body.slice(start).trim());return result;
}
async function tableExpectation(table) {
    const source=await fs.readFile(path.join(migrationRoot,tableSources[table]),'utf8');
    const match=source.match(new RegExp('CREATE TABLE(?: IF NOT EXISTS)? `?'+table+'`?\\s*\\(([\\s\\S]*?)\\) ENGINE=InnoDB','i'));
    if(!match)throw new Error(`Expected migration table not found: ${table}`);
    const columns=[],indexes=[],foreignKeys=[];
    for(const entry of splitDefinitions(match[1])){
        const index=entry.match(/^(PRIMARY KEY|UNIQUE KEY\s+`?(\w+)`?|KEY\s+`?(\w+)`?)\s*\(([^)]+)\)/i);
        const fk=entry.match(/^CONSTRAINT\s+`?(\w+)`?\s+FOREIGN KEY\s*\(`?(\w+)`?\)\s+REFERENCES\s+`?(\w+)`?\s*\(`?(\w+)`?\)/i);
        if(index)indexes.push({name:index[2]||index[3]||'PRIMARY',unique:/^PRIMARY|^UNIQUE/i.test(index[1]),columns:index[4].replace(/`|\s/g,'')});
        else if(fk)foreignKeys.push({name:fk[1],column:fk[2],table:fk[3],referencedColumn:fk[4]});
        else {
            const column=entry.match(/^`?(\w+)`?\s+([\s\S]+)$/);if(!column)throw new Error(`Unparsed migration definition: ${table}`);
            columns.push(parseColumn(column[1],column[2]));
            if(/\bPRIMARY KEY\b/i.test(column[2]))indexes.push({name:'PRIMARY',unique:true,columns:column[1]});
        }
    }
    const index=newTables.indexOf(table);
    if(columns.length!==tableColumnCounts[index]||indexes.length!==tableIndexCounts[index]||foreignKeys.length!==tableForeignKeyCounts[index])throw new Error(`Incomplete expected definitions: ${table}`);
    return {columns,indexes,foreignKeys};
}

(async()=>{
    const db = await mysql.createConnection({host:config.HOSTMYSQL,port:config.PORTMYSQL,user:config.USERMYSQL,password:config.PASSWORDMYSQL,database:config.DATABASEMYSQL});
    let stage='metadata';
    const query = async(sql,args=[])=>{
        if(!/^\s*(?:SELECT|SHOW)\b/i.test(sql)) throw new Error('Read-only audit rejected a mutation');
        try { const [rows] = await db.query(sql,args); return rows; }
        catch(error) { error.auditStage=stage; throw error; }
    };
    const report = { checkedAt:new Date().toISOString(), target:'configured backend database (credentials and host omitted)', readOnly:true, connections:1,
        tables:[],addedColumns:[],indexes:[],foreignKeys:[],routines:[],permissions:[],seeds:{},pending:[] };
    try {
        await db.query('SET SESSION TRANSACTION READ ONLY');
        await db.beginTransaction();
        for(const table of [...newTables,...Object.keys(addedColumns)]) {
            stage=`table:${table}`;
            const tableRows = await query('SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?',[table]);
            if(!tableRows.length){report.pending.push(`table:${table}`);continue;}
            const expected = newTables.includes(table) ? await tableExpectation(table)
                : {columns:Object.entries(addedColumns[table]).map(([name,definition])=>parseColumn(name,definition)),indexes:addedIndexes[table]||[],foreignKeys:[]};
            if(tableRows[0].ENGINE!=='InnoDB')report.pending.push(`engine:${table}:InnoDB`);
            const columns = await query('SELECT COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT,COLLATION_NAME,EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION',[table]);
            let matchingColumns=0;
            for(const column of expected.columns){
                const actual=columns.find(row=>row.COLUMN_NAME===column.name);
                const matches=!!actual&&normalizedType(actual.COLUMN_TYPE)===column.type&&(actual.IS_NULLABLE==='YES')===column.nullable
                    &&normalizedDefault(actual.COLUMN_DEFAULT)===column.default&&(!column.collation||actual.COLLATION_NAME===column.collation)
                    &&/on update current_timestamp/i.test(actual.EXTRA)===column.onUpdate;
                if(matches)matchingColumns++;else report.pending.push(`column-definition:${table}.${column.name}`);
                if(!newTables.includes(table))report.addedColumns.push({table,column:column.name,matches,...(actual||{missing:true})});
            }
            if(newTables.includes(table))report.tables.push({table,engine:tableRows[0].ENGINE,expectedColumns:expected.columns.length,matchingColumns});
            const indexes = await query('SELECT INDEX_NAME,NON_UNIQUE,GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) columns_list FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? GROUP BY INDEX_NAME,NON_UNIQUE',[table]);
            for(const index of expected.indexes){const actual=indexes.find(row=>row.INDEX_NAME===index.name);const matches=!!actual&&Boolean(!actual.NON_UNIQUE)===index.unique&&actual.columns_list===index.columns;report.indexes.push({table,...index,matches});if(!matches)report.pending.push(`index:${table}.${index.name}`);}
            if(table==='prescription_config'&&indexes.some(index=>index.INDEX_NAME==='ux_prescription_config_business'))report.pending.push('obsolete-index:prescription_config.ux_prescription_config_business');
            if(newTables.includes(table)){
                const constraints = await query('SELECT CONSTRAINT_NAME,COLUMN_NAME,REFERENCED_TABLE_NAME,REFERENCED_COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND REFERENCED_TABLE_NAME IS NOT NULL',[table]);
                for(const fk of expected.foreignKeys){
                    const matches=constraints.some(row=>row.CONSTRAINT_NAME===fk.name&&row.COLUMN_NAME===fk.column&&row.REFERENCED_TABLE_NAME===fk.table&&row.REFERENCED_COLUMN_NAME===fk.referencedColumn);
                    report.foreignKeys.push({table,name:fk.name,matches});if(!matches)report.pending.push(`foreign-key:${table}.${fk.name}`);
                }
            }
        }
        const trigger = await query("SELECT ACTION_TIMING,EVENT_MANIPULATION,EVENT_OBJECT_TABLE,ACTION_STATEMENT FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND TRIGGER_NAME='allergy_preserve_reviewed_state'");
        const triggerSource=await fs.readFile(path.join(migrationRoot,'apply-cd13-allergy-state.js'),'utf8');
        const triggerSql=(triggerSource.match(/const triggerSql = `([\s\S]*?)`;/)||[])[1];
        if(!triggerSql||!triggerSql.includes('SET NEW.'))throw new Error('Expected allergy trigger not found');
        const expectedAction=triggerSql.slice(triggerSql.indexOf('SET NEW.'));
        report.allergyTrigger={exists:!!trigger.length,matches:!!trigger.length&&trigger[0].ACTION_TIMING==='BEFORE'&&trigger[0].EVENT_MANIPULATION==='UPDATE'&&trigger[0].EVENT_OBJECT_TABLE==='allergy'&&normalize(trigger[0].ACTION_STATEMENT)===normalize(expectedAction)};
        if(!report.allergyTrigger.matches)report.pending.push('trigger:allergy_preserve_reviewed_state');
        for(const name of routines){
            stage=`procedure:${name}`;
            const exists=await query('SELECT ROUTINE_NAME FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=DATABASE() AND ROUTINE_NAME=? AND ROUTINE_TYPE=\'PROCEDURE\'',[name]);
            if(!exists.length){report.routines.push({name,exists:false});report.pending.push(`procedure:${name}`);continue;}
            const actual=(await query(`SHOW CREATE PROCEDURE ${name}`))[0]['Create Procedure'];
            const expected=await fs.readFile(path.join(migrationRoot,'sql',`${name}.sql`),'utf8');
            if(!expected.includes(`PROCEDURE \`${name}\``))throw new Error(`Expected procedure not found: ${name}`);
            const matches=normalize(actual)===normalize(expected);report.routines.push({name,matches});if(!matches)report.pending.push(`procedure-diff:${name}`);
        }
        for(const code of permissionCodes){
            stage=`permission:${code}`;
            const rows=await query('SELECT active,is_active FROM cat_permission WHERE code=?',[code]);
            report.permissions.push({code,count:rows.length,enabled:rows.length===1&&rows[0].active===1&&rows[0].is_active===1});
            if(rows.length!==1||rows[0].active!==1||rows[0].is_active!==1)report.pending.push(`permission:${code}`);
        }
        // Load only SQL constants; neither utility invokes queries at import time.
        const dashboard=require('../../src/util/dashboardAccess');
        const tracing=require('../../src/util/tracingPermissions');
        for(const [name,sql] of [['dashboard',dashboard.seedSql],['receptionSafety',dashboard.receptionSafetySql],['assistantTreatment',dashboard.assistantTreatmentSql],['tracing',tracing.seedSql]]){
            stage=`seed:${name}`;
            let select=sql.slice(sql.indexOf('SELECT DISTINCT')).replaceAll(':business',name==='tracing'?'l.id_business':'NULL').replaceAll(':login','NULL');
            const rows=await query(`SELECT COUNT(*) AS missing FROM (${select}) candidate LEFT JOIN business_role_permission installed
                ON installed.id_business COLLATE utf8mb4_unicode_ci=candidate.id_business COLLATE utf8mb4_unicode_ci
                AND installed.id_rol COLLATE utf8mb4_unicode_ci=candidate.id_rol COLLATE utf8mb4_unicode_ci
                AND installed.id_cat_permission COLLATE utf8mb4_unicode_ci=candidate.id_cat_permission COLLATE utf8mb4_unicode_ci
                WHERE installed.id_business IS NULL`);
            report.seeds[name]=Number(rows[0].missing);if(report.seeds[name])report.pending.push(`seed:${name}:${report.seeds[name]}`);
        }
        for(const [name,sql] of [
            ['professionalAgendas',`SELECT COUNT(*) n FROM doctor_professional_profile d JOIN login l ON l.id_login=d.id_login AND l.id_business=d.id_business
                WHERE d.is_active=1 AND l.active=1 AND NOT EXISTS(SELECT 1 FROM appointment_config c WHERE c.id_business=d.id_business AND c.doctor_profile_id=d.id_doctor_professional_profile)`],
            ['professionalPrescriptionConfigs',`SELECT COUNT(*) n FROM doctor_professional_profile d JOIN login l ON l.id_login=d.id_login AND l.id_business=d.id_business
                WHERE d.is_active=1 AND l.active=1 AND EXISTS(SELECT 1 FROM prescription_config c WHERE c.id_business COLLATE utf8mb4_unicode_ci=d.id_business COLLATE utf8mb4_unicode_ci AND c.doctor_profile_id IS NULL AND c.active=1)
                AND NOT EXISTS(SELECT 1 FROM prescription_config c WHERE c.id_business COLLATE utf8mb4_unicode_ci=d.id_business COLLATE utf8mb4_unicode_ci AND c.doctor_profile_id COLLATE utf8mb4_unicode_ci=d.id_doctor_professional_profile COLLATE utf8mb4_unicode_ci)`],
            ['legacyTracingMissingTenant',`SELECT COUNT(*) n FROM tracing t JOIN person p ON p.id_person=t.id_person WHERE t.id_business IS NULL AND p.id_business IS NOT NULL`],
            ['conflictingTracingTenant',`SELECT COUNT(*) n FROM tracing t JOIN person p ON p.id_person=t.id_person WHERE t.id_business IS NOT NULL AND p.id_business IS NOT NULL AND t.id_business<>p.id_business`]
        ]){stage=`data:${name}`;report.seeds[name]=Number((await query(sql))[0].n);if(report.seeds[name])report.pending.push(`data-review:${name}:${report.seeds[name]}`);}
        report.result=report.pending.length?'REVIEW_REQUIRED':'UP_TO_DATE';
        console.log(JSON.stringify(report,null,2));
        if(report.pending.length)process.exitCode=2;
    }finally{await db.rollback();await db.end();}
})().catch(error=>{console.error('Read-only migration audit failed:',error.auditStage||'connection',error.code||error.message);process.exitCode=1;});

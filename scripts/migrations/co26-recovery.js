'use strict';
// Compensating rollback: keep all revisions and signed documents; stop new
// structured writes. A schema downgrade is deliberately never destructive.
async function recover(db,business,expectedMode) {
    if(typeof business!=='string'||!/^[A-Za-z0-9_-]{1,50}$/.test(business))throw Error('INVALID_BUSINESS');
    if(!['v2','v2_readonly'].includes(expectedMode))throw Error('EXPECTED_MODE_REQUIRED');
    await db.beginTransaction();
    try {
        await db.query('SELECT id_person FROM person WHERE id_business=? ORDER BY id_person FOR UPDATE',[business]);
        const [rows]=await db.query('SELECT odontogram_mode FROM clinical_module_config WHERE id_business=? FOR UPDATE',[business]);
        if(rows.length!==1||rows[0].odontogram_mode!==expectedMode)throw Error('MODE_CHANGED');
        const [counts]=await db.query('SELECT COUNT(*) AS charts FROM odontogram_v2_chart WHERE id_business=?',[business]);
        await db.query("UPDATE clinical_module_config SET odontogram_mode='v2_readonly' WHERE id_business=?",[business]);
        await db.commit();
        return{mode:'v2_readonly',previous_mode:expectedMode,charts_retained:Number(counts[0].charts),destructive:false};
    }catch(error){await db.rollback();throw error;}
}
async function compensateEmpty(db,plan,permissions=[],options={}) {
    if(options.maintenance!==true)throw Error('STOP_ALL_WRITERS_BEFORE_COMPENSATION');
    const {ddl}=require('./co26-odontogram'),allowed=new Set(ddl.map(([table])=>table));
    if(!plan||!Array.isArray(plan.created_tables)||plan.created_tables.some(table=>!allowed.has(table))||typeof plan.mode_added!=='boolean')throw Error('INVALID_INSTALL_PLAN');
    const existing=new Set();
    // Check every clinical/configuration sidecar, not only tables in this run.
    for(const [table]of ddl){const [found]=await db.query('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?',[table]);if(!found.length)continue;existing.add(table);if(table!=='odontogram_v2_migration'){const [rows]=await db.query('SELECT COUNT(*) AS count FROM '+table);if(Number(rows[0].count))throw Error('CO26_DATA_PRESENT_USE_READONLY');}}
    const [columns]=await db.query('SHOW COLUMNS FROM clinical_module_config');
    if(columns.some(column=>column.Field==='odontogram_mode')){const [modes]=await db.query("SELECT id_business FROM clinical_module_config WHERE odontogram_mode<>'v1' LIMIT 1");if(modes.length)throw Error('CO26_MODE_IN_USE');}
    const removed=[],preserved=[];
    await db.beginTransaction();
    try {
        for(const previous of permissions){
            if(!previous||!/^PERM-CO26-(CAPTURE|FINALIZE|REOPEN|DELETE)$/.test(previous.id_cat_permission))throw Error('INVALID_PERMISSION_SNAPSHOT');
            const [rows]=await db.query('SELECT * FROM cat_permission WHERE id_cat_permission=? FOR UPDATE',[previous.id_cat_permission]);
            const stable=value=>JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(JSON.stringify(value))).sort(([a],[b])=>a.localeCompare(b))));
            if(!rows.length)continue;
            const [grants]=await db.query('SELECT id_cat_permission FROM permission_rol WHERE id_cat_permission=? UNION SELECT id_cat_permission FROM business_role_permission WHERE id_cat_permission=?',[previous.id_cat_permission,previous.id_cat_permission]);
            if(grants.length||stable(rows[0])!==stable(previous)){preserved.push(previous.id_cat_permission);continue;}
            await db.query('DELETE FROM cat_permission WHERE id_cat_permission=?',[previous.id_cat_permission]);
        }
        await db.commit();
    }catch(error){await db.rollback();throw error;}
    for(const [table]of [...ddl].reverse())if(plan.created_tables.includes(table)&&existing.has(table)){await db.query('DROP TABLE '+table);removed.push(table);}
    if(plan.mode_added&&columns.some(column=>column.Field==='odontogram_mode'))await db.query('ALTER TABLE clinical_module_config DROP COLUMN odontogram_mode');
    return{removed_tables:removed,preserved_admin_permissions:preserved,clinical_data_removed:false};
}
module.exports={recover,compensateEmpty};
if(require.main===module)(async()=>{
    const empty=process.argv.includes('--compensate-empty');
    if(!process.argv.includes('--configured')||!process.argv.includes('--readonly')&&!empty)throw Error('Use --configured --readonly --business ID --expected-mode v2, or --configured --compensate-empty --backup-dir PATH');
    const business=process.argv[process.argv.indexOf('--business')+1],mode=process.argv[process.argv.indexOf('--expected-mode')+1];
    const config=require('../../src/config/config');
    const db=await require('mysql2/promise').createConnection({host:config.HOSTMYSQL,port:config.PORTMYSQL,user:config.USERMYSQL,password:config.PASSWORDMYSQL,database:config.DATABASEMYSQL});
    try{
        if(empty){
            if(!process.argv.includes('--maintenance-confirmed'))throw Error('STOP_ALL_WRITERS_BEFORE_COMPENSATION');
            const fs=require('node:fs/promises'),path=require('node:path');
            const root=path.resolve(__dirname,'../../../_schema_backups'),directory=path.resolve(process.argv[process.argv.indexOf('--backup-dir')+1]||'');
            if(!directory.startsWith(root+path.sep))throw Error('BACKUP_DIRECTORY_REQUIRED');
            const read=async name=>JSON.parse(await fs.readFile(path.join(directory,name),'utf8'));
            const plan=await read('install-plan.json');let permissions=[];
            try{permissions=await read('permission-created.json');}catch(error){if(error.code!=='ENOENT')throw error;}
            console.log(JSON.stringify(await compensateEmpty(db,plan,permissions,{maintenance:true})));
        }else console.log(JSON.stringify(await recover(db,business,mode)));
    }finally{await db.end();}
})().catch(error=>{console.error('CO26 recovery:',error.code||error.message);process.exitCode=1;});

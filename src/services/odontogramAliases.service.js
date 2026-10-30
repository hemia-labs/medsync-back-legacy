'use strict';
const { QueryTypes }=require('sequelize');
const { randomUUID }=require('node:crypto');
const sequelize=require('../db/Sequelize.connection');
const D=require('../domain/odontogram/operations');
const {GLOBAL_ALIASES,RESERVED,normalizeAlias,validTarget}=require('../domain/odontogram/aliases');
const query=(sql,values,transaction)=>sequelize.query(sql,{replacements:values,transaction,logging:false,type:/^\s*SELECT/.test(sql)?QueryTypes.SELECT:QueryTypes.RAW});
async function state(business,transaction) {
    const global={...GLOBAL_ALIASES},local={},conflicts=[];
    let rows=[],ready=true;
    try { rows=await query('SELECT scope_key,scope_kind,id_business,alias,target,version,active FROM odontogram_alias WHERE scope_key IN (:global,:tenant) ORDER BY scope_key,alias',{global:'global',tenant:'tenant:'+business},transaction); }
    catch(error){if((error.original||error).code==='ER_NO_SUCH_TABLE')ready=false;else throw error;}
    for(const row of rows.filter(row=>row.scope_kind==='global'&&Number(row.active))) {
        if(RESERVED.has(row.alias)||!validTarget(row.target)){conflicts.push({alias:row.alias,scope:'global'});continue;}
        global[row.alias]=row.target;
    }
    const aliases={...global};
    for(const row of rows.filter(row=>row.scope_kind==='tenant'&&row.id_business===business&&Number(row.active))) {
        local[row.alias]=row.target;
        if(RESERVED.has(row.alias)||Object.prototype.hasOwnProperty.call(global,row.alias)||!validTarget(row.target)){conflicts.push({alias:row.alias,scope:'tenant'});continue;}
        aliases[row.alias]=row.target;
    }
    const alias_version=D.hash({catalog:D.CATALOG_VERSION,aliases,versions:rows.map(row=>[row.scope_key,row.alias,row.version,row.active])});
    return {schema_ready:ready,aliases,global_aliases:global,local_aliases:local,alias_version,conflicts};
}
async function save(business,actor,body) {
    const alias=normalizeAlias(body.alias),target=body.target;
    if(target!==null&&!validTarget(target))D.fail('Elige una acción o hallazgo del catálogo.');
    return sequelize.transaction(async transaction=>{
        await query("SELECT step FROM odontogram_v2_migration WHERE step='odontogram_alias' FOR UPDATE",{},transaction);
        const config=await query('SELECT id_business FROM clinical_module_config WHERE id_business COLLATE utf8mb4_unicode_ci=:business COLLATE utf8mb4_unicode_ci FOR UPDATE',{business},transaction);
        if(!config.length)D.fail('Primero guarda la configuración clínica del consultorio.',409);
        const before=await state(business,transaction);
        if(!before.schema_ready)D.fail('Falta instalar las abreviaturas configurables.',503);
        if(body.expected_version!==before.alias_version)D.fail('Las abreviaturas cambiaron; vuelve a consultarlas.',409);
        if(target!==null&&(RESERVED.has(alias)||Object.prototype.hasOwnProperty.call(before.global_aliases,alias)))D.fail('No se puede reemplazar una abreviatura global, código o comando reservado.');
        const key={scope:'tenant:'+business,alias};
        const rows=await query('SELECT * FROM odontogram_alias WHERE scope_key=:scope AND alias=:alias FOR UPDATE',key,transaction);
        if(target===null&&!rows.length)D.fail('La abreviatura local no existe.',404);
        if(rows.length&&Boolean(Number(rows[0].active))===(target!==null)&&rows[0].target===(target||rows[0].target))return before;
        const version=rows.length?rows[0].version+1:1;
        const values={...key,business,actor,target:target||(rows[0]&&rows[0].target),active:target===null?0:1,version};
        await query(`INSERT INTO odontogram_alias(scope_key,scope_kind,id_business,alias,target,version,active,updated_by,updated_at)
            VALUES(:scope,'tenant',:business,:alias,:target,:version,:active,:actor,NOW(3)) ON DUPLICATE KEY UPDATE target=VALUES(target),version=VALUES(version),active=VALUES(active),updated_by=VALUES(updated_by),updated_at=VALUES(updated_at)`,values,transaction);
        await query(`INSERT INTO odontogram_alias_event(id_event,scope_key,alias,version,actor,before_json,after_json,created_at)
            VALUES(:event,:scope,:alias,:version,:actor,:before,:after,NOW(3))`,{...values,event:randomUUID(),before:JSON.stringify(rows[0]||null),after:JSON.stringify({target,active:target!==null})},transaction);
        return state(business,transaction);
    });
}
async function saveGlobal(actor,body) {
    const alias=normalizeAlias(body.alias),target=body.target;
    if(RESERVED.has(alias)||Object.prototype.hasOwnProperty.call(GLOBAL_ALIASES,alias))D.fail('Los códigos y sinónimos base están protegidos.');
    if(target!==null&&!validTarget(target))D.fail('Acción global inválida.');
    return sequelize.transaction(async transaction=>{
        await query("SELECT step FROM odontogram_v2_migration WHERE step='odontogram_alias' FOR UPDATE",{},transaction);
        const before=await state(null,transaction);
        if(!before.schema_ready)D.fail('Falta instalar las abreviaturas.',503);
        if(before.alias_version!==body.expected_version)D.fail('Las abreviaturas globales cambiaron; vuelve a consultarlas.',409);
        const collisions=await query("SELECT alias FROM odontogram_alias WHERE scope_kind='tenant' AND alias=:alias AND active=1 LIMIT 1",{alias},transaction);
        if(target!==null&&collisions.length)D.fail('Esta abreviatura ya está en uso por un consultorio; elige otra para no cambiar su interpretación.',409);
        const rows=await query('SELECT * FROM odontogram_alias WHERE scope_key=:scope AND alias=:alias FOR UPDATE',{scope:'global',alias},transaction);
        if(target===null&&!rows.length)D.fail('La abreviatura global no existe.',404);
        if(rows.length&&Boolean(Number(rows[0].active))===(target!==null)&&rows[0].target===(target||rows[0].target))return before;
        const values={scope:'global',alias,target:target||(rows[0]&&rows[0].target),actor,version:rows.length?rows[0].version+1:1,active:target===null?0:1};
        await query(`INSERT INTO odontogram_alias(scope_key,scope_kind,id_business,alias,target,version,active,updated_by,updated_at)
            VALUES(:scope,'global',NULL,:alias,:target,:version,:active,:actor,NOW(3)) ON DUPLICATE KEY UPDATE target=VALUES(target),version=VALUES(version),active=VALUES(active),updated_by=VALUES(updated_by),updated_at=VALUES(updated_at)`,values,transaction);
        await query(`INSERT INTO odontogram_alias_event(id_event,scope_key,alias,version,actor,before_json,after_json,created_at)
            VALUES(:event,:scope,:alias,:version,:actor,:before,:after,NOW(3))`,{...values,event:randomUUID(),before:JSON.stringify(rows[0]||null),after:JSON.stringify({target,active:target!==null})},transaction);
        return state(null,transaction);
    });
}
module.exports={state,save,saveGlobal};

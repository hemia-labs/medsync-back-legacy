'use strict';
const { QueryTypes }=require('sequelize');
const { randomUUID }=require('node:crypto');
const sequelize=require('../db/Sequelize.connection');
const {sequence,toothNumber}=require('../domain/odontogram/dentalContract');
const D=require('../domain/odontogram/operations');
const defaults=()=>Object.fromEntries(['permanent','primary','mixed'].map(mode=>[mode,sequence(mode)]));
const query=(sql,values,transaction)=>sequelize.query(sql,{replacements:values,transaction,logging:false,type:/^\s*SELECT/.test(sql)?QueryTypes.SELECT:QueryTypes.RAW});
function validate(traversal) {
    if(!traversal||typeof traversal!=='object'||Array.isArray(traversal)||Object.keys(traversal).some(mode=>!['permanent','primary','mixed'].includes(mode)))D.fail('Recorrido inválido.');
    const normalized={};
    for(const mode of ['permanent','primary','mixed']){
        const expected=sequence(mode),value=traversal[mode];
        if(!Array.isArray(value))D.fail('Define las tres denticiones del recorrido.');
        let numbers;try{numbers=value.map(toothNumber);}catch(error){D.fail(error.message);}
        if(numbers.length!==expected.length||new Set(numbers).size!==expected.length||numbers.some(n=>!expected.includes(n)))D.fail('El recorrido debe contener exactamente una vez cada pieza de su dentición.');
        normalized[mode]=numbers;
    }
    return normalized;
}
async function state(business,transaction) {
    let rows;try{rows=await query('SELECT revision,traversal_json FROM odontogram_preference WHERE id_business=:business',{business},transaction);}
    catch(error){if((error.original||error).code==='ER_NO_SUCH_TABLE')return{schema_ready:false,revision:0,valid:true,traversal:defaults()};throw error;}
    if(!rows.length)return{schema_ready:true,revision:0,valid:true,traversal:defaults()};
    try{return{schema_ready:true,revision:rows[0].revision,valid:true,traversal:validate(JSON.parse(rows[0].traversal_json))};}
    catch(error){return{schema_ready:true,revision:rows[0].revision,valid:false,traversal:defaults()};}
}
async function save(business,actor,body) {
    return sequelize.transaction(async transaction=>{
        const config=await query('SELECT id_business FROM clinical_module_config WHERE id_business COLLATE utf8mb4_unicode_ci=:business COLLATE utf8mb4_unicode_ci FOR UPDATE',{business},transaction);
        if(!config.length)D.fail('Primero guarda la configuración clínica.',409);
        const before=await state(business,transaction);
        if(!before.schema_ready)D.fail('Falta instalar los recorridos configurables.',503);
        if(body.expected_revision!==before.revision)D.fail('El recorrido cambió; vuelve a consultarlo.',409);
        const traversal=validate(body.traversal);
        if(before.valid&&D.canonical(traversal)===D.canonical(before.traversal))return before;
        const values={business,actor,revision:before.revision+1,json:JSON.stringify(traversal)};
        await query(`INSERT INTO odontogram_preference(id_business,revision,traversal_json,updated_by,updated_at) VALUES(:business,:revision,:json,:actor,NOW(3))
            ON DUPLICATE KEY UPDATE revision=VALUES(revision),traversal_json=VALUES(traversal_json),updated_by=VALUES(updated_by),updated_at=VALUES(updated_at)`,values,transaction);
        await query(`INSERT INTO odontogram_preference_event(id_event,id_business,revision,actor,before_json,after_json,created_at)
            VALUES(:event,:business,:revision,:actor,:before,:after,NOW(3))`,{...values,event:randomUUID(),before:JSON.stringify(before),after:values.json},transaction);
        return{schema_ready:true,revision:values.revision,valid:true,traversal};
    });
}
module.exports={defaults,validate,state,save};

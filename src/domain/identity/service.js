'use strict';
const C=require('./contract');
const S=require('./storage');
const {randomUUID,createHash}=require('node:crypto');
const hash = body => createHash('sha256').update(JSON.stringify([body.person,body.address||{},body.identity])).digest('hex');
function createService(db) {
    const query=(sql,replacements,transaction)=>db.query(sql,{replacements,transaction,type:'SELECT'});
    async function parent(kind,id,business,transaction,lock=false) {
        if(typeof id!=='string'||!id.length||id.length>50||!business)C.fail('id');
        const m=S.models[kind];
        const table=kind==='patient'?'person':kind==='professional'?'doctor_professional_profile':'care_establishment';
        const rows=await query(`SELECT * FROM ${table} WHERE ${m.key}=:id AND id_business=:business${lock?' FOR UPDATE':''}`,{id,business},transaction);
        if(!rows.length)C.fail('id','IDENTITY_NOT_FOUND',404);
        return rows[0];
    }
    async function read(kind,id,business,transaction) {
        const p=await parent(kind,id,business,transaction),m=S.models[kind];
        const [row]=await query(`SELECT * FROM ${m.table} WHERE ${m.key}=:id AND id_business=:business`,{id,business},transaction);
        const list=row&&m.list?await query(`SELECT * FROM ${m.listTable} WHERE ${m.key}=:id AND id_business=:business ORDER BY ordinal`,{id,business},transaction):[];
        return row?{data:S.decode(kind,row,list),revision:Number(row.revision),updatedAt:row.updated_at,row}:
            {data:kind==='patient'?C.legacy(p):{givenNames:null,firstSurname:null,secondSurname:null,firstSurnameStatus:'unknown',secondSurnameStatus:'unknown',legacyProfessionalName:p.professional_name||null},revision:0,updatedAt:null};
    }
    async function persist(kind,id,business,actor,data,revision,transaction,requestHash=null) {
        const m=S.models[kind],values={...S.encode(kind,data),id_business:business,[m.key]:id,revision:revision+1,updated_by:actor,request_hash:requestHash};
        if(!actor||!transaction)throw new Error('Identity writes require actor and transaction');
        const keys=Object.keys(values);
        if(!revision)await db.query(`INSERT INTO ${m.table} (${keys.join(',')},updated_at) VALUES (${keys.map(k=>':'+k).join(',')},UTC_TIMESTAMP(3))`,{replacements:values,transaction});
        else await db.query(`UPDATE ${m.table} SET ${keys.filter(k=>!['id_business',m.key].includes(k)).map(k=>k+'=:'+k).join(',')},updated_at=UTC_TIMESTAMP(3) WHERE id_business=:id_business AND ${m.key}=:${m.key}`,{replacements:values,transaction});
        if(m.list) {
            await db.query(`DELETE FROM ${m.listTable} WHERE id_business=:business AND ${m.key}=:id`,{replacements:{business,id},transaction});
            for(const [ordinal,r] of (data[m.list]||[]).entries())await db.query(`INSERT INTO ${m.listTable} (id_business,${m.key},ordinal,family,release_id,code) VALUES (:business,:id,:ordinal,:family,:release,:code)`,{replacements:{business,id,ordinal,family:r.family,release:r.releaseId||null,code:r.code},transaction});
        }
    }
    async function patientWrite(body,id,transaction,creating=false) {
        body = require('./legacyDate').normalizePatient(body);
        const existingPerson=await parent('patient',id,body.id_business,transaction,true);
        const cur=creating?{data:C.legacy(body.person),revision:0,row:null}:await read('patient',id,body.id_business,transaction);
        const legacyChanged=existingPerson.name!==body.person.name || existingPerson.surname!==body.person.surname || C.legacy(existingPerson).birthDate!==body.person.birthday;
        const changing=body.identity!==undefined || legacyChanged;
        if(!creating && changing && (cur.revision || body.identity!==undefined) && (!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision!==cur.revision))C.fail('expectedRevision','IDENTITY_CONFLICT',409);
        let data=C.validate('patient',body.identity||{},cur.data,{creating});
        if(body.identity) {
            if('givenNames' in body.identity && data.givenNames!==body.person.name)C.fail('givenNames','IDENTITY_LEGACY_CONFLICT');
            if('birthDate' in body.identity && data.birthDate!==body.person.birthday)C.fail('birthDate','IDENTITY_LEGACY_CONFLICT');
            if('firstSurname' in body.identity||'secondSurname' in body.identity) {
                const joined=[data.firstSurname,data.secondSurname].filter(Boolean).join(' ');
                if(joined && joined!==body.person.surname)C.fail('firstSurname','IDENTITY_LEGACY_CONFLICT');
            }
        } else if(!creating && cur.revision && legacyChanged) {
            // Legacy editing preserves raw text, but cannot claim the old split is still confirmed.
            data={...data,firstSurname:null,secondSurname:null,firstSurnameStatus:'unknown',secondSurnameStatus:'unknown'};
        }
        data.givenNames=body.person.name;data.birthDate=body.person.birthday;
        data.legacySurname=cur.data.legacySurname||body.person.surname;
        if(creating||body.identity!==undefined||(cur.revision&&legacyChanged))await persist('patient',id,body.id_business,body.id_login,data,cur.revision,transaction,creating?hash(body):cur.row&&cur.row.request_hash);
    }
    async function save(kind,id,business,actor,patch,expectedRevision,canManage=false) {
        return db.transaction(async transaction=>{
            const creating=kind==='establishment'&&!id;
            if(creating) {await query('SELECT id_business FROM business WHERE id_business=:business FOR UPDATE',{business},transaction);id=randomUUID();}
            else await parent(kind,id,business,transaction,true);
            const cur=creating?{data:{active:true},revision:0}:await read(kind,id,business,transaction);
            if(!Number.isSafeInteger(expectedRevision)||expectedRevision!==cur.revision)C.fail('expectedRevision','IDENTITY_CONFLICT',409);
            if(kind==='professional'&&'authorizedPersonnelTypes' in patch&&!canManage)C.fail('authorizedPersonnelTypes','IDENTITY_FORBIDDEN',403);
            const data=C.validate(kind,patch,cur.data);
            await persist(kind,id,business,actor,data,cur.revision,transaction);
            if(kind==='patient') {
                const surname=[data.firstSurname,data.secondSurname].filter(Boolean).join(' ');
                await db.query('UPDATE person SET name=COALESCE(:name,name), surname=COALESCE(:surname,surname), birthday=:birthday,age=IF(:birthday IS NULL,NULL,TIMESTAMPDIFF(YEAR,:birthday,CURDATE())), updated_at=UTC_TIMESTAMP(),updated_by=:actor WHERE id_person=:id AND id_business=:business',{replacements:{name:data.givenNames,surname:surname||null,birthday:data.birthDate,actor,id,business},transaction});
            }
            if(kind==='professional' && data.givenNames && (data.firstSurnameStatus!=='unknown'&&data.secondSurnameStatus!=='unknown')) {
                const name=[data.givenNames,data.firstSurname,data.secondSurname].filter(Boolean).join(' ');
                if(name.length>250)C.fail('givenNames');
                await db.query('UPDATE doctor_professional_profile SET professional_name=:name,updated_at=UTC_TIMESTAMP(),updated_by=:actor WHERE id_doctor_professional_profile=:id AND id_business=:business',{replacements:{name,actor,id,business},transaction});
            }
            return {id,...C.view(data,cur.revision+1)};
        });
    }
    return {read,save,patientWrite,view:C.view};
}
module.exports={createService,hash};

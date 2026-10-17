'use strict';

// Creates one isolated presentation tenant. No reset, external deliveries or
// changes to existing accounts. Default execution rolls the full fixture back.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const mysql = require('mysql2/promise');
const { injectReplacements } = require('sequelize/lib/utils/sql');
const config = require('../../src/config/config');
const security = require('../../src/config/security');
const { encript, compare } = require('../../src/util/bcrypt');
const apply = process.argv.includes('--apply');
const dialect = { name: 'mysql', TICK_CHAR_LEFT: '`', TICK_CHAR_RIGHT: '`', canBackslashEscape: () => true, supports: {} };
const id = key => {
    const hex = crypto.createHash('sha256').update(`medsync-alameda-showcase-v1:${key}`).digest('hex');
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
};
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
function dateOffset(days) { const date = new Date(`${today}T12:00:00Z`); date.setUTCDate(date.getUTCDate()+days); return date.toISOString().slice(0,10); }
const business = { id: id('business'), name: 'Consultorio Dental Alameda', slug: 'consultorio-dental-alameda', email: 'contacto@alameda.example', address: 'Consultorio 204, Centro Médico Alameda' };
const doctor = { id_login: id('doctor'), id_doctor_professional_profile: id('profile'), name: 'Dra. Valeria Mendoza', email: 'valeria.mendoza@alameda.example', telephone:'0000001001' };
const assistant = { id_login: id('assistant'), name: 'Sofía Herrera', email: 'sofia.herrera@alameda.example', telephone:'0000001002' };
const credentialFile = path.resolve(__dirname, '../../.alameda-access.local');
const names = [
    ['Mariana','Torres Medina',32,'F','Arquitecta'], ['Carlos','Hernández Soto',45,'M','Ingeniero'],
    ['Lucía','Navarro Ríos',27,'F','Diseñadora'], ['Diego','Ramírez Luna',38,'M','Contador'],
    ['Renata','Vega Salas',24,'F','Estudiante'], ['Jorge','López Herrera',52,'M','Comerciante'],
    ['Elena','Castillo Peña',41,'F','Docente'], ['Miguel','Morales Díaz',35,'M','Administrativo'],
    ['Paola','García Rivas',29,'F','Abogada'], ['Andrés','Fuentes Solís',47,'M','Ingeniero'],
    ['Natalia','Suárez Campos',22,'F','Estudiante'], ['Héctor','Paredes Silva',56,'M','Contador'],
    ['Camila','Ortega León',31,'F','Diseñadora'], ['Emilio','Cortés Bravo',43,'M','Comerciante'],
    ['Fernanda','Reyes Molina',36,'F','Docente'], ['Ricardo','Santos Aguilar',61,'M','Jubilado'],
    ['Daniela','Barrera Cano',26,'F','Administrativa'], ['Arturo','Núñez Rocha',49,'M','Arquitecto']
];
const ages = names.map((row, index) => {
    const birthday = `${Number(today.slice(0,4))-row[2]}-02-${String(index+1).padStart(2,'0')}`;
    return { id:id(`patient-${index}`), name:row[0], surname:row[1], age:row[2], sex:row[3], occupation:row[4], birthday, index };
});
const ok = (result, label) => { assert.equal(result.status,200,`${label}: ${result.message}`); return result.data; };

async function main() {
    assert.ok(!security.isProductionLike() && process.env.NODE_ENV !== 'production', 'Presentation data is restricted to the development/pilot environment');
    if (apply) assert.ok(!fs.existsSync(credentialFile), 'Existing access file found; inspect the existing demo instead of replacing it');
    const connection = await mysql.createConnection({host:config.HOSTMYSQL,port:config.PORTMYSQL,user:config.USERMYSQL,password:config.PASSWORDMYSQL,database:config.DATABASEMYSQL});
    let inTransaction=false, committed=false, commitAttempted=false, accessFileCreated=false, serial=0, stage='preflight';
    const password = `Alameda!${crypto.randomBytes(12).toString('base64url')}7`;
    const assistantPassword = `Alameda!${crypto.randomBytes(12).toString('base64url')}9`;
    const db = {
        async transaction() {
            const name=`alameda_${++serial}`; await connection.query(`SAVEPOINT ${name}`);
            return {finished:false,async commit(){await connection.query(`RELEASE SAVEPOINT ${name}`);this.finished=true;},async rollback(){await connection.query(`ROLLBACK TO SAVEPOINT ${name}`);await connection.query(`RELEASE SAVEPOINT ${name}`);this.finished=true;}};
        },
        async query(sql, options={}) {
            assert.doesNotMatch(sql,/\b(?:DROP|TRUNCATE|ALTER|CREATE\s+TABLE)\b/i,'No schema mutations in the presentation seed');
            const [rows]=await connection.query(injectReplacements(sql,dialect,options.replacements));
            if(/^\s*CALL\b/i.test(sql))return rows[0];
            return Array.isArray(rows)?rows:[rows.affectedRows];
        }
    };
    const dbId=require.resolve('../../src/db/Sequelize.connection');
    require.cache[dbId]={id:dbId,filename:dbId,loaded:true,exports:db};
    const emailId=require.resolve('../../src/services/email/email.service');
    require.cache[emailId]={id:emailId,filename:emailId,loaded:true,exports:new Proxy({},{get:()=>async()=>{throw Error('External deliveries are disabled in presentation seed');}})};
    try {
        const [existing]=await connection.query('SELECT id_business FROM business WHERE id_business=? OR slug=?',[business.id,business.slug]);
        assert.equal(existing.length,0,'The presentation tenant already exists; no data was overwritten');
        const tables=['business','login','doctor_professional_profile','business_role_permission','appointment_config','appointment_working_day','appointment_time_range','clinical_module_config','ui_theme_configuration','person','patient_extra_info','allergy','patient_allergy_events','clinical_history_templates','clinical_history_template_versions','clinical_history_template_events','clinical_histories','clinical_history_events','prescription_config','prescription','prescription_item','prescription_audit_log','prescription_folio_counter','document_templates','document_template_versions','patient_documents','patient_document_events','patient_document_signatures','document_signature_requests','treatment_plan','patient_treatment','patient_treatment_tooth','treatment_plan_audit','tracing','tracing_revision','appointment'];
        const [engines]=await connection.query('SELECT TABLE_NAME,ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (?)',[tables]);
        assert.equal(engines.length,tables.length,'All presentation tables must exist');
        assert.ok(engines.every(table=>table.ENGINE==='InnoDB'),'All fixture writes must be transactional');
        for(const procedure of ['SP_appointment_config_get','SP_appointment_config_save','SP_appointment_get','SP_appointment_list']) {
            const [rows]=await connection.query(`SHOW CREATE PROCEDURE ${procedure}`);
            assert.doesNotMatch(rows[0]['Create Procedure'],/\b(?:COMMIT|ROLLBACK|START\s+TRANSACTION)\b/i,'Procedure must not escape the fixture transaction');
        }
        await connection.beginTransaction();inTransaction=true;
        stage='tenant';
        const setup=await require('./professional-tenant-setup').setupTenant({connection,business,doctor,assistant,today,passwordHash:await encript(password),assistantPasswordHash:await encript(assistantPassword)});
        Object.assign(doctor,setup.doctor);
        console.log('Prepared isolated Professional account and permissions.');
        stage='patients';
        const createdDays=[-55,-52,-48,-46,-42,-40,-38,-37,-36,-8,-7,-6,-5,-4,-3,-2,-1,0];
        for(const patient of ages) {
            const created=`${dateOffset(createdDays[patient.index])} 08:30:00`;
            await connection.query(`INSERT INTO person (id_person,id_business,code,name,surname,birthday,age,ocupation,telephone,active,created_at,created_by,updated_at,updated_by) VALUES (?,?,?,?,?,?,?,?,NULL,1,?,?,?,?)`,[patient.id,business.id,`ALA${String(patient.index+1).padStart(3,'0')}`,patient.name,patient.surname,patient.birthday,patient.age,patient.occupation,created,doctor.id_login,created,doctor.id_login]);
            await connection.query(`INSERT INTO patient_extra_info (id_patient_extra_info,id_business,id_person,email,sex,address_state,address_city,active,created_at,created_by) VALUES (?,?,?,NULL,?,'Jalisco','Guadalajara',1,?,?)`,[id(`extra-${patient.index}`),business.id,patient.id,patient.sex,created,doctor.id_login]);
        }
        stage='clinical';
        const clinical=await require('./professional-clinical-data').seedClinical({connection,business,doctor,patients:ages,today,dateOffset});
        console.log('Prepared clinical scenarios through application services.');
        stage='appointments';
        let appointments=0;
        const slots=['09:00','10:00','11:00','12:00','16:00','17:00'];
        const titles=['Revisión y limpieza dental','Control de restauración','Valoración inicial','Control periodontal','Ajuste de guarda oclusal','Seguimiento de tratamiento'];
        const scheduledSlots=new Set();
        const schedule=async(patient,date,start,status,title,tracing=null)=>{
            const endMinutes=Number(start.slice(0,2))*60+Number(start.slice(3))+30;
            const end=`${String(Math.floor(endMinutes/60)).padStart(2,'0')}:${String(endMinutes%60).padStart(2,'0')}`;
            const created= date < today ? `${date} 08:00:00` : `${dateOffset(-2)} 10:00:00`;
            await connection.query(`INSERT INTO appointment (id_appointment,id_business,doctor_profile_id,doctor_name_snapshot,id_person,patient_name,contact_phone,id_tracing,appointment_date,start_time,end_time,status,title,description,source,cancellation_reason,blocks_availability,active,created_at,created_by,updated_at,updated_by) VALUES (?,?,?,?,?,?,NULL,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?)`,[
                id(`appointment-${appointments++}`),business.id,doctor.id_doctor_professional_profile,doctor.name,patient.id,`${patient.name} ${patient.surname}`,tracing,date,`${start}:00`,`${end}:00`,status,title,
                tracing?'Control indicado durante la consulta anterior.':'Acudir diez minutos antes de su cita.',tracing?'follow_up':'manual',status==='cancelled'?'El paciente solicitó cambiar de fecha.':null,
                ['confirmed','pending_confirmation','completed'].includes(status)?1:0,created,doctor.id_login,created,doctor.id_login]);
            scheduledSlots.add(`${date}/${start}`);
        };
        // History on working days plus a full current/next week. New patients do
        // not appear in a visit predating their registration.
        for(let offset=-40;offset<=14;offset++) {
            const date=dateOffset(offset),day=new Date(`${date}T12:00:00Z`).getUTCDay();
            if(day===0)continue;
            const available=ages.filter(patient=>createdDays[patient.index]<=offset);
            const number=offset< -7?2:offset===0?6:3;
            for(let j=0;j<Math.min(number,day===6?3:6);j++) {
                const patient=available[(Math.abs(offset)*3+j)%available.length];
                const status=offset<0?(j===1 && offset%9===0?'no_show':j===0 && offset%11===0?'cancelled':'completed')
                    :offset===0?(j<3?'completed':j===3?'confirmed':'pending_confirmation'):(j===0?'pending_confirmation':'confirmed');
                await schedule(patient,date,slots[j],status,titles[(Math.abs(offset)+j)%titles.length]);
            }
        }
        let linkedAppointments=0;
        for(const followup of (clinical.followups||[]).filter(item=>item.shouldSchedule&&item.date>=today).slice(0,3)) {
            const day=new Date(`${followup.date}T12:00:00Z`).getUTCDay();
            if(day===0||day===6)continue;
            const start=['16:00','17:00','18:00','18:30'].find(value=>!scheduledSlots.has(`${followup.date}/${value}`));
            if(!start)continue;
            await schedule(ages.find(patient=>patient.id===followup.patientId),followup.date,start,'confirmed',followup.title,followup.id_tracing);
            linkedAppointments++;
        }
        stage='validation';
        const ctx={id_business:business.id,id_login:doctor.id_login};
        const agenda=require('../../src/Dao/mysql/appointment.Dao');
        const settings=ok(await agenda.getConfig({...ctx,doctor_profile_id:doctor.id_doctor_professional_profile}),'Doctor agenda');
        assert.ok(settings.enabled&&settings.businessEnabled,'Doctor agenda and clinic switch enabled');
        const agendaRows=ok(await agenda.list({...ctx,date_from:today,date_to:dateOffset(7),doctor_profile_id:doctor.id_doctor_professional_profile}),'Agenda list');
        assert.ok(agendaRows.length>=15,'Visible populated weekly agenda');
        const TreatmentPlan=require('../../src/Dao/mysql/treatmentPlan.dao');
        const signing=ok(await new TreatmentPlan().signingDoctors({...ctx,id_person:ages[0].id}),'Treatment signature context');
        assert.equal(signing.template.template_type,'TREATMENT_PLAN_CONSENT','Treatment signing has a usable template');
        const home=ok(await require('../../src/Dao/mysql/homeContinuity.dao').summary(business.id,doctor.id_login,{scope:'tenant'}),'Home');
        const dashboardDao=require('../../src/Dao/mysql/businessDashboard.dao');
        const dashboard=ok(await dashboardDao.summary(business.id,{scope:'tenant'},{actorLoginId:doctor.id_login}),'Dashboard');
        ok(await dashboardDao.trends(business.id,{scope:'tenant'},{actorLoginId:doctor.id_login}),'Trends');
        ok(await dashboardDao.operationalSummary(business.id,{scope:'tenant'},{actorLoginId:doctor.id_login}),'Operational dashboard');
        assert.ok(dashboard.activity.prescriptionsIssued>0&&dashboard.activity.clinicalHistoriesFinalized>0&&dashboard.activity.appointmentsCreated>0,'Clinical and operational KPI have content');
        const [accounts]=await connection.query('SELECT password FROM login WHERE id_login=? AND id_business=?',[doctor.id_login,business.id]);
        assert.ok(await compare(password,accounts[0].password),'Generated credential matches stored hash');
        const [overlaps]=await connection.query(`SELECT COUNT(*) n FROM appointment a JOIN appointment b ON a.id_business=b.id_business AND a.doctor_profile_id=b.doctor_profile_id AND a.appointment_date=b.appointment_date AND a.id_appointment<b.id_appointment AND a.start_time<b.end_time AND b.start_time<a.end_time WHERE a.id_business=? AND a.blocks_availability=1 AND b.blocks_availability=1`,[business.id]);
        assert.equal(Number(overlaps[0].n),0,'Demo agenda has no overlaps');
        const summary={mode:apply?'created':'dry-run-rolled-back',businessId:business.id,clinic:business.name,login:doctor.telephone,referenceDate:today,patients:ages.length,appointments,linkedAppointments,clinical:clinical.counts,weeklyAgendaRows:agendaRows.length,kpis:dashboard.activity,homeSections:Object.keys(home.sections||{}),externalMessages:0};
        if(apply) {
            // Write access locally before commit so a file failure rolls the DB
            // back; never print the password or put it in a versioned document.
            fs.writeFileSync(credentialFile,JSON.stringify({url:'http://localhost:4324/auth/login',clinic:business.name,businessId:business.id,doctor:{name:doctor.name,email:doctor.email,telephone:doctor.telephone,password},assistant:{name:assistant.name,email:assistant.email,telephone:assistant.telephone,password:assistantPassword},referenceDate:today,fictional:true},null,2),{flag:'wx',mode:0o600});
            accessFileCreated=true;
            commitAttempted=true;
            await connection.commit();inTransaction=false;committed=true;
            summary.accessFile=credentialFile;
        } else {
            await connection.rollback();inTransaction=false;
            const [remaining]=await connection.query('SELECT COUNT(*) n FROM business WHERE id_business=?',[business.id]);
            assert.equal(Number(remaining[0].n),0,'Dry run must not leave the presentation account behind');
        }
        console.log(JSON.stringify(summary,null,2));
    } catch(error) {
        if(inTransaction)await connection.rollback();
        if(accessFileCreated&&!commitAttempted)fs.unlinkSync(credentialFile);
        console.error(JSON.stringify({stage,rolledBack:!commitAttempted,commitOutcome:committed?'confirmed':commitAttempted?'verify-before-retrying':'not-attempted',error:error.code||error.message,...(error.code==='ERR_ASSERTION'?{detail:error.message}:{} )}));process.exitCode=1;
    } finally {await connection.end();}
}
main().catch(error=>{console.error('Presentation seed failed:',error.code||error.message);process.exitCode=1;});

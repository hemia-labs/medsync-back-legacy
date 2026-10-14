const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const config = require('../../src/config/config');
const { v4: uuid } = require('uuid');

(async () => {
    const connection = await mysql.createConnection({ host:config.HOSTMYSQL,port:config.PORTMYSQL,user:config.USERMYSQL,password:config.PASSWORDMYSQL,database:config.DATABASEMYSQL });
    let serial = 0;
    const connectionPath = require.resolve('../../src/db/Sequelize.connection');
    const db = {
        async transaction() { const name=`co11_${++serial}`;await connection.query(`SAVEPOINT ${name}`);return { async commit(){await connection.query(`RELEASE SAVEPOINT ${name}`);},async rollback(){await connection.query(`ROLLBACK TO SAVEPOINT ${name}`);await connection.query(`RELEASE SAVEPOINT ${name}`);} }; },
        async query(sql, options = {}) {
            const args=[];const query=sql.replace(/:([A-Za-z_]\w*)/g,(_,key)=>{assert.ok(Object.hasOwn(options.replacements || {},key),`Missing replacement ${key}`);args.push(options.replacements[key]);return '?';});
            const [rows]=await connection.query(query,args);
            if(/^CALL /i.test(sql))return rows[0];
            if(Array.isArray(rows))return rows;
            return [rows.affectedRows];
        }
    };
    require.cache[connectionPath]={id:connectionPath,filename:connectionPath,loaded:true,exports:db};
    try {
        await connection.beginTransaction();
        const [tenant]=await connection.query('SELECT id_business FROM person WHERE id_person = ?', ['QAC_PATIENT_01']);
        assert.equal(tenant.length,1);
        const business=tenant[0].id_business;
        const [doctors]=await connection.query('SELECT d.* FROM doctor_professional_profile d JOIN login l ON l.id_login=d.id_login AND l.id_business=d.id_business WHERE d.id_business=? AND d.is_active=1 AND l.active=1 ORDER BY d.professional_name',[business]);
        assert.ok(doctors.length>=2);
        const [actors]=await connection.query("SELECT l.id_login FROM login l JOIN rol r ON r.id_rol=l.id_rol WHERE l.id_business=? AND r.code IN ('admin','business_admin') AND l.active=1 LIMIT 1",[business]);
        const body={id_business:business,id_login:actors[0].id_login};
        const agenda=require('../../src/Dao/mysql/appointment.Dao');
        const rx=require('../../src/Dao/mysql/prescription.dao');
        const base=await agenda.getConfig({...body,doctor_profile_id:'business'});
        assert.equal(base.status,200,base.message);
        assert.equal(base.data.doctorProfileId,'business','General config must not read a professional config');
        base.data.enabled=true;base.data.blockedDates=[];base.data.blockedHours=[];
        const baseSave = await agenda.saveConfig({...body,config:base.data}); assert.equal(baseSave.status,200,baseSave.message);
        for(const doctor of doctors.slice(0,2)) {
            const current=await agenda.getConfig({...body,doctor_profile_id:doctor.id_doctor_professional_profile});
            assert.equal(current.status,200,current.message);
            assert.equal(current.data.doctorProfileId,doctor.id_doctor_professional_profile,'Read must match selected doctor');
            Object.assign(current.data,{enabled:true,blockedDates:[],blockedHours:[],workingDays:Array.from({length:7},(_,dayOfWeek)=>({dayOfWeek,enabled:true,timeRanges:[{startTime:'09:00',endTime:'14:00'}]}))});
            const agendaSave = await agenda.saveConfig({...body,config:current.data}); assert.equal(agendaSave.status,200,agendaSave.message);
        }
        const a={doctorProfileId:doctors[0].id_doctor_professional_profile,patientId:'QAC_PATIENT_01',date:'2030-01-07',startTime:'09:00',endTime:'09:30',status:'confirmed',title:'QA CO11 rollback'};
        const first=await agenda.save({...body,appointment:a});assert.equal(first.status,200,first.message);
        const second=await agenda.save({...body,appointment:{...a,doctorProfileId:doctors[1].id_doctor_professional_profile}});assert.equal(second.status,200,second.message);
        assert.equal((await agenda.save({...body,appointment:a})).status === 200,false,'Same doctor must conflict');
        assert.equal((await agenda.save({...body,appointment:{...a,startTime:'08:00',endTime:'08:30'}})).status === 200,false);
        assert.equal((await agenda.save({...body,appointment:{...a,doctorProfileId:uuid()}})).status,403);
        const [foreignDoctors]=await connection.query('SELECT id_doctor_professional_profile FROM doctor_professional_profile WHERE id_business <> ? AND is_active = 1 LIMIT 1',[business]);
        assert.ok(foreignDoctors.length);
        const foreignProfile=foreignDoctors[0].id_doctor_professional_profile;
        assert.equal((await agenda.getConfig({...body,doctor_profile_id:foreignProfile})).status,403);
        assert.equal((await agenda.save({...body,appointment:{...a,doctorProfileId:foreignProfile}})).status,403);
        assert.equal((await rx.getConfig(business,foreignProfile,body.id_login)).status,403);
        const [foreignPatients]=await connection.query("SELECT id_person FROM person WHERE id_business <> ? AND id_person LIKE 'QA%' AND active = 1 LIMIT 1",[business]);
        assert.ok(foreignPatients.length);
        assert.equal((await agenda.save({...body,appointment:{...a,patientId:foreignPatients[0].id_person,startTime:'10:00',endTime:'10:30'}})).status,403);
        assert.equal((await agenda.save({...body,appointment:{...a,doctorProfileId:null}})).status === 200,false,'Admin with multiple doctors must choose');
        assert.equal((await agenda.save({...body,appointment:{...a,followUpId:uuid(),startTime:'10:00',endTime:'10:30'}})).status,403);
        const filtered=await agenda.list({...body,doctor_profile_id:doctors[0].id_doctor_professional_profile,date_from:a.date,date_to:a.date});
        assert.equal(filtered.status,200,filtered.message);assert.equal(filtered.data.length,1);assert.equal(filtered.data[0].doctorName,doctors[0].professional_name);
        const history=await agenda.patientHistory({...body,id_person:'QAC_PATIENT_01'});assert.equal(history.status,200);assert.ok(history.data.appointments.every(row=>row.doctorProfileId));
        const before=await rx.getConfig(business,doctors[1].id_doctor_professional_profile,body.id_login);
        const own=await rx.getConfig(business,doctors[0].id_doctor_professional_profile,body.id_login);
        assert.equal(own.status,200,own.message);
        const saved=await rx.saveConfig({...body,...own.data,doctor_profile_id:doctors[0].id_doctor_professional_profile,footer_note:'QA CO11 independent layout'});
        assert.equal(saved.status,200,saved.message);
        const other=await rx.getConfig(business,doctors[1].id_doctor_professional_profile,body.id_login);
        assert.equal(other.data.footer_note,before.data.footer_note);
        const raw=await rx.getRawConfig(business,null,doctors[0].id_login);assert.equal(raw.footer_note,'QA CO11 independent layout');
        assert.equal((await rx.getConfig(business,uuid(),body.id_login)).status,403);
        const originalPermission = rx.hasPermission; rx.hasPermission = async (_id, permission) => permission === 'prescriptions.config';
        const denied=await rx.saveConfig({...own.data,id_business:business,id_login:doctors[1].id_login,doctor_profile_id:doctors[0].id_doctor_professional_profile});assert.equal(denied.status === 200,false); rx.hasPermission = originalPermission;
        console.log('PASS CO11 real SQL/DAO: independent simultaneous doctors, same-doctor conflict, tenant/profile/follow-up denial, hours, scoped history, independent prescription configs and issuer lookup. One connection; all changes rolled back.');
    } finally { await connection.rollback();await connection.end(); }
})().catch(error=>{console.error(error.stack);process.exitCode=1;});

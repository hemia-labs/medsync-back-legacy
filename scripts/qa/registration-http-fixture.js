'use strict';
// Minimal synthetic persistence for the real HTTP/DAO flow. No legacy dump or configured DB.
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomUUID,createHash}=require('node:crypto');
const mysql=require('mysql2/promise');
const {Sequelize}=require('sequelize');
const tables={
    business:`id_business VARCHAR(50) PRIMARY KEY,name VARCHAR(200),legal_name VARCHAR(200),slug VARCHAR(100),email VARCHAR(254),phone VARCHAR(50),address TEXT,
        status VARCHAR(30),subscription_status VARCHAR(30),trial_starts_at DATETIME,trial_ends_at DATETIME,current_period_starts_at DATETIME,current_period_ends_at DATETIME,
        plan VARCHAR(30),active TINYINT,created_at DATETIME,created_by VARCHAR(50),updated_at DATETIME,updated_by VARCHAR(50),suspended_at DATETIME,cancelled_at DATETIME,status_reason TEXT`,
    rol:`id_rol VARCHAR(50) PRIMARY KEY,code VARCHAR(30),desc_rol VARCHAR(100),active TINYINT`,
    login:`id_login VARCHAR(50) PRIMARY KEY,id_business VARCHAR(50),id_rol VARCHAR(50),name VARCHAR(500),first_name VARCHAR(500) NOT NULL DEFAULT '',last_name VARCHAR(500) NOT NULL DEFAULT '',
        email VARCHAR(254),telephone VARCHAR(50),password VARCHAR(300),locked TINYINT DEFAULT 0,active TINYINT DEFAULT 1,created_at DATETIME,created_by VARCHAR(50),updated_at DATETIME,updated_by VARCHAR(50)`,
    appointment_config:`id_appointment_config VARCHAR(100) PRIMARY KEY,id_business VARCHAR(50),enabled TINYINT,default_appointment_duration INT,timezone VARCHAR(80),active TINYINT,created_at DATETIME,created_by VARCHAR(50)`,
    cat_ui_theme:`id_cat_ui_theme VARCHAR(50) PRIMARY KEY,code VARCHAR(50),active TINYINT`,
    ui_theme_configuration:`id_ui_theme_configuration VARCHAR(50) PRIMARY KEY,id_business VARCHAR(50),id_cat_ui_theme VARCHAR(50),active TINYINT,created_by VARCHAR(50),created_at DATETIME`,
    admin_audit_log:`id_admin_audit_log VARCHAR(50) PRIMARY KEY,actor_login_id VARCHAR(50),actor_role VARCHAR(50),action VARCHAR(100),target_type VARCHAR(50),target_id VARCHAR(50),
        target_login_id VARCHAR(50),target_business_id VARCHAR(50),metadata_json JSON,ip VARCHAR(80),user_agent TEXT,created_at DATETIME`,
    cat_permission:`id_cat_permission VARCHAR(50) PRIMARY KEY,code VARCHAR(100),active TINYINT DEFAULT 1,is_active TINYINT DEFAULT 1,value INT,sec INT`,
    permission_rol:`id_permission_rol VARCHAR(50) PRIMARY KEY,id_rol VARCHAR(50),id_cat_permission VARCHAR(50),active TINYINT DEFAULT 1`,
    business_role_permission:`id_business VARCHAR(50),id_rol VARCHAR(50),id_cat_permission VARCHAR(50),active TINYINT,PRIMARY KEY(id_business,id_rol,id_cat_permission)`,
    doctor_professional_profile:`id_doctor_professional_profile VARCHAR(50) PRIMARY KEY,id_login VARCHAR(50),id_business VARCHAR(50),professional_name VARCHAR(100),is_active TINYINT`,
    session:`id_session VARCHAR(50) PRIMARY KEY,id_login VARCHAR(50),active TINYINT,\`last\` TINYINT,created_at DATETIME,created_by VARCHAR(50),updated_at DATETIME,updated_by VARCHAR(50),forze_by VARCHAR(50),forze_at DATETIME`,
    refresh_token:`id_refresh_token VARCHAR(50) PRIMARY KEY,id_login VARCHAR(50),id_session VARCHAR(50),refresh_token TEXT,token_hash CHAR(64),token_fingerprint CHAR(32),family_id VARCHAR(50),
        parent_token_hash CHAR(64),issued_at DATETIME,expires_at DATETIME,\`last\` TINYINT,created_at DATETIME,created_by VARCHAR(50),created_ip VARCHAR(80),created_user_agent TEXT,
        revoked_at DATETIME,revoked_reason VARCHAR(80),rotated_at DATETIME,reused_at DATETIME`,
    auth_password_reset_tokens:`id BIGINT AUTO_INCREMENT PRIMARY KEY,id_login VARCHAR(50),identifier_normalized VARCHAR(254) NOT NULL,destination_email_fingerprint CHAR(64),code_hash CHAR(64),code_fingerprint CHAR(32),
        purpose VARCHAR(30) DEFAULT 'password_reset',status VARCHAR(20),attempts INT DEFAULT 0,max_attempts INT DEFAULT 5,issued_at DATETIME,expires_at DATETIME,verified_at DATETIME,used_at DATETIME,
        revoked_at DATETIME,expired_at DATETIME,locked_at DATETIME,requested_ip VARCHAR(80),requested_user_agent TEXT,created_at DATETIME,updated_at DATETIME`
};
async function createFixture(){
    assert.equal(process.env.REGISTRATION_QA_ISOLATED,'1');
    const socket=process.env.REGISTRATION_QA_SOCKET;
    assert.match(socket||'',/^\/private\/tmp\/medsync-[^/]+\/[^/]+\.sock$/);
    const admin=await mysql.createConnection({socketPath:socket,user:'root',password:''});
    const database='registration_http_qa_'+randomUUID().replaceAll('-','');
    const scratch=await fs.mkdtemp('/tmp/medsync-registration-http-');
    let db,other,shared;
    try {
        const [[instance]]=await admin.query('SELECT @@skip_networking disabled,@@datadir directory');
        assert.equal(instance.disabled,1);assert.ok(instance.directory.startsWith(path.dirname(socket)+'/'));
        await admin.query('CREATE DATABASE `'+database+'` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
        await admin.changeUser({database});
        for(const [name,columns] of Object.entries(tables))await admin.query('CREATE TABLE `'+name+'` ('+columns+') ENGINE=InnoDB');
        for(const sql of require('../migrations/s24IdentitySchema').statements)await admin.query(sql);
        for(const sql of require('../migrations/s24ContactSchema').statements)await admin.query(sql);
        for(const sql of require('../migrations/s24ActivationSchema').statements)await admin.query(sql);
        await require('../migrations/s25-registration-email-login').apply(admin,path.join(scratch,'s25'));
        await admin.query(await fs.readFile(path.join(__dirname,'../migrations/s24-registration-provisioning.sql'),'utf8'));
        await require('../migrations/s26-registration-legal-evidence').apply(admin,true);
        await require('../migrations/s27-registration-phone-contact').apply(admin,path.join(scratch,'s27'));
        const legalSchema=await fs.readFile(path.join(__dirname,'../migrations/saas-legal-documents.sql'),'utf8');
        for(const sql of legalSchema.split(/;\s*(?:\r?\n|$)/).map(s=>s.trim()).filter(Boolean))await admin.query(sql);
        await admin.query("INSERT INTO rol VALUES ('admin','admin','Admin',1)");
        await admin.query("INSERT INTO cat_ui_theme VALUES ('theme','medical-blue',1)");
        // Model the existing procedure's session-creation contract, not a second auth implementation.
        await admin.query(`CREATE PROCEDURE SP_login_by_idlogin(IN login_id VARCHAR(50),IN refresh_requested BOOLEAN)
            BEGIN
                DECLARE session_id VARCHAR(50);SET session_id=UUID();
                UPDATE \`session\` SET active=0,\`last\`=0 WHERE id_login=login_id;
                UPDATE refresh_token SET \`last\`=0,revoked_at=COALESCE(revoked_at,NOW()) WHERE id_login=login_id;
                INSERT INTO \`session\`(id_session,id_login,active,\`last\`,created_at) VALUES(session_id,login_id,1,1,NOW());
                SELECT l.*,session_id AS id_session FROM login l WHERE l.id_login=login_id AND l.active=1;
            END`);
        const connection=()=>new Sequelize(database,'root','',{dialect:'mysql',dialectOptions:{socketPath:socket},logging:false,pool:{min:0,max:1,idle:1000}});
        db=connection();other=connection();shared=connection();
        const sharedPath=require.resolve('../../src/db/Sequelize.connection');
        require.cache[sharedPath]={id:sharedPath,filename:sharedPath,loaded:true,exports:shared};
        const {LegalRegistrationService}=require('../../src/services/registration/legalRegistration.service');
        const html=Buffer.from('<p>Synthetic legal terms for registration QA.</p>'),contentHash=createHash('sha256').update(html).digest('hex');
        const legal=new LegalRegistrationService(db,{env:{LEGAL_API_URL:'http://localhost:3017',HEMIA_ID_URL:'http://localhost:4000',
            LEGAL_APPLICATION_ID:randomUUID(),HEMIA_CLIENT_ID:'synthetic',HEMIA_CLIENT_SECRET:'synthetic',LEGAL_DOCUMENT_ORIGINS:'https://qa.invalid'},fetch:async()=>new Response(html)});
        const manifest={snapshotToken:randomUUID(),expiresAt:new Date(Date.now()+3600000).toISOString(),documents:['terms_conditions','privacy_notice'].map((documentKey,index)=>({documentKey,
            documentVersionId:randomUUID(),documentId:randomUUID(),version:'1.0.0',title:documentKey,contentHash,requiredAction:index?'acknowledge':'accept',artifacts:{html:{url:'https://qa.invalid/legal'}}}))};
        legal.client={getDocumentSet:async()=>manifest};
        return {database,db,other,legal,scratch,admin,async close(){await shared.close();await db.close();await other.close();await admin.query('DROP DATABASE `'+database+'`');await admin.end();await fs.rm(scratch,{recursive:true,force:true});}};
    }catch(error){
        if(shared)await shared.close();if(db)await db.close();if(other)await other.close();
        await admin.query('DROP DATABASE IF EXISTS `'+database+'`');await admin.end();await fs.rm(scratch,{recursive:true,force:true});throw error;
    }
}
module.exports={createFixture};

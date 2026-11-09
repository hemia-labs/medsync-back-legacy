'use strict';
// Exercise the actual recovery DAO without importing configured DB/email clients.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const identity=require('../../src/services/registration/identity');
const source=fs.readFileSync(path.join(__dirname,'../../src/Dao/mysql/auth.dao.js'),'utf8');

async function scenario({challengeStatus='verified',expired=false,wrongCode=false,failActivation=false,failRevocation=false,notificationFails=false}={}) {
    const original={password:'old-hash',emailVerified:false,trial:false,sessionActive:true,challengeStatus};
    let committed={...original},tx,activations=0,notifications=0;
    const challenge={id:1,id_login:'owner',status:challengeStatus,destination_email_fingerprint:'email-fingerprint',
        code_hash:'code-hash',code_fingerprint:'fingerprint',attempts:0,max_attempts:5,expires_at:new Date(Date.now()+60000)};
    const db={
        async transaction() {
            tx={state:{...committed},finished:false,
                async commit(){committed={...this.state};this.finished='commit';},
                async rollback(){this.finished='rollback';}};
            return tx;
        },
        async query(sql,options) {
            assert.equal(options.transaction,tx,'Every recovery write belongs to the same transaction');
            const state=tx.state;
            if(sql.includes('SELECT id,id_login,identifier_normalized')) return [{...challenge,status:state.challengeStatus}];
            if(sql.includes('UPDATE login SET password')) state.password=options.replacements._password;
            else if(sql.includes('UPDATE auth_password_reset_tokens SET status=:status')) state.challengeStatus=options.replacements.status;
            else if(sql.includes("UPDATE auth_identity SET reservation_status='verified'")) state.emailVerified=true;
            else if(sql.includes('UPDATE `session`')) state.sessionActive=false;
            else if(sql.includes('UPDATE refresh_token')) {if(failRevocation) throw Error('synthetic revocation failure');}
            else if(!sql.includes('UPDATE auth_password_reset_tokens')) throw Error('Unexpected SQL in recovery test');
            return [undefined,1];
        }
    };
    const dependencies={
        '../../util/effectivePermissions':{}, crypto:require('node:crypto'),
        '../../services/registration/identityAuth':{enabled:()=>true,findOwner:async(database,email,options)=>{
            assert.equal(database,db);assert.equal(email,'owner@example.invalid');assert.equal(options.transaction,tx);
            return {id_login:'owner',email,password:tx.state.password};
        }},
        '../../services/registration/identity':identity,
        '../../services/security/registrationPassword.service':{hash:async()=> 'new-hash'},
        '../../services/registration/accountActivation.service':{AccountActivationService:class {
            constructor(database){assert.equal(database,db);}
            async activateVerifiedEmail(id,transaction){
                assert.equal(id,'owner');assert.equal(transaction,tx);assert.equal(tx.finished,false);
                assert.equal(tx.state.emailVerified,true);assert.equal(tx.state.password,'new-hash');
                assert.equal(tx.state.challengeStatus,'used');activations++;
                tx.state.trial=true;
                if(failActivation) throw Error('synthetic activation failure');
                return true;
            }
        }},
        '../../models/mysql/auth.model':{}, sequelize:{QueryTypes:{SELECT:'SELECT',UPDATE:'UPDATE'}},
        '../../db/Sequelize.connection':db, '../../util/sequelize.sp.util':{},
        '../../util/responsedata':{success:data=>({status:200,data}),notSuccess:()=>({status:404})},
        '../../util/common.messages.util':{},
        '../../util/sequelizeException':{SequelizeException:()=>({status:500})},
        '../../auth/authenticate':{}, '../../mail/mail':{SendPasswordChanged:async()=>{
            assert.equal(tx.finished,'commit');notifications++;if(notificationFails) throw Error('synthetic email failure');return {process:true};
        }},
        '../../util/bcrypt':{}, './session.Dao':{}, './tenantOperational.dao':{},
        '../../services/security/refreshToken.service':{},
        '../../services/security/passwordResetToken.service':{PURPOSE:'password_reset',fingerprintEmail:()=> 'email-fingerprint',
            isExpired:()=>expired,hashCode:()=> 'code-hash',safeCompareHash:()=>!wrongCode},
        '../../services/security/passwordChangeToken.service':{},
        '../../config/security':{getPasswordResetMaxAttempts:()=>5}, '../../util/businessOperational':{}
    };
    const module={exports:{}};
    vm.runInNewContext(source,{module,Date,console,require:name=>{
        assert.ok(Object.hasOwn(dependencies,name),'Unexpected dependency: '+name);return dependencies[name];
    }},{filename:'auth.dao.js'});
    const result=await module.exports.reseetPassword({email:'owner@example.invalid',code:'123456',password:'Synthetic new password'});
    if(failActivation||failRevocation) {
        assert.equal(result.status,500);assert.equal(tx.finished,'rollback');assert.deepEqual(committed,original);assert.equal(notifications,0);
    } else if(expired||wrongCode||challengeStatus!=='verified') {
        assert.equal(result.status,404);assert.equal(activations,0);assert.equal(committed.password,'old-hash');assert.equal(committed.trial,false);
    } else {
        assert.equal(result.status,200);assert.equal(activations,1);assert.equal(committed.trial,true);
        assert.equal(committed.emailVerified,true);assert.equal(committed.sessionActive,false);assert.equal(committed.password,'new-hash');
        assert.equal(notifications,1);
    }
}
async function run() {
    for(const options of [{},{failActivation:true},{failRevocation:true},{expired:true},{wrongCode:true},{challengeStatus:'pending'},{challengeStatus:'used'},{notificationFails:true}]) await scenario(options);
    console.log('PASS recovery DAO: verified recovery activates in the same transaction; activation/revocation failures roll back; invalid, expired and reused codes do not activate; notification failure preserves commit.');
}
if(require.main===module)run().catch(error=>{console.error(error);process.exitCode=1;});
module.exports={run};

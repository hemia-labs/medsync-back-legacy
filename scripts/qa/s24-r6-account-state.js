'use strict';
// Explicit CLI fixture only; cannot address the configured/remote database.
const fs=require('node:fs/promises'),path=require('node:path');
const {Sequelize,QueryTypes}=require('sequelize');
async function main() {
    if(process.env.S24_QA_ISOLATED!=='1')throw Error('Isolated QA opt-in required');
    const root=path.resolve(__dirname,'../../..'),manifest=JSON.parse(await fs.readFile(path.join(root,'_qa/s24-r6/preview.json'),'utf8'));
    if(!/^s24b_qa_[a-f0-9]{32}$/.test(manifest.database))throw Error('Not an isolated S24 database');
    const db=new Sequelize(manifest.database,'root','',{host:'127.0.0.1',port:33324,dialect:'mysql',logging:false,pool:{min:0,max:1,idle:1000}});
    try {
        const [actor]=await db.query("SELECT id_login,id_business FROM login WHERE email='r6.local@example.invalid'",{type:QueryTypes.SELECT});
        if(!actor)throw Error('Synthetic R6 actor not found');
        const shared=require('../../src/db/Sequelize.connection');shared.query=(...args)=>db.query(...args);shared.transaction=(...args)=>db.transaction(...args);
        process.env.REGISTRATION_ACTIVATION_ENABLED='true';
        const {AccountActivationService}=require('../../src/services/registration/accountActivation.service');
        const activation=new AccountActivationService(db);
        const before=await activation.account(actor);
        if(process.argv.includes('--confirm-activation')) {
            if(!before.email_verified || before.subscription_status!=='pending_activation')throw Error('Expected verified pending synthetic account');
            await db.transaction(async transaction=>{
                await db.query("UPDATE business SET subscription_status='active',plan='professional' WHERE id_business=:business AND subscription_status='pending_activation'",{replacements:{business:actor.id_business},transaction});
                await db.query('UPDATE registration_account SET activation_completed_at=COALESCE(activation_completed_at,NOW(3)) WHERE id_login=:login AND id_business=:business',
                    {replacements:{login:actor.id_login,business:actor.id_business},transaction});
            });
        }
        const status=await activation.status(actor);
        const [business]=await db.query('SELECT phone,email,address FROM business WHERE id_business=:business',{replacements:{business:actor.id_business},type:QueryTypes.SELECT});
        const identities=await db.query('SELECT kind,reservation_status,verified_at IS NOT NULL AS verified FROM auth_identity WHERE id_login=:login',{replacements:{login:actor.id_login},type:QueryTypes.SELECT});
        const [profiles]=await db.query('SELECT COUNT(*) count FROM doctor_professional_profile WHERE id_login=:login',{replacements:{login:actor.id_login},type:QueryTypes.SELECT});
        const [legal]=await db.query('SELECT COUNT(*) count, COUNT(DISTINCT id_version) versions FROM saas_legal_acceptances WHERE accepted_by_id=:login AND id_business=:business',
            {replacements:{login:actor.id_login,business:actor.id_business},type:QueryTypes.SELECT});
        const preparation=status.commercialState==='activated'?await require('../../src/Dao/mysql/preparation.dao').current(actor.id_business,actor.id_login):null;
        const evidence={database:manifest.database,synthetic:true,subscriptionStatus:status.subscriptionStatus,commercialState:status.commercialState,nextAction:status.nextAction,
            welcomePending:status.welcomePending,activationCompleted:!!status.activationCompletedAt,identities,professionalProfiles:profiles.count,legal,
            businessContactNotInferred:!business.phone&&!business.email,preparation};
        const evidenceName=status.welcomePending?status.subscriptionStatus:'acknowledged';
        await fs.writeFile(path.join(root,'docs/saas-platform/phases/evidence/S24_R6',evidenceName+'-state.json'),JSON.stringify(evidence,null,2));
        console.log(JSON.stringify(evidence,null,2));
    }finally{await db.close();}
}
if(require.main===module)main().catch(error=>{console.error(error.code||error.message);process.exitCode=1;});

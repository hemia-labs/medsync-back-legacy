'use strict';
const router=require('express').Router();
const Token=require('../../auth/authenticate');
const operational=require('../../middleware/requireTenantOperational.middleware');
const {requirePermission}=require('../../middleware/requirePermission.middleware');
const {csrfProtection}=require('../../middleware/csrf.middleware');
const {getBusinessIdFromToken}=require('../../util/tenant');
const {hasPermission}=require('../../util/effectivePermissions');
const db=require('../../db/Sequelize.connection');
const identity=require('../../Dao/mysql/identity.dao');
const csrf=csrfProtection();
router.use(Token.Auth,operational);
const handle=(kind,write=false)=>async(req,res)=>{
    res.set('Cache-Control','no-store');
    try {
        const business=getBusinessIdFromToken(req.tokenDecode),actor=req.tokenDecode.id_login;
        let id=req.params.id;
        if(!business||!actor)return res.status(403).send({status:403,message:'Acceso no autorizado.'});
        if(kind==='professional') {
            if(id !== 'me' && id !== actor && !await hasPermission(actor,'admin.users'))return res.status(403).send({status:403,message:'Acceso no autorizado.'});
            const rows=await db.query('SELECT id_doctor_professional_profile FROM doctor_professional_profile WHERE id_login=:id AND id_business=:business',{replacements:{id:id==='me'?actor:id,business},type:'SELECT'});
            if(!rows.length)return res.status(404).send({status:404,message:'Guarda primero el perfil profesional.'});
            id=rows[0].id_doctor_professional_profile;
        }
        let data;
        if(write) {
            if(!req.body||Object.keys(req.body).some(k=>!['identity','expectedRevision'].includes(k)))return res.status(400).send({status:400,message:'Payload inválido.'});
            data=await identity.save(kind,id,business,actor,req.body.identity,req.body.expectedRevision,kind==='professional'&&await hasPermission(actor,'admin.users'));
        } else {const row=await identity.read(kind,id,business);data=identity.view(row.data,row.revision,row.updatedAt);}
        res.status(200).send({status:200,data,message:'Identidad guardada o consultada.'});
    } catch(e) {res.status(e.status||500).send({status:e.status||500,message:e.status?e.message:'No se pudo completar la operación.',data:{code:e.code||'IDENTITY_ERROR',field:e.field}});}
};
router.get('/patients/:id',requirePermission('px.all'),handle('patient'));
router.patch('/patients/:id',csrf,requirePermission('px.new'),handle('patient',true));
router.get('/professionals/:id',handle('professional'));
router.patch('/professionals/:id',csrf,handle('professional',true));
router.get('/establishments',requirePermission('admin.config'),async(req,res)=>{
    res.set('Cache-Control','no-store');
    try {const rows=await db.query('SELECT id_care_establishment AS id,display_name AS displayName,active FROM care_establishment WHERE id_business=:business ORDER BY display_name,id_care_establishment',{replacements:{business:getBusinessIdFromToken(req.tokenDecode)},type:'SELECT'});res.send({status:200,data:rows});}
    catch(_){res.status(503).send({status:503,message:'No se pudieron consultar los establecimientos.'});}
});
router.get('/establishments/:id',requirePermission('admin.config'),handle('establishment'));
router.post('/establishments',csrf,requirePermission('admin.config'),handle('establishment',true));
router.patch('/establishments/:id',csrf,requirePermission('admin.config'),handle('establishment',true));
module.exports=router;

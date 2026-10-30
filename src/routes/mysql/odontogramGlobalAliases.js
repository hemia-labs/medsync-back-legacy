'use strict';
const router=require('express').Router();
const Token=require('../../auth/authenticate');
const requireRole=require('../../middleware/requireRole.middleware');
const {csrfProtection}=require('../../middleware/csrf.middleware');
const aliases=require('../../services/odontogramAliases.service');
const {CATALOG}=require('../../domain/odontogram/operations');
// Platform metadata only: never query tenants, patients or chart content here.
router.use(Token.Auth,requireRole('super_admin'));
const handle=work=>async(req,res,next)=>{try{res.send({status:200,data:{...await work(req),catalog:CATALOG}});}catch(error){if(error.status)return res.status(error.status).send({status:error.status,message:error.message,code:error.code});next(error);}};
router.get('/',handle(()=>aliases.state(null)));
router.put('/',csrfProtection(),handle(req=>aliases.saveGlobal(req.tokenDecode.id_login,req.body)));
module.exports=router;

'use strict';
const router = require('express').Router();
const Token = require('../../auth/authenticate');
const operational = require('../../middleware/requireTenantOperational.middleware');
const { requirePermission, requireAnyPermission } = require('../../middleware/requirePermission.middleware');
const { csrfProtection } = require('../../middleware/csrf.middleware');
const { getBusinessIdFromToken } = require('../../util/tenant');
const dao = require('../../Dao/mysql/odontogramV2.dao');
const D = require('../../domain/odontogram/operations');
const clinicalPermission = code => requirePermission(code, { enabledCatalog: true });
const permission = name => clinicalPermission('odontogram.' + name);
const csrf = csrfProtection();
const missingSchema = error => ['ER_BAD_FIELD_ERROR', 'ER_NO_SUCH_TABLE'].includes(error.code || error.original && error.original.code);
const handle = work => async (req, res, next) => {
    try {
        const business = getBusinessIdFromToken(req.tokenDecode), actor = req.tokenDecode.id_login;
        if (!business || !actor) D.fail('Sesión no disponible.', 403);
        const data = await work(req, business, actor);
        res.status(200).send({ status: 200, data });
    } catch (error) {
        if (missingSchema(error)) return res.status(503).send({ status: 503, code: 'CO26_SCHEMA_REQUIRED', message: 'La migración CO26 está pendiente.' });
        if (error.status) return res.status(error.status).send({ status: error.status, code: error.code, message: error.message });
        require('../../services/security/securityLogger.service').record('odontogram.storage_failure', req, { reason: error.code || error.original && error.original.code || 'CO26_INTERNAL' });
        res.status(500).send({ status: 500, code: 'CO26_STORAGE_ERROR', message: 'No se pudo confirmar la operación. Conserva la captura y reintenta la misma solicitud.' });
    }
};
router.use(Token.Auth, operational);
router.get('/capabilities', requireAnyPermission(['px.tab.odontogram','admin.config'], { enabledCatalog: true }), handle(async (req, business) => {
    try { return { schema_ready: true, mode: await dao.mode(business), catalog_version: D.CATALOG_VERSION, catalog: D.CATALOG }; }
    catch (error) { if (missingSchema(error)) return { schema_ready: false, mode: 'v1' }; throw error; }
}));
router.get('/aliases', clinicalPermission('admin.config'), handle(async (req,business) => ({ ...await require('../../services/odontogramAliases.service').state(business), catalog:D.CATALOG })));
router.put('/aliases', csrf, clinicalPermission('admin.config'), handle((req,business,actor) => require('../../services/odontogramAliases.service').save(business,actor,req.body)));
router.get('/activation-check',clinicalPermission('admin.config'),handle((req,business)=>dao.activationMatrix(business)));
router.get('/preferences',clinicalPermission('admin.config'),handle((req,business)=>require('../../services/odontogramPreferences.service').state(business)));
router.put('/preferences',csrf,clinicalPermission('admin.config'),handle((req,business,actor)=>require('../../services/odontogramPreferences.service').save(business,actor,req.body)));
router.put('/mode', csrf, clinicalPermission('admin.config'), handle(async (req, business, actor) => {
    const mode = req.body.mode;
    if (!['v1', 'v2', 'v2_readonly'].includes(mode)) D.fail('Modo inválido.');
    const sequelize = require('../../db/Sequelize.connection');
    return sequelize.transaction(async transaction => {
        await dao.query('SELECT id_person FROM person WHERE id_business COLLATE utf8mb4_unicode_ci = :business COLLATE utf8mb4_unicode_ci ORDER BY id_person FOR UPDATE', { business }, transaction);
        const current = await dao.mode(business, transaction, true);
        if(mode==='v2'&&!(await dao.activationMatrix(business,transaction)).ready)D.fail('Antes de activar la captura, asigna lectura/captura y lectura/finalización a operadores activos en Puestos y accesos.',409,'CO26_OPERATORS_REQUIRED');
        if (mode === 'v1') {
            const rows = await dao.query('SELECT id_chart FROM odontogram_v2_chart WHERE id_business=:business LIMIT 1', { business }, transaction);
            if (rows.length) D.fail('Existen datos CO26; usa solo lectura para conservarlos visibles.', 409);
        }
        const baseline_count = current === 'v1' && mode !== 'v1' ? await dao.baseline(business, actor, transaction) : 0;
        await dao.query('UPDATE clinical_module_config SET odontogram_mode=:mode WHERE id_business=:business', { business, mode }, transaction);
        if (await dao.mode(business, transaction) !== mode) D.fail('Primero guarda la configuración clínica del consultorio.', 409);
        return { mode, previous_mode: current, baseline_count };
    });
}));
router.use(clinicalPermission('px.tab.odontogram'));
router.post('/metrics',csrf,handle(req=>require('../../services/odontogramMetrics.service').send(req.body)));
const replacement = (req, res, next) => req.body.replace_active_id ? permission('finalize')(req, res, next) : next();
router.get('/charts/:id_person', handle((req, business) => dao.list(business, req.params.id_person)));
router.get('/chart/:id_chart', handle((req, business) => dao.read(business, req.params.id_chart, req.query.revision)));
router.get('/chart/:id_chart/plan-links',clinicalPermission('treatments.view'),handle(async(req,business)=>{
    await dao.read(business,req.params.id_chart);
    const links=await dao.query(`SELECT s.tooth_number,s.finding_id,COUNT(*) AS related_count FROM odontogram_plan_dental_source s
        JOIN patient_treatment t ON t.id_business=s.id_business AND t.id_patient_treatment=s.id_treatment AND t.active=1
        WHERE s.id_business=:business AND s.id_chart=:chart GROUP BY s.tooth_number,s.finding_id`,{business,chart:req.params.id_chart});
    return{links};
}));
router.post('/charts/:id_person', csrf, permission('capture'), replacement, handle((req, business, actor) => dao.create(business, actor, req.params.id_person, req.body)));
router.post('/chart/:id_chart/ops', csrf, permission('capture'), handle((req, business, actor) => dao.operations(business, actor, req.params.id_chart, req.body)));
for (const action of ['finalize', 'reopen', 'delete']) router.post('/chart/:id_chart/' + action, csrf, permission(action), replacement,
    handle((req, business, actor) => dao.lifecycle(business, actor, req.params.id_chart, action, req.body)));
module.exports = router;

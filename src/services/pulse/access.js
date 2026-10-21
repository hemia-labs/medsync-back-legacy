'use strict';
const { QueryTypes } = require('sequelize');
const { createHash } = require('node:crypto');
const { isBusinessOperational } = require('../../util/businessOperational');
const { joins } = require('../../util/effectivePermissions');
const REQUIRED = Object.freeze(['pulse.view.business','dashboard.scope.all','dashboard.operations','dashboard.clinical']);
const detailPermissions = Object.freeze({ 'PUL-OP01': ['px.all','px.tab.monitoring'], 'PUL-OP02': ['px.all','documents.view'], 'PUL-OP03': ['px.all','px.dates'] });
class PulseAccess {
    constructor(db, now = Date.now) { this.db = db; this.now = now; }
    async authorize(principal) {
        if (!principal?.id_login || !principal.id_business || !principal.id_session) throw Object.assign(Error('AUTH_SESSION_INVALID'), { status: 401 });
        const records = await this.db.query(`SELECT cp.code,b.active,b.plan,b.subscription_status,b.trial_ends_at,l.id_rol,r.code AS roleCode
         FROM login l JOIN rol r ON r.id_rol=l.id_rol AND r.active=1 AND r.code<>'super_admin'
         JOIN business b ON b.id_business=l.id_business
         JOIN \`session\` s ON s.id_login=l.id_login AND s.id_session=:session AND s.active=1 AND s.\`last\`=1
         ${joins()}
         WHERE l.id_login=:login AND l.id_business=:business AND l.active=1 AND cp.is_active=1
         AND COALESCE(bp.active,pr.active,0)=1 ORDER BY cp.code`, { replacements: { login: principal.id_login, business: principal.id_business, session: principal.id_session }, type: QueryTypes.SELECT });
        const codes = new Set(records.map(r => r.code));
        if (!records[0] || !isBusinessOperational(records[0], new Date(this.now())).allowed || !REQUIRED.every(code => codes.has(code))) throw Object.assign(Error('PULSE_FORBIDDEN'), { status: 403 });
        const revision = createHash('sha256').update(JSON.stringify([principal.id_session, principal.id_business, records[0].id_rol, records.map(r => r.code)])).digest('hex').slice(0, 24);
        return { business: String(principal.id_business), revision, codes, canDetail: id => detailPermissions[id]?.every(code => codes.has(code)) === true };
    }
}
module.exports = { PulseAccess, REQUIRED, detailPermissions };

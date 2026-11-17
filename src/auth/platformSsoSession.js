'use strict';
const { randomUUID } = require('node:crypto');
const { QueryTypes } = require('sequelize');
const jwt = require('jsonwebtoken');
const { bindingFor, MAX_SESSION_SECONDS } = require('./platformSso');

// The existing MedSync account remains the authority. No provisioning or role promotion.
async function createSession(c, identity, db, jwtKey, audit, request = {}) {
    const binding = bindingFor(c, identity);
    const ttl = Math.min(MAX_SESSION_SECONDS, Math.floor(identity.exp - Date.now() / 1000));
    if (!binding || !Number.isFinite(ttl) || ttl < 30) throw new Error('Invalid SSO identity');
    return db.transaction(async transaction => {
        const options = { replacements: { login: binding.id_login }, transaction };
        const rows = await db.query(`SELECT l.id_login, l.id_business, l.id_rol, l.name, l.email, l.active, l.locked, r.code AS rol
            FROM login l INNER JOIN rol r ON r.id_rol=l.id_rol AND r.active=1
            WHERE l.id_login=:login FOR UPDATE`, { ...options, type: QueryTypes.SELECT });
        const user = rows[0];
        if (!user || !user.active || user.locked || user.rol !== 'super_admin' || String(user.email).toLowerCase() !== binding.email.toLowerCase()) {
            throw new Error('MedSync account is not authorized');
        }
        await db.query(`UPDATE refresh_token SET \`last\`=0, revoked_at=COALESCE(revoked_at,NOW()),
            revoked_reason=COALESCE(revoked_reason,'sso_login') WHERE id_login=:login AND (\`last\`=1 OR revoked_at IS NULL)`, options);
        await db.query('UPDATE `session` SET active=0, `last`=0, updated_at=NOW() WHERE id_login=:login', options);
        const counts = await db.query('SELECT COALESCE(MAX(sec),0)+1 AS next_sec FROM `session` WHERE id_login=:login', { ...options, type: QueryTypes.SELECT });
        const id = randomUUID();
        await db.query('INSERT INTO `session` (id_session,id_login,`last`,active,sec,created_at,created_by) VALUES (:session,:login,1,1,:sec,NOW(),:login)',
            { ...options, replacements: { ...options.replacements, session: id, sec: Number(counts[0].next_sec) } });
        await audit.record('PLATFORM_SSO_LOGIN', { actor_login_id: user.id_login, actor_role: user.rol,
            target_type: 'session', target_id: id, target_login_id: user.id_login,
            ip: request.ip, user_agent: String(request.userAgent || '').slice(0, 500), metadata: { method: 'hemia_sso' } }, { transaction, strict: true });
        const token = jwt.sign({ check: true, id_login: user.id_login, id_business: user.id_business, id_rol: user.id_rol,
            rol: user.rol, name: user.name, email: user.email, id_session: id,
            auth_method: 'hemia_sso', sso_sub: identity.sub, sso_issuer: c.issuer }, jwtKey, { algorithm: 'HS256', expiresIn: ttl });
        return { token, ttl };
    });
}
module.exports = { createSession };

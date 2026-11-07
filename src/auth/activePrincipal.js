const { QueryTypes } = require('sequelize');
const sequelize = require('../db/Sequelize.connection');

// Access tokens identify a session; live rows determine whether it is still
// usable and which role it currently has. Never cache this across requests.
async function activePrincipal(claims) {
    if (!claims || !claims.id_login || !claims.id_session) return null;
    const rows = await sequelize.query(`SELECT l.id_login, l.id_business, l.id_rol,
        r.code AS rol, r.desc_rol AS role_name, s.id_session, b.subscription_status
        FROM login l
        INNER JOIN rol r ON r.id_rol = l.id_rol AND r.active = 1
        LEFT JOIN business b ON b.id_business = l.id_business
        INNER JOIN \`session\` s ON s.id_login = l.id_login AND s.active = 1 AND s.\`last\` = 1
        WHERE l.id_login = :login
          AND s.id_session = :session
          AND l.active = 1 LIMIT 1`, {
        replacements: { login: claims.id_login, session: claims.id_session }, type: QueryTypes.SELECT
    });
    const current = rows[0];
    // A session cannot silently move to a different business using an old token.
    if (!current || String(current.id_business || '') !== String(claims.id_business || '')) return null;
    current.subscription_status = String(current.subscription_status || '').trim().toLowerCase() || null;
    if (current.subscription_status === 'pending_activation') {
        const reservations = await sequelize.query(`SELECT i.id_login FROM auth_identity i
            INNER JOIN login l ON l.id_login=i.id_login
            WHERE l.id_login=:login AND i.kind='email' AND i.normalized_value=s24_email(l.email)
              AND ((i.reservation_status IN ('legacy','verified','reserved') AND i.expires_at IS NULL)
                OR (i.reservation_status='pending' AND i.expires_at>NOW(3))) LIMIT 1`, {
            replacements: { login: current.id_login }, type: QueryTypes.SELECT
        });
        if (!reservations.length) return null;
    }
    return { ...claims, ...current };
}

module.exports = activePrincipal;

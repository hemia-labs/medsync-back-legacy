'use strict';
const { QueryTypes } = require('sequelize');
const AuthCookies = require('../../config/authCookie.config');
const RefreshTokens = require('../security/refreshToken.service');

// No rotation, revocation or session creation: a renewable session must not be
// discarded just because its short-lived access cookie expired.
async function state(req, database) {
    if (req.tokenDecode) return 'active';
    const names = AuthCookies.getCookieNames(AuthCookies.assertAuthCookieConfig());
    const refresh = req.cookies && req.cookies[names.refresh];
    if (typeof refresh === 'string' && refresh.length > 0 && refresh.length <= 512) {
        const parsed = RefreshTokens.parseRefreshToken(refresh);
        const rows = await database.query(`SELECT rt.id_refresh_token FROM refresh_token rt
            INNER JOIN login l ON l.id_login=rt.id_login AND l.active=1
            INNER JOIN rol r ON r.id_rol=l.id_rol AND r.active=1
            INNER JOIN \`session\` s ON s.id_login=l.id_login AND s.active=1 AND s.\`last\`=1
            WHERE rt.id_refresh_token=:_id AND rt.\`last\`=1
              AND rt.revoked_at IS NULL AND rt.rotated_at IS NULL AND rt.reused_at IS NULL
              AND (rt.expires_at IS NULL OR rt.expires_at>NOW())
              AND ${parsed ? 'rt.token_hash=:_hash AND rt.id_session=s.id_session' : "(rt.token_hash IS NULL OR rt.token_hash='')"}
            LIMIT 1`, { replacements: parsed ? { _id: parsed.tokenId, _hash: parsed.tokenHash } : { _id: refresh }, type: QueryTypes.SELECT });
        if (rows.length) return 'active';
    }
    return req.authTokenPresent || req.authTokenInvalid || refresh ? 'expired' : 'anonymous';
}

function clearExpiredCookies(res) {
    const config = AuthCookies.assertAuthCookieConfig();
    const names = AuthCookies.getCookieNames(config);
    res.cookie(names.access, '', AuthCookies.getClearAccessCookieOptions(config));
    res.cookie(names.refresh, '', AuthCookies.getClearRefreshCookieOptions(config));
    res.cookie(names.csrf, '', AuthCookies.getClearCsrfCookieOptions(config));
    // Keep the registration attempt cookie: a lost earlier response must not
    // turn a deliberate retry into a different account-creation attempt.
}
module.exports = { state, clearExpiredCookies };

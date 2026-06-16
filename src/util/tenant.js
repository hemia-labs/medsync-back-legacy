const DEFAULT_BUSINESS_ID = 'default-business';
const SUPER_ADMIN_ROLE = 'super_admin';

function getBusinessIdFromToken(tokenDecode) {
    if (!tokenDecode) {
        return DEFAULT_BUSINESS_ID;
    }

    if (tokenDecode.rol === SUPER_ADMIN_ROLE && !tokenDecode.id_business) {
        return null;
    }

    return tokenDecode.id_business || DEFAULT_BUSINESS_ID;
}

function applyTenantToBody(req, body = {}) {
    body.id_login = req.tokenDecode ? req.tokenDecode.id_login : null;
    body.id_business = getBusinessIdFromToken(req.tokenDecode);
    body.rol = req.tokenDecode ? req.tokenDecode.rol : null;
    return body;
}

module.exports = {
    DEFAULT_BUSINESS_ID,
    SUPER_ADMIN_ROLE,
    getBusinessIdFromToken,
    applyTenantToBody
};

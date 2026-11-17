const responseData = require('../util/responsedata');

function requireRole(role) {
    return (req, res, next) => {
        if (!req.tokenDecode) {
            const response = responseData.unauthorized('Token invalido o no enviado.', { code: 'AUTH_ACCESS_INVALID' });
            res.status(response.status).send(response);
            return;
        }

        if (req.tokenDecode.rol !== role) {
            const response = {
                status: 403,
                data: null,
                message: 'No tienes permiso para acceder a este recurso.'
            };
            res.status(response.status).send(response);
            return;
        }

        next();
    };
}

module.exports = requireRole;

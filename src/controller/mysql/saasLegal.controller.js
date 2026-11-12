const dao = require('../../Dao/mysql/saasLegal.dao');
// Actor and tenant always come from the authenticated context, never body/query.
const context = req => ({ id_login: req.tokenDecode && req.tokenDecode.id_login,
    id_session: req.tokenDecode && req.tokenDecode.id_session, id_business: req.tokenDecode && req.tokenDecode.id_business, rol: req.tokenDecode && req.tokenDecode.rol });
const send = (res, response) => res.status(response.status).send(response);
module.exports = {
    publicDocument: async (req, res) => send(res.set('Cache-Control', 'no-store'), await dao.publicDocument(req.params.documentKey)),
    current: async (req, res) => send(res, await dao.current(context(req))),
    notice: async (req, res) => send(res.set('Cache-Control', 'no-store'), await dao.notice(context(req))),
    history: async (req, res) => send(res, await dao.history(context(req), req.query.cursor)),
    centralContext: async (req, res) => send(res, await dao.centralContext(context(req),req.query.documentSetKey)),
    representativeContext: async (req, res) => {
        const response=await dao.representativeContext(req.get('authorization'),req.body);
        return res.set('Cache-Control','no-store').status(response.status).send(response.success?response.data:response);
    },
    acceptCentral: async (req, res) => send(res, await dao.acceptCentral(context(req), req.body)),
    centralDocument: async (req, res) => send(res, await dao.centralDocument(context(req), req.params.versionId, req.query.cursor, req.query.documentSetKey)),
    accept: async (req, res) => send(res, await dao.accept(context(req), { id_version: req.body && req.body.id_version, acknowledged: req.body && req.body.acknowledged })),
    adminList: async (req, res) => send(res, await dao.adminList(context(req))),
    saveDraft: async (req, res) => send(res, await dao.saveDraft(context(req), req.params.documentKey, req.body)),
    publish: async (req, res) => send(res, await dao.publish(context(req), req.params.documentKey, req.body)),
    adminVersion: async (req, res) => send(res, await dao.adminVersion(context(req), req.params.documentKey, req.params.idVersion))
};

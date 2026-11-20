'use strict';
// NC5 · Chat interno. El negocio y el remitente salen de la sesión activa, nunca del cuerpo.
const ChatDao = require('../../Dao/mysql/chat.dao');
const { ChatError } = require('../../Dao/mysql/chat.dao');
const responseData = require('../../util/responsedata');

function principal(req) {
    const token = req.tokenDecode || {};
    if (!token.id_login || !token.id_business || token.rol === 'super_admin') throw new ChatError('CHAT_SESSION_INVALID', 403, 'El chat está disponible para el equipo de un consultorio.');
    return { business: String(token.id_business), me: String(token.id_login) };
}

function handle(action) {
    return async (req, res) => {
        try {
            const { business, me } = principal(req);
            const data = await action(business, me, req);
            res.status(200).send(responseData.success(data, 'OK'));
        } catch (error) {
            if (!(error instanceof ChatError)) throw error;
            res.status(error.status).send({ status: error.status, data: { code: error.code }, message: error.message });
        }
    };
}

module.exports = {
    directory: handle((business, me) => ChatDao.directory(business, me)),
    summary: handle((business, me) => ChatDao.summary(business, me)),
    conversations: handle((business, me) => ChatDao.conversations(business, me)),
    messages: handle((business, me, req) => ChatDao.messages(business, me, req.params.peerId, req.query || {})),
    markRead: handle((business, me, req) => ChatDao.markRead(business, me, req.params.peerId, (req.body || {}).upToId)),
    sendText: handle((business, me, req) => ChatDao.sendText(business, me, req.body || {})),
    previewNotice: handle((business, me, req) => ChatDao.previewNotice(business, me, req.body || {})),
    sendNotice: handle((business, me, req) => ChatDao.sendNotice(business, me, req.body || {})),
    request: handle((business, me, req) => ChatDao.request(business, me, req.params.clientRequestId)),
    noticesForTracing: handle((business, me, req) => ChatDao.noticesForTracing(business, me, req.params.tracingId))
};

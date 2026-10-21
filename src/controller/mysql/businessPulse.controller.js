'use strict';
const { CORE } = require('../../domain/pulse/rules');
function createPulseController(service) {
    return async (req, res) => {
        res.set('Cache-Control', 'no-store');
        const endpoint = req.path.replace(/\/+$/, ''), query = req.query || {}, allowed = endpoint === '/snapshot' ? ['refresh','contractVersion'] : endpoint === '/incidents' ? ['indicatorId','cursor','limit','contractVersion'] : endpoint === '/appointment-result' ? ['recordId','contractVersion'] : ['days','contractVersion'];
        if ([req.query, req.body, req.params].some(s => s && ['businessId','id_business','tenant','asOf'].some(k => Object.hasOwn(s, k))) || Object.keys(query).some(k => !allowed.includes(k) || typeof query[k] !== 'string') || (query.contractVersion && query.contractVersion !== '1.1-p1-draft')) return res.status(400).send({ status: 400, data: null, message: 'Parametros o version no admitidos.' });
        try {
            let data;
            if (endpoint === '/snapshot') { if (query.refresh && !['0','1'].includes(query.refresh)) throw Object.assign(Error(), { status: 400 }); data = await service.snapshot(req.tokenDecode, query.refresh === '1'); }
            else if (endpoint === '/incidents') { if (!CORE.includes(query.indicatorId) || (query.limit && !/^([1-9]|[1-4][0-9]|50)$/.test(query.limit))) throw Object.assign(Error(), { status: 400 }); data = await service.incidents(req.tokenDecode, query.indicatorId, query.cursor, Number(query.limit || 20)); }
            else if (endpoint === '/appointment-result') { if (!/^[A-Za-z0-9_-]{1,50}$/.test(query.recordId || '')) throw Object.assign(Error(), { status: 400 }); data = await service.appointmentResult(req.tokenDecode, query.recordId); }
            else { if (query.days && !/^([1-9]|[12][0-9]|30)$/.test(query.days)) throw Object.assign(Error(), { status: 400 }); data = await service.history(req.tokenDecode, Number(query.days || 30)); }
            return res.status(200).send({ status: 200, data, message: 'Pulso consultado; alcance y calidad indicados en la lectura.' });
        } catch (error) {
            const status = [400,401,403,429,503].includes(error.status) ? error.status : 503;
            return res.status(status).send({ status, data: null, message: status === 401 ? 'La sesion ya no esta activa.' : status === 403 ? 'No tienes acceso a esta lectura o accion.' : status === 400 ? 'Parametros o cursor no validos; actualiza la lectura.' : 'No pudimos verificar el Pulso. Puedes reintentar.', code: status === 503 ? 'PULSE_UNAVAILABLE' : undefined });
        }
    };
}
module.exports = { createPulseController };

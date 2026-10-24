'use strict';
// The transport is injected by the server composition root, never by a request.
// No default SMS provider is invented. Unconfigured channels fail closed.
class ContactDelivery {
    constructor({ sms = null, email = null } = {}) { this.transports = {sms,email}; }
    ready(channel) { return typeof this.transports[channel]?.send === 'function' && this.transports[channel].ready() === true; }
    async send(message) {
        if (!this.ready(message.channel)) return false;
        let timeout;
        try {
            // A failed/unknown acknowledgement is never retried automatically.
            const delivery=this.transports[message.channel].send({
                to: message.channel === 'sms' ? '+52' + message.to : message.to,
                code: message.code, ttlMinutes: 10, purpose: 'registration_contact', challengeId: message.challengeId
            });
            return await Promise.race([delivery,new Promise(resolve=>{timeout=setTimeout(()=>resolve(false),15000);})]) === true;
        } catch (_) { return false; }
        finally {clearTimeout(timeout);}
    }
}
module.exports = { ContactDelivery };
module.exports.configuredDelivery = () => new ContactDelivery({email: {
    ready() {
        const provider=String(process.env.EMAIL_PROVIDER || 'smtp').toLowerCase();
        return process.env.REGISTRATION_EMAIL_ENABLED==='true'
            && ['smtp','ses'].includes(provider)
            && (provider!=='ses' || Boolean(process.env.EMAIL_REGISTRATION_CODE_TEMPLATE))
            && require('../email/email.service').initialize().success===true;
    },
    async send({to,code,ttlMinutes}) {
        const result=await require('../email/email.service').sendTransactionalEmail({type:'registration-contact-code',to,variables:{code,ttlMinutes}});
        return result?.success===true;
    }
}});

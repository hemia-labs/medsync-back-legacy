'use strict';
const { normalizeEmail } = require('./identity');
const { normalizePassword } = require('../security/registrationPassword.service');
const { RegistrationError } = require('./errors');
function exact(object, keys) {
    if (!object || typeof object !== 'object' || Array.isArray(object)
        || Object.keys(object).length !== keys.length || keys.some(key => !Object.hasOwn(object,key)))
        throw new RegistrationError('REGISTRATION_VALIDATION_FAILED');
}
function name(value) {
    if (typeof value !== 'string' || !value.isWellFormed() || !value.trim() || [...value.trim()].length>200)
        throw new RegistrationError('REGISTRATION_VALIDATION_FAILED');
    return value.trim();
}
function validateRegistration(source) {
    let serialized;
    try { serialized=JSON.stringify(source); } catch (_) { throw new RegistrationError('REGISTRATION_VALIDATION_FAILED'); }
    if (!serialized || Buffer.byteLength(serialized)>8192) throw new RegistrationError('REGISTRATION_VALIDATION_FAILED');
    exact(source,['account','business','legalAcceptances']);
    exact(source.account,['name','telephone','email','password']); exact(source.business,['name']);
    const {account,business,legalAcceptances}=source;
    const email=normalizeEmail(account.email);
    if (!email || typeof account.telephone!=='string' || !/^[0-9]{10}$/.test(account.telephone)
        || !Array.isArray(legalAcceptances) || legalAcceptances.length!==2) throw new RegistrationError('REGISTRATION_VALIDATION_FAILED');
    const accepted=legalAcceptances.map(item=>{
        exact(item,['documentKey','versionId','acknowledged']);
        if (!['terms_conditions','privacy_notice'].includes(item.documentKey) || item.acknowledged!==true
            || typeof item.versionId!=='string' || !/^[A-Za-z0-9_-]{1,50}$/.test(item.versionId)) throw new RegistrationError('REGISTRATION_VALIDATION_FAILED');
        return {documentKey:item.documentKey,versionId:item.versionId,acknowledged:true};
    }).sort((a,b)=>a.documentKey.localeCompare(b.documentKey));
    if (accepted[0].documentKey===accepted[1].documentKey) throw new RegistrationError('REGISTRATION_VALIDATION_FAILED');
    return {account:{name:name(account.name),telephone:account.telephone,email,password:normalizePassword(account.password)},
        business:{name:name(business.name)},legalAcceptances:accepted};
}
module.exports={validateRegistration};

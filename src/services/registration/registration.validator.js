'use strict';
const { normalizeEmail } = require('./identity');
const { normalizePassword } = require('../security/registrationPassword.service');
const { RegistrationError } = require('./errors');
const { userNames } = require('../../util/userNames');
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
function validateLegalAcceptances(legalAcceptances) {
    if(!Array.isArray(legalAcceptances)||!legalAcceptances.length||legalAcceptances.length>10)
        throw new RegistrationError('REGISTRATION_VALIDATION_FAILED');
    const accepted=legalAcceptances.map(item=>{
        exact(item,['documentKey','versionId','acknowledged']);
        if (typeof item.documentKey!=='string'||!/^\w[\w-]{0,79}$/.test(item.documentKey) || item.acknowledged!==true
            || typeof item.versionId!=='string' || !/^[A-Za-z0-9_-]{1,50}$/.test(item.versionId)) throw new RegistrationError('REGISTRATION_VALIDATION_FAILED');
        return {documentKey:item.documentKey,versionId:item.versionId,acknowledged:true};
    }).sort((a,b)=>a.documentKey.localeCompare(b.documentKey));
    if (new Set(accepted.map(a=>a.documentKey)).size!==accepted.length||new Set(accepted.map(a=>a.versionId)).size!==accepted.length) throw new RegistrationError('REGISTRATION_VALIDATION_FAILED');
    return accepted;
}
function validateRegistration(source) {
    let serialized;
    try { serialized=JSON.stringify(source); } catch (_) { throw new RegistrationError('REGISTRATION_VALIDATION_FAILED'); }
    if (!serialized || Buffer.byteLength(serialized)>8192) throw new RegistrationError('REGISTRATION_VALIDATION_FAILED');
    exact(source,['account','business','legalAcceptances',...(Object.hasOwn(source||{},'legalContext')?['legalContext']:[])]);
    if(Object.hasOwn(source,'legalContext')&&(typeof source.legalContext!=='string'||source.legalContext.length>6100)) throw new RegistrationError('REGISTRATION_VALIDATION_FAILED');
    const split = Object.hasOwn(source.account || {},'first_name') || Object.hasOwn(source.account || {},'last_name');
    const nameFields = split ? ['first_name','last_name',...(Object.hasOwn(source.account,'name') ? ['name'] : [])] : ['name'];
    exact(source.account,[...nameFields,'email','password',...(Object.hasOwn(source.account || {},'telephone') ? ['telephone'] : [])]); exact(source.business,['name']);
    const {account,business,legalAcceptances}=source;
    const names=userNames(account);
    const email=normalizeEmail(account.email), telephone=account.telephone===undefined?'':account.telephone;
    if (!names || [...names.name].length>200 || !email || typeof telephone!=='string' || (telephone !== '' && !/^[0-9]{10}$/.test(telephone))
        || !Array.isArray(legalAcceptances) || !legalAcceptances.length || legalAcceptances.length>10) throw new RegistrationError('REGISTRATION_VALIDATION_FAILED');
    const accepted=validateLegalAcceptances(legalAcceptances);
    return {account:{...(split ? names : {name:names.name}),telephone,email,password:normalizePassword(account.password)},
        business:{name:name(business.name)},legalAcceptances:accepted,...(source.legalContext?{legalContext:source.legalContext}:{})};
}
module.exports={validateRegistration,validateLegalAcceptances};

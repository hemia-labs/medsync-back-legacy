'use strict';
const {parsePaymentSnapshot,snapshotAccess}=require('@hemia/payments');
const {getSaasPlan}=require('../../config/saasPlans');

const PLAN_CODES=Object.freeze({medsync_basic:'basic',medsync_pro:'pro',medsync_clinic:'enterprise'});
const FEATURE_LABELS=Object.freeze({
    'clinical_record.enabled':'Expediente clínico','clinical_history.enabled':'Historia clínica',
    'prescriptions.enabled':'Recetas','schedule.basic':'Agenda básica','schedule.advanced':'Agenda avanzada',
    'documents.basic':'Documentos básicos','documents.enabled':'Documentos',
    'consents.basic':'Consentimientos básicos','consents.enabled':'Consentimientos',
    'clinical_templates.custom':'Plantillas clínicas personalizadas','reports.basic':'Reportes básicos',
    'clinical_templates.by_professional_or_specialty':'Plantillas por profesional o especialidad',
    'dashboard.basic':'Dashboard básico','dashboard.operational':'Dashboard operativo',
    'dashboard.admin':'Dashboard administrativo',
    'support.standard':'Soporte estándar','support.priority':'Soporte prioritario',
    'onboarding.assisted':'Onboarding asistido'
});
function managed(business) {return /^[1-9]\d*$/.test(String(business?.billing_revision||''));}
function savedSnapshot(business) {
    if(!managed(business))return null;
    const raw=typeof business.billing_snapshot==='string'?JSON.parse(business.billing_snapshot):business.billing_snapshot;
    const parsed=parsePaymentSnapshot(raw,'medsync',business.id_business);
    if(parsed.revision!==String(business.billing_revision))throw Error('BILLING_SNAPSHOT_REVISION_MISMATCH');
    return parsed;
}
function paidPlan(business) {
    if(!managed(business))return null;
    let snapshot,access;
    try {snapshot=savedSnapshot(business);access=snapshotAccess(snapshot);}catch(_) {access={active:false};}
    const code=snapshot&&PLAN_CODES[snapshot.license.planCode];
    const plan=getSaasPlan(code)||{code:'unknown',name:'Plan no disponible'};
    const features=access.active&&code?snapshot.license.features:{};
    const quota=key=>Number.isSafeInteger(features[key])&&features[key]>=0?features[key]:0;
    return {...plan,maxProfessionals:quota('professionals.included'),maxAuxiliaryUsers:quota('users.auxiliary.included'),
        maxStaffUsers:quota('users.auxiliary.included'),maxBranches:quota('branches.included'),
        monthlyPriceMxn:null,founderMonthlyPriceMxn:null,founderPriceMonths:null,
        publicLabel:'Consultar precio en Billing',founderLabel:null,
        features:Object.keys(FEATURE_LABELS).filter(key=>features[key]===true).map(key=>FEATURE_LABELS[key]),
        billingFeatures:features,billingManaged:true};
}
function commercialState(snapshot) {
    const access=snapshotAccess(snapshot),plan=PLAN_CODES[snapshot.license.planCode];
    const license=snapshot.license,sub=snapshot.subscription;
    const paidEnd=Date.parse(sub?.currentPeriodEnd||sub?.nextBillingTime);
    // Billing cancels future renewals immediately while its paid license remains active.
    const paidCancellation=sub?.cancelAtPeriodEnd===true&&paidEnd>Date.now();
    if(access.active&&plan&&(['active','past_due'].includes(sub?.status)||sub?.status==='cancelled'&&paidCancellation)) {
        const end=sub?.cancelAtPeriodEnd?Math.min(Date.parse(access.validUntil),paidEnd):Date.parse(access.validUntil);
        if(end>Date.now())return {status:'active',plan,accessUntil:new Date(end)};
    }
    const status=license.licenseStatus==='suspended'?'suspended'
        :license.licenseStatus==='revoked'||sub?.status==='cancelled'?'cancelled':'past_due';
    return {status,plan:plan||null,accessUntil:new Date(0)};
}
module.exports={PLAN_CODES,managed,savedSnapshot,paidPlan,commercialState};

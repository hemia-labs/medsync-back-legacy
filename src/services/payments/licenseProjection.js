'use strict';
const {QueryTypes}=require('sequelize');
const {parsePaymentSnapshot}=require('@hemia/payments');
const {managed,commercialState}=require('./paidLicense');
const {enqueueContractWelcome}=require('./contractWelcome.service');

class LicenseProjection {
    constructor(db){this.db=db;}
    async apply(input) {
        const snapshot=parsePaymentSnapshot(input,'medsync');
        if(snapshot.revision.length>65)throw Error('BILLING_REVISION_INVALID');
        return this.db.transaction(async transaction=>{
            const rows=await this.db.query(`SELECT id_business,subscription_status,billing_revision,billing_snapshot
                FROM business WHERE id_business=:business LIMIT 1 FOR UPDATE`,
            {replacements:{business:snapshot.organizationId},type:QueryTypes.SELECT,transaction});
            const business=rows[0];
            if(!business)return {applied:false};
            const saved=business.billing_snapshot&&(typeof business.billing_snapshot==='string'?JSON.parse(business.billing_snapshot):business.billing_snapshot);
            const observed=saved?parsePaymentSnapshot(saved,'medsync',business.id_business).revision:'0';
            if(BigInt(snapshot.revision)<=BigInt(observed)||BigInt(snapshot.revision)<=BigInt(business.billing_revision||0))return {applied:false};
            // A missing/pending checkout does not consume or replace a free trial or a legacy license.
            const state=commercialState(snapshot);
            if(business.subscription_status==='pending_activation'||!managed(business)&&state.status!=='active') {
                // Keep the revision barrier even before the first paid grant, without consuming the trial.
                const [,changed]=await this.db.query('UPDATE business SET billing_snapshot=:snapshot WHERE id_business=:business',
                    {replacements:{business:business.id_business,snapshot:JSON.stringify(snapshot)},transaction,type:QueryTypes.UPDATE});
                if(changed!==1)throw Error('BILLING_PROJECTION_NOT_SAVED');
                return {applied:true};
            }
            const [,changed]=await this.db.query(`UPDATE business SET billing_snapshot=:snapshot,billing_revision=:revision,
                billing_access_until=:accessUntil,subscription_status=:status,plan=COALESCE(:plan,plan),
                current_period_ends_at=:periodEnd,
                updated_at=NOW(),updated_by='billing'
                WHERE id_business=:business AND billing_revision<CAST(:revision AS DECIMAL(65,0))`,
            {replacements:{business:business.id_business,snapshot:JSON.stringify(snapshot),revision:snapshot.revision,
                accessUntil:state.accessUntil,status:state.status,plan:state.plan,
                periodEnd:snapshot.subscription?.currentPeriodEnd?new Date(snapshot.subscription.currentPeriodEnd):null},transaction,type:QueryTypes.UPDATE});
            if(changed!==1)throw Error('BILLING_PROJECTION_NOT_SAVED');
            await enqueueContractWelcome(this.db,snapshot,transaction);
            return {applied:true};
        });
    }
}
module.exports={LicenseProjection};

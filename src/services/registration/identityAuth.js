'use strict';
const {QueryTypes}=require('sequelize');
const {normalizePhone,normalizeEmail}=require('./identity');
const enabled=()=>process.env.REGISTRATION_IDENTITY_ENABLED==='true';
async function findOwner(db, phone, {recovery=false,transaction=null,lock=false,allowExpired=false}={}) {
    const kind=String(phone || '').includes('@') ? 'email' : 'phone';
    const normalized=kind==='email' ? normalizeEmail(phone) : normalizePhone(phone);
    if(!normalized) return null;
    const rows=await db.query(`SELECT l.id_login,l.password,l.email,l.telephone FROM auth_identity i
        INNER JOIN login l ON l.id_login=i.id_login
        LEFT JOIN business b ON b.id_business=l.id_business
        WHERE i.kind=:kind AND i.normalized_value=:phone
          AND i.normalized_value=${kind==='email' ? 's24_email(l.email)' : 's24_phone(l.telephone)'}
          AND l.active=1 AND (l.id_business IS NULL OR b.status='active')
          ${kind==='phone' ? `AND (i.reservation_status='verified' OR NOT EXISTS (
            SELECT 1 FROM registration_account a WHERE a.id_login=l.id_login AND a.id_business=l.id_business))` : ''}
          ${allowExpired ? '' : 'AND (i.expires_at IS NULL OR i.expires_at>NOW(3))'}
          ${recovery ? `AND (l.password NOT LIKE 'scrypt-v1$%' OR EXISTS (SELECT 1 FROM auth_identity email_identity
            WHERE email_identity.kind='email' AND email_identity.normalized_value=s24_email(l.email)
              AND email_identity.id_login=l.id_login AND email_identity.reservation_status='verified'
              AND email_identity.verified_at IS NOT NULL))` : ''}
        LIMIT 1${lock?' FOR UPDATE':''}`, {replacements:{kind,phone:normalized},type:QueryTypes.SELECT,transaction});
    return rows[0] || null;
}
module.exports={enabled,findOwner};
// Called only after a correct password. Never reclaim another owner's identity.
module.exports.confirmLoginOwner = async (db, phone, idLogin, passwordHash) => {
    const transaction=await db.transaction();
    try {
        const row=await findOwner(db,phone,{transaction,lock:true,allowExpired:true});
        if(!row || row.id_login!==idLogin || row.password!==passwordHash) { await transaction.rollback();return false; }
        await db.query(`UPDATE auth_identity SET expires_at=DATE_ADD(NOW(3),INTERVAL 24 HOUR),updated_at=NOW(3)
            WHERE kind=:kind AND normalized_value=:phone AND id_login=:id AND reservation_status='pending' AND expires_at<=NOW(3)`,
        {replacements:{kind:String(phone || '').includes('@')?'email':'phone',phone:normalizeEmail(phone)||normalizePhone(phone),id:idLogin},transaction});
        await transaction.commit();return true;
    } catch(error) {if(!transaction.finished) await transaction.rollback();throw error;}
};

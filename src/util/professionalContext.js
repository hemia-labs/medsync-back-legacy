const { QueryTypes } = require('sequelize');
const sequelize = require('../db/Sequelize.connection');
const responseData = require('./responsedata');

async function listProfessionals(idBusiness, transaction = null) {
    return sequelize.query(`SELECT d.id_doctor_professional_profile, d.id_login,
        d.professional_name, d.professional_license, d.university, d.specialty,
        d.specialty_license, d.professional_phone, d.signature_image,
        d.can_issue_prescriptions, d.can_sign_documents
        FROM doctor_professional_profile d JOIN login l
          ON l.id_login = d.id_login AND l.id_business = d.id_business
        WHERE d.id_business = :business AND d.is_active = 1 AND l.active = 1
        ORDER BY d.professional_name, d.id_doctor_professional_profile`, {
        replacements: { business: idBusiness }, type: QueryTypes.SELECT, transaction
    });
}

async function resolveProfessional(body, requestedId, transaction = null) {
    const doctors = await listProfessionals(body.id_business, transaction);
    const selected = requestedId
        ? doctors.find(d => d.id_doctor_professional_profile === requestedId)
        : doctors.find(d => d.id_login === body.id_login) || (doctors.length === 1 ? doctors[0] : null);
    if (!selected) return { error: requestedId
        ? responseData.forbidden('Doctor no disponible para este consultorio.')
        : responseData.bad_request('Selecciona el doctor para continuar.') };
    return { doctor: selected };
}

module.exports = { listProfessionals, resolveProfessional };

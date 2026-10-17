const revisionConflict = (history, expectedRevision) => {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || Number(history.revision) !== expectedRevision) {
        return {
            status: 409,
            message: 'Esta historia cambio en otra sesion. Tu captura se conserva; revisa la version actual antes de continuar.',
            data: { code: 'HISTORY_REVISION_CONFLICT', current_revision: Number(history.revision), current_status: history.status }
        };
    }
    return null;
};

const professionalSnapshot = (profile, capturedAt = new Date().toISOString()) => ({
    id_login: profile.id_login,
    id_doctor_professional_profile: profile.id_doctor_professional_profile,
    professional_name: profile.professional_name,
    professional_license: profile.professional_license,
    specialty: profile.specialty || null,
    specialty_license: profile.specialty_license || null,
    captured_at: capturedAt,
    identity_source: 'CLOSURE_SNAPSHOT'
});

const historicalIdentityUnavailable = (userId, profileId = null) => ({
    id_login: userId || null,
    id_doctor_professional_profile: profileId || null,
    identity_source: 'LEGACY_UNVERIFIED'
});

module.exports = { revisionConflict, professionalSnapshot, historicalIdentityUnavailable };

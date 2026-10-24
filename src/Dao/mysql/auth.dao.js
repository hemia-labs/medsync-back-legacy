const effectivePermissions = require('../../util/effectivePermissions');
const { randomUUID } = require('crypto');
const Auth = require('../../models/mysql/auth.model');
const { QueryTypes } = require('sequelize');
const sequelize = require('../../db/Sequelize.connection');
const SequelizeSP = require('../../util/sequelize.sp.util');
const responseData = require('../../util/responsedata');
const Messages = require('../../util/common.messages.util');
const {SequelizeException, SQLException} = require('../../util/sequelizeException');
const token = require('../../auth/authenticate');
const mail = require('../../mail/mail')
const { compare, encript } = require('../../util/bcrypt')
const SessionDao = require('./session.Dao');
const TenantOperationalDao = require('./tenantOperational.dao');
const RefreshTokenService = require('../../services/security/refreshToken.service');
const PasswordResetTokenService = require('../../services/security/passwordResetToken.service');
const PasswordChangeTokenService = require('../../services/security/passwordChangeToken.service');
const SecurityConfig = require('../../config/security');
const {
    buildTenantOperationalData,
    buildTenantOperationalResponse,
    isBusinessOperational,
    isSuperAdminRole
} = require('../../util/businessOperational');

const getFirstRow = (result) => {
    if (!result) {
        return null;
    }

    if (Array.isArray(result)) {
        if (Array.isArray(result[0])) {
            return result[0][0] || null;
        }

        return result[0] || null;
    }

    return result;
};

const getLoginRole = async (idLogin) => {
    const result = await sequelize.query(
        `SELECT
                l.id_rol,
                l.id_business,
                l.name AS login_name,
                l.email AS login_email,
                l.telephone AS login_telephone,
                r.code,
                r.desc_rol,
                b.name AS business_name,
                b.slug AS business_slug,
                b.status AS business_status,
                b.active AS business_active,
                b.plan AS business_plan,
                b.subscription_status,
                b.trial_starts_at,
                b.trial_ends_at,
                b.current_period_starts_at,
                b.current_period_ends_at
           FROM login l
           LEFT JOIN rol r ON r.id_rol = l.id_rol
           LEFT JOIN business b ON b.id_business = l.id_business
          WHERE l.id_login = :_id_login
          LIMIT 1`,
        {
            replacements: { _id_login: idLogin },
            type: QueryTypes.SELECT
        }
    );

    return result && result.length > 0 ? result[0] : null;
};

const affectedRows = (result) => {
    if (Array.isArray(result)) {
        const metadata = result[1];
        if (metadata && typeof metadata === 'object' && metadata.affectedRows !== undefined) {
            return Number(metadata.affectedRows || 0);
        }
        return Number(result[1] || result[0] || 0);
    }

    return Number(result || 0);
};

const normalizeClientIp = (value) => {
    const normalized = String(value || '').trim();
    return normalized ? normalized.slice(0, 64) : null;
};

const normalizeUserAgent = (value) => {
    const normalized = String(value || '').trim();
    return normalized ? normalized.slice(0, 255) : null;
};

const withSecurityEvent = (response, securityEvent) => {
    if (response && securityEvent) {
        response.securityEvent = securityEvent;
    }

    return response;
};

const getLoginByPhone = async (phone) => {
    if (!phone) {
        return null;
    }

    const result = await sequelize.query(
        `SELECT id_login
           FROM login
          WHERE telephone COLLATE utf8mb4_unicode_ci = :_phone COLLATE utf8mb4_unicode_ci
          LIMIT 1`,
        {
            replacements: { _phone: phone },
            type: QueryTypes.SELECT
        }
    );

    return result && result.length > 0 ? result[0] : null;
};

const getLoginRecoveryAccountByPhone = async (phone) => {
    if (!phone) {
        return null;
    }

    const result = await sequelize.query(
        `SELECT
                id_login,
                email,
                telephone
           FROM login
          WHERE telephone COLLATE utf8mb4_unicode_ci = :_phone COLLATE utf8mb4_unicode_ci
            AND active = 1
          LIMIT 1`,
        {
            replacements: { _phone: phone },
            type: QueryTypes.SELECT
        }
    );

    return result && result.length > 0 ? result[0] : null;
};

const revokeActivePasswordResetTokens = async (idLogin, options = {}) => {
    if (!idLogin) {
        return 0;
    }

    const result = await sequelize.query(
        `UPDATE auth_password_reset_tokens
            SET status = 'revoked',
                revoked_at = COALESCE(revoked_at, NOW()),
                updated_at = NOW()
          WHERE id_login COLLATE utf8mb4_unicode_ci = :_id_login COLLATE utf8mb4_unicode_ci
            AND purpose = :_purpose
            AND status IN ('pending', 'verified')`,
        {
            replacements: {
                _id_login: idLogin,
                _purpose: PasswordResetTokenService.PURPOSE
            },
            type: QueryTypes.UPDATE,
            transaction: options.transaction || null
        }
    );

    return affectedRows(result);
};

const createPasswordResetChallenge = async (account, phone, metadata = {}) => {
    const tokenRecord = PasswordResetTokenService.buildCodeRecord(phone);
    const emailFingerprint = PasswordResetTokenService.fingerprintEmail(account.email);

    await sequelize.query(
        `INSERT INTO auth_password_reset_tokens (
            id_login,
            phone_normalized,
            destination_email_fingerprint,
            code_hash,
            code_fingerprint,
            purpose,
            status,
            attempts,
            max_attempts,
            issued_at,
            expires_at,
            requested_ip,
            requested_user_agent,
            created_at,
            updated_at
        ) VALUES (
            :_id_login,
            :_phone_normalized,
            :_destination_email_fingerprint,
            :_code_hash,
            :_code_fingerprint,
            :_purpose,
            'pending',
            0,
            :_max_attempts,
            NOW(),
            DATE_ADD(NOW(), INTERVAL :_ttl_minutes MINUTE),
            :_requested_ip,
            :_requested_user_agent,
            NOW(),
            NOW()
        )`,
        {
            replacements: {
                _id_login: account.id_login,
                _phone_normalized: phone,
                _destination_email_fingerprint: emailFingerprint,
                _code_hash: tokenRecord.code_hash,
                _code_fingerprint: tokenRecord.code_fingerprint,
                _purpose: PasswordResetTokenService.PURPOSE,
                _max_attempts: tokenRecord.max_attempts,
                _ttl_minutes: SecurityConfig.getPasswordResetCodeTtlMinutes(),
                _requested_ip: normalizeClientIp(metadata.ip),
                _requested_user_agent: normalizeUserAgent(metadata.userAgent)
            },
            type: QueryTypes.INSERT
        }
    );

    return tokenRecord;
};

const getLatestPasswordResetChallenge = async (phone, statuses, transaction = null) => {
    const result = await sequelize.query(
        `SELECT
                id,
                id_login,
                phone_normalized,
                destination_email_fingerprint,
                code_hash,
                code_fingerprint,
                purpose,
                status,
                attempts,
                max_attempts,
                expires_at
           FROM auth_password_reset_tokens
          WHERE phone_normalized = :_phone_normalized
            AND purpose = :_purpose
            AND status IN (:_statuses)
          ORDER BY issued_at DESC, id DESC
          LIMIT 1`,
        {
            replacements: {
                _phone_normalized: phone,
                _purpose: PasswordResetTokenService.PURPOSE,
                _statuses: statuses
            },
            type: QueryTypes.SELECT,
            transaction
        }
    );

    return result && result.length > 0 ? result[0] : null;
};

const markPasswordResetChallenge = async (id, status, fields = {}, transaction = null) => {
    const statusTimestamps = {
        expired: 'expired_at',
        locked: 'locked_at',
        used: 'used_at',
        revoked: 'revoked_at',
        verified: 'verified_at'
    };
    const timestampColumn = statusTimestamps[status];
    const setters = ['status = :_status', 'updated_at = NOW()'];
    const replacements = {
        _id: id,
        _status: status
    };

    if (timestampColumn) {
        setters.push(`${timestampColumn} = COALESCE(${timestampColumn}, NOW())`);
    }

    if (fields.attempts !== undefined) {
        setters.push('attempts = :_attempts');
        replacements._attempts = fields.attempts;
    }

    const result = await sequelize.query(
        `UPDATE auth_password_reset_tokens
            SET ${setters.join(', ')}
          WHERE id = :_id`,
        {
            replacements,
            type: QueryTypes.UPDATE,
            transaction
        }
    );

    return affectedRows(result);
};

const getPasswordResetAccountById = async (idLogin, transaction = null) => {
    const result = await sequelize.query(
        `SELECT
                id_login,
                email,
                telephone
           FROM login
          WHERE id_login COLLATE utf8mb4_unicode_ci = :_id_login COLLATE utf8mb4_unicode_ci
            AND active = 1
          LIMIT 1`,
        {
            replacements: { _id_login: idLogin },
            type: QueryTypes.SELECT,
            transaction
        }
    );

    return result && result.length > 0 ? result[0] : null;
};

const getLoginAuthRow = async (idLogin) => {
    if (!idLogin) {
        return null;
    }

    const result = await sequelize.query(
        `SELECT
                l.id_login,
                l.email,
                l.telephone,
                l.name,
                l.active,
                l.id_business
           FROM login l
          WHERE l.id_login COLLATE utf8mb4_unicode_ci = :_id_login COLLATE utf8mb4_unicode_ci
            AND l.active = 1
          LIMIT 1`,
        {
            replacements: { _id_login: idLogin },
            type: QueryTypes.SELECT
        }
    );

    return result && result.length > 0 ? result[0] : null;
};

const insertRefreshTokenRecord = async ({
    idLogin,
    idSession,
    familyId = null,
    parentTokenHash = null,
    metadata = {},
    transaction = null
}) => {
    const tokenData = RefreshTokenService.createRefreshToken({ familyId });
    const issuedAt = new Date();
    const expiresAt = RefreshTokenService.getExpiresAt(issuedAt);

    await sequelize.query(
        `INSERT INTO refresh_token (
            id_refresh_token,
            id_login,
            id_session,
            token_hash,
            token_fingerprint,
            family_id,
            parent_token_hash,
            issued_at,
            expires_at,
            \`last\`,
            created_at,
            created_by,
            created_ip,
            created_user_agent
        ) VALUES (
            :_id_refresh_token,
            :_id_login,
            :_id_session,
            :_token_hash,
            :_token_fingerprint,
            :_family_id,
            :_parent_token_hash,
            :_issued_at,
            :_expires_at,
            1,
            :_created_at,
            :_created_by,
            :_created_ip,
            :_created_user_agent
        )`,
        {
            replacements: {
                _id_refresh_token: tokenData.tokenId,
                _id_login: idLogin,
                _id_session: idSession,
                _token_hash: tokenData.tokenHash,
                _token_fingerprint: tokenData.tokenFingerprint,
                _family_id: tokenData.familyId,
                _parent_token_hash: parentTokenHash,
                _issued_at: issuedAt,
                _expires_at: expiresAt,
                _created_at: issuedAt,
                _created_by: idLogin,
                _created_ip: normalizeClientIp(metadata.ip),
                _created_user_agent: normalizeUserAgent(metadata.userAgent)
            },
            type: QueryTypes.INSERT,
            transaction
        }
    );

    return tokenData;
};

const revokeRefreshTokens = async (idLogin, options = {}) => {
    if (!idLogin) {
        return 0;
    }

    const where = [
        'id_login COLLATE utf8mb4_unicode_ci = :_id_login COLLATE utf8mb4_unicode_ci'
    ];
    const replacements = {
        _id_login: idLogin,
        _reason: options.reason || 'revoked'
    };

    if (options.idSession) {
        where.push('id_session COLLATE utf8mb4_unicode_ci = :_id_session COLLATE utf8mb4_unicode_ci');
        replacements._id_session = options.idSession;
    }

    if (options.idRefreshToken) {
        where.push('id_refresh_token COLLATE utf8mb4_unicode_ci = :_id_refresh_token COLLATE utf8mb4_unicode_ci');
        replacements._id_refresh_token = options.idRefreshToken;
    }

    if (options.familyId) {
        where.push('family_id COLLATE utf8mb4_unicode_ci = :_family_id COLLATE utf8mb4_unicode_ci');
        replacements._family_id = options.familyId;
    }

    const result = await sequelize.query(
        `UPDATE refresh_token
            SET \`last\` = 0,
                revoked_at = COALESCE(revoked_at, NOW()),
                revoked_reason = COALESCE(revoked_reason, :_reason)
          WHERE ${where.join(' AND ')}
            AND (\`last\` = 1 OR revoked_at IS NULL)`,
        {
            replacements,
            type: QueryTypes.UPDATE,
            transaction: options.transaction || null
        }
    );

    return affectedRows(result);
};

const markRefreshTokenRotated = async (row, transaction) => {
    const result = await sequelize.query(
        `UPDATE refresh_token
            SET \`last\` = 0,
                rotated_at = NOW(),
                revoked_at = COALESCE(revoked_at, NOW()),
                revoked_reason = COALESCE(revoked_reason, 'rotated')
          WHERE id_refresh_token COLLATE utf8mb4_unicode_ci = :_id_refresh_token COLLATE utf8mb4_unicode_ci
            AND token_hash = :_token_hash
            AND \`last\` = 1
            AND revoked_at IS NULL
            AND rotated_at IS NULL`,
        {
            replacements: {
                _id_refresh_token: row.id_refresh_token,
                _token_hash: row.token_hash
            },
            type: QueryTypes.UPDATE,
            transaction
        }
    );

    return affectedRows(result);
};

const revokeSessionsForRefreshReuse = async (row, transaction) => {
    const scope = SecurityConfig.getRefreshTokenReuseRevokeScope();

    if (scope === 'family') {
        return;
    }

    const byUser = scope === 'user';
    const result = await sequelize.query(
        `UPDATE \`session\`
            SET active = 0,
                \`last\` = 0,
                forze_by = :_id_login,
                forze_at = NOW(),
                updated_by = :_id_login,
                updated_at = NOW()
          WHERE id_login COLLATE utf8mb4_unicode_ci = :_id_login COLLATE utf8mb4_unicode_ci
            AND (:_by_user = 1 OR id_session COLLATE utf8mb4_unicode_ci = :_id_session COLLATE utf8mb4_unicode_ci)
            AND (active = 1 OR \`last\` = 1)`,
        {
            replacements: {
                _id_login: row.id_login,
                _id_session: row.id_session || '',
                _by_user: byUser ? 1 : 0
            },
            type: QueryTypes.UPDATE,
            transaction
        }
    );

    return affectedRows(result);
};

const handleRefreshTokenReuse = async (row, tokenFingerprint) => {
    const transaction = await sequelize.transaction();
    try {
        await sequelize.query(
            `UPDATE refresh_token
                SET \`last\` = 0,
                    reused_at = COALESCE(reused_at, NOW()),
                    revoked_at = COALESCE(revoked_at, NOW()),
                    revoked_reason = COALESCE(revoked_reason, 'reuse_detected')
              WHERE id_refresh_token COLLATE utf8mb4_unicode_ci = :_id_refresh_token COLLATE utf8mb4_unicode_ci`,
            {
                replacements: {
                    _id_refresh_token: row.id_refresh_token
                },
                type: QueryTypes.UPDATE,
                transaction
            }
        );

        if (row.family_id) {
            await revokeRefreshTokens(row.id_login, {
                familyId: row.family_id,
                reason: 'reuse_detected_family',
                transaction
            });
        }

        await revokeSessionsForRefreshReuse(row, transaction);
        await transaction.commit();
    } catch (error) {
        await transaction.rollback();
        throw error;
    }

    return withSecurityEvent(
        responseData.unauthorized(Messages.AUTH_NOT_FOUND),
        {
            event: 'auth.refresh.reused_detected',
            id_login: row.id_login,
            id_session: row.id_session || null,
            token_fingerprint: tokenFingerprint || row.token_fingerprint || null,
            revoke_scope: SecurityConfig.getRefreshTokenReuseRevokeScope()
        }
    );
};

const getRolePermissions = async (idLogin) => effectivePermissions.rows(idLogin);

const buildAuthPayload = async (authRow, fallbackIdLogin) => {
    const idLogin = authRow.id_login || fallbackIdLogin;
    const role = await getLoginRole(idLogin);
    const permissionRows = await getRolePermissions(idLogin);
    const permissions = permissionRows.map((item) => item.code);

    return {
        tokenData: {
            email: authRow.email || authRow.login_email || (role && role.login_email ? role.login_email : null),
            name: authRow.name || authRow.login_name || (role && role.login_name ? role.login_name : null),
            telephone: authRow.telephone || authRow.login_telephone || (role && role.login_telephone ? role.login_telephone : null),
            id_login: idLogin,
            id_rol: role && role.id_rol ? role.id_rol : null,
            rol: role && role.code ? role.code : null,
            role_name: role && role.desc_rol ? role.desc_rol : null,
            id_business: role && role.id_business ? role.id_business : null,
            id_session: authRow.id_session || null,
            business_name: role && role.business_name ? role.business_name : null,
            business_slug: role && role.business_slug ? role.business_slug : null,
            business_status: role && role.business_status ? role.business_status : null,
            business_subscription_status: role && role.subscription_status ? role.subscription_status : null
        },
        permissions,
        business: role ? {
            id_business: role.id_business || null,
            name: role.business_name || null,
            slug: role.business_slug || null,
            active: role.business_active,
            status: role.business_status,
            subscription_status: role.subscription_status,
            plan: role.business_plan || null,
            trial_starts_at: role.trial_starts_at,
            trial_ends_at: role.trial_ends_at,
            current_period_starts_at: role.current_period_starts_at,
            current_period_ends_at: role.current_period_ends_at
        } : null
    };
};

const tenantForbidden = (result) => ({
    status: 403,
    ...buildTenantOperationalResponse(result)
});

const invalidateAuthArtifacts = async (idLogin, idSession = null, idRefreshToken = null, transaction = null) => {
    if (!idLogin) {
        return;
    }

    await sequelize.query(
        `UPDATE \`session\`
            SET active = 0,
                \`last\` = 0,
                updated_at = NOW(),
                updated_by = :_id_login
          WHERE id_login = :_id_login
            AND (:_id_session IS NULL OR id_session = :_id_session)
            AND (active = 1 OR \`last\` = 1)`,
        {
            replacements: {
                _id_login: idLogin,
                _id_session: idSession
            },
            type: QueryTypes.UPDATE,
            transaction
        }
    );

    await revokeRefreshTokens(idLogin, {
        idSession,
        idRefreshToken,
        reason: idSession ? 'session_invalidated' : 'user_invalidated',
        transaction
    });
};

const invalidateOtherAuthArtifacts = async (idLogin, currentSessionId, transaction = null) => {
    if (!idLogin || !currentSessionId) {
        return;
    }

    await sequelize.query(
        `UPDATE \`session\`
            SET active = 0,
                \`last\` = 0,
                updated_at = NOW(),
                updated_by = :_id_login
          WHERE id_login COLLATE utf8mb4_unicode_ci = :_id_login COLLATE utf8mb4_unicode_ci
            AND id_session COLLATE utf8mb4_unicode_ci <> :_current_session COLLATE utf8mb4_unicode_ci
            AND (active = 1 OR \`last\` = 1)`,
        {
            replacements: { _id_login: idLogin, _current_session: currentSessionId },
            type: QueryTypes.UPDATE,
            transaction
        }
    );

    await sequelize.query(
        `UPDATE refresh_token
            SET \`last\` = 0,
                revoked_at = COALESCE(revoked_at, NOW()),
                revoked_reason = COALESCE(revoked_reason, 'password_changed')
          WHERE id_login COLLATE utf8mb4_unicode_ci = :_id_login COLLATE utf8mb4_unicode_ci
            AND (id_session IS NULL OR id_session COLLATE utf8mb4_unicode_ci <> :_current_session COLLATE utf8mb4_unicode_ci)
            AND (\`last\` = 1 OR revoked_at IS NULL)`,
        {
            replacements: { _id_login: idLogin, _current_session: currentSessionId },
            type: QueryTypes.UPDATE,
            transaction
        }
    );
};

const getTenantAuthenticationState = async (authPayload, idLogin, idSession = null, idRefreshToken = null) => {
    const tokenData = authPayload ? authPayload.tokenData : null;

    if (!tokenData || isSuperAdminRole(tokenData.rol)) {
        return {
            block: null,
            tenantOperational: null
        };
    }

    if (!tokenData.id_business) {
        await invalidateAuthArtifacts(idLogin, idSession, idRefreshToken);
        return {
            block: tenantForbidden({
                code: 'TENANT_REQUIRED',
                message: 'No hay negocio asociado a la sesion.'
            }),
            tenantOperational: null
        };
    }

    const business = await TenantOperationalDao.getBusiness(tokenData.id_business);
    const result = isBusinessOperational(business);

    return {
        block: null,
        tenantOperational: buildTenantOperationalData(result),
        tenantOperationalMessage: result.message || null
    };
};

const buildAuthResponseForSession = async (idLogin, idSession, refreshToken = null) => {
    const activeSession = await SessionDao.checkActiveSession(idLogin, idSession);
    if (!activeSession) {
        return responseData.notSuccess(Messages.DATA_GET_ERROR);
    }

    const authRow = await getLoginAuthRow(idLogin);
    if (!authRow) {
        return responseData.notSuccess(Messages.AUTH_NOT_FOUND);
    }

    authRow.id_session = idSession;
    const authPayload = await buildAuthPayload(authRow, idLogin);
    const tenantState = await getTenantAuthenticationState(
        authPayload,
        idLogin,
        idSession,
        null
    );

    if (tenantState.block) {
        return tenantState.block;
    }

    const accessToken = token.GetAccessToken(authPayload.tokenData);

    return responseData.success({
        token: accessToken.token,
        refresh_token: refreshToken,
        permisos: authPayload.permissions,
        business: authPayload.business,
        tenantOperational: tenantState.tenantOperational,
        tenantOperationalMessage: tenantState.tenantOperationalMessage || null
    }, Messages.DATA_GET_SUCCESSFULLY);
};

const getRefreshTokenRecordById = async (tokenId) => {
    const result = await sequelize.query(
        `SELECT
            id_refresh_token,
            id_login,
            id_session,
            token_hash,
            token_fingerprint,
            family_id,
            parent_token_hash,
            expires_at,
            rotated_at,
            revoked_at,
            revoked_reason,
            reused_at,
            \`last\`
           FROM refresh_token
          WHERE id_refresh_token COLLATE utf8mb4_unicode_ci = :_id_refresh_token COLLATE utf8mb4_unicode_ci
          LIMIT 1`,
        {
            replacements: {
                _id_refresh_token: tokenId
            },
            type: QueryTypes.SELECT
        }
    );

    return result && result.length > 0 ? result[0] : null;
};

const refreshWithV2Token = async (rawRefreshToken, metadata = {}) => {
    const parsed = RefreshTokenService.parseRefreshToken(rawRefreshToken);
    if (!parsed) {
        return null;
    }

    const row = await getRefreshTokenRecordById(parsed.tokenId);
    if (!row || !row.token_hash || row.token_hash !== parsed.tokenHash) {
        return responseData.notSuccess(Messages.AUTH_NOT_FOUND);
    }

    if (row.rotated_at || row.reused_at) {
        return handleRefreshTokenReuse(row, parsed.tokenFingerprint);
    }

    if (row.revoked_at || Number(row.last) !== 1) {
        return responseData.notSuccess(Messages.AUTH_NOT_FOUND);
    }

    if (RefreshTokenService.isExpired(row.expires_at)) {
        await revokeRefreshTokens(row.id_login, {
            idRefreshToken: row.id_refresh_token,
            reason: 'expired'
        });
        return responseData.notSuccess(Messages.AUTH_NOT_FOUND);
    }

    if (!row.id_session) {
        await revokeRefreshTokens(row.id_login, {
            idRefreshToken: row.id_refresh_token,
            reason: 'missing_session_binding'
        });
        return responseData.notSuccess(Messages.AUTH_NOT_FOUND);
    }

    const response = await buildAuthResponseForSession(row.id_login, row.id_session, null);
    if (!response || Number(response.status) < 200 || Number(response.status) >= 300) {
        return response;
    }

    const transaction = await sequelize.transaction();
    try {
        const nextToken = await insertRefreshTokenRecord({
            idLogin: row.id_login,
            idSession: row.id_session,
            familyId: row.family_id || null,
            parentTokenHash: row.token_hash,
            metadata,
            transaction
        });

        const rotated = await markRefreshTokenRotated(row, transaction);
        if (!rotated) {
            await transaction.rollback();
            return responseData.notSuccess(Messages.AUTH_NOT_FOUND);
        }

        await transaction.commit();
        response.data.refresh_token = nextToken.rawToken;
        response.securityEvent = {
            event: 'auth.refresh.success',
            token_version: 'v2',
            token_fingerprint: nextToken.tokenFingerprint,
            rotated: true
        };
        return response;
    } catch (error) {
        await transaction.rollback();
        throw error;
    }
};

const refreshWithLegacyToken = async (rawRefreshToken, metadata = {}) => {
    const result = await sequelize.query(
        `SELECT id_refresh_token, id_login
           FROM refresh_token
          WHERE id_refresh_token COLLATE utf8mb4_unicode_ci = :_refresh_token COLLATE utf8mb4_unicode_ci
            AND \`last\` = 1
            AND (token_hash IS NULL OR token_hash = '')
          LIMIT 1`,
        {
            replacements: {
                _refresh_token: rawRefreshToken
            },
            type: QueryTypes.SELECT
        }
    );

    if (!result || !result.length) {
        return responseData.notSuccess(Messages.AUTH_NOT_FOUND);
    }

    const legacyRow = result[0];
    const idSession = await SessionDao.getActiveSession(legacyRow.id_login);
    if (!idSession) {
        await revokeRefreshTokens(legacyRow.id_login, {
            idRefreshToken: legacyRow.id_refresh_token,
            reason: 'legacy_without_active_session'
        });
        return responseData.notSuccess(Messages.AUTH_NOT_FOUND);
    }

    const response = await buildAuthResponseForSession(legacyRow.id_login, idSession, null);
    if (!response || Number(response.status) < 200 || Number(response.status) >= 300) {
        return response;
    }

    const transaction = await sequelize.transaction();
    try {
        const nextToken = await insertRefreshTokenRecord({
            idLogin: legacyRow.id_login,
            idSession,
            metadata,
            transaction
        });

        await revokeRefreshTokens(legacyRow.id_login, {
            idRefreshToken: legacyRow.id_refresh_token,
            reason: 'legacy_migrated',
            transaction
        });

        await transaction.commit();
        response.data.refresh_token = nextToken.rawToken;
        response.securityEvent = {
            event: 'auth.refresh.legacy_migrated',
            token_version: 'legacy_to_v2',
            token_fingerprint: nextToken.tokenFingerprint,
            rotated: true
        };
        return response;
    } catch (error) {
        await transaction.rollback();
        throw error;
    }
};

/**
 * Clase principal
 */
class AuthDao{

    /**
     * Permite obtener la lista de roles
     * @returns Lista de paises
     */
    async login(body, metadata = {}) {
        let response;        
        try {
            let result = await sequelize.query(SequelizeSP.SP_LOGIN_BY_TELEPHONE, {
                replacements: {
                    _param : body.param
                },
                plain: true,
                type: QueryTypes.RAW
            });

            if(result){/*Validamos si existe un registro de salida */
                let SQLValid = SQLException(result);
                if(SQLValid.hasError) response = responseData.notSuccess(Messages.AUTH_NOT_FOUND);
                else{
                    // let cadena = await encript(body.pwd);
                    const match = await compare(body.pwd,result[0].password);
                    // console.log(cadena);

                    if( !match){
                        response = responseData.notSuccess(Messages.PASSWORD_NOT_FOUND);
                    }
                    else{
                        const keepSession = body.refresh === true;
                        let resultAuth = await sequelize.query(SequelizeSP.SP_LOGIN_BY_ID_LOGIN, {
                            replacements: {
                                _id_login : result[0].id_login,
                                _refresh : false
                            },
                            plain: true,
                            type: QueryTypes.SELECT
                        });

                        const authRow = getFirstRow(resultAuth);
                        if(authRow){/*Validamos si existe un registro de salida */
                        let SQLValidAuth = SQLException(resultAuth);
                        if(SQLValidAuth.hasError) response = responseData.notSuccess(Messages.AUTH_NOT_FOUND);
                        else{
                            authRow.id_session = await SessionDao.getActiveSession(result[0].id_login);
                            if(!authRow.id_session) {
                                response = responseData.notSuccess(Messages.DATA_GET_ERROR);
                                return response;
                            }

                            const authPayload = await buildAuthPayload(authRow, result[0].id_login);
                            const tenantState = await getTenantAuthenticationState(
                                authPayload,
                                result[0].id_login,
                                authRow.id_session,
                                null
                            );

                            if (tenantState.block) {
                                response = tenantState.block;
                                return response;
                            }

                            const refreshToken = keepSession
                                ? (await insertRefreshTokenRecord({
                                    idLogin: result[0].id_login,
                                    idSession: authRow.id_session,
                                    metadata
                                })).rawToken
                                : null;
        
                            let auth = token.GetAccessToken(authPayload.tokenData);
        
                            let res = {
                                token : auth.token,
                                refresh_token : refreshToken,
                                permisos : authPayload.permissions,
                                tenantOperational: tenantState.tenantOperational,
                                tenantOperationalMessage: tenantState.tenantOperationalMessage || null
                                // headers : {
                                //     hsec : auth.token
                                // }
                            };
        
                            response = responseData.success(res, Messages.DATA_GET_SUCCESSFULLY)
                         }

                        }else{
                            response = responseData.notSuccess(Messages.DATA_GET_ERROR);
                        }                     
                    }
                }
            }
            else{/* regresamos una excepción controlada al no obtener una respuesta */
                response = responseData.notSuccess(Messages.DATA_GET_ERROR);
            }
        } catch (error) {
                response = SequelizeException(error, Messages.DATA_GET_ERROR);
        }
        return response;
    }


    /**
     * Permite el refresh token
     * @returns Lista de paises
     */
    async refreshToken(body, metadata = {}) {
        let response;        
        try {
            const requestedRefreshToken = body ? (body.id_refresh_token || body.refresh_token) : null;

            if (!requestedRefreshToken) {
                return responseData.unauthorized(Messages.AUTH_NOT_FOUND);
            }

            const v2Response = await refreshWithV2Token(requestedRefreshToken, metadata);
            return v2Response || await refreshWithLegacyToken(requestedRefreshToken, metadata);

            if(result && result.length){/*Validamos si existe un registro de salida */
                let SQLValid = SQLException(result);
                if(SQLValid.hasError) response = responseData.notSuccess(Messages.AUTH_NOT_FOUND);
                else{
                    
                    let resultAuth = await sequelize.query(SequelizeSP.SP_LOGIN_BY_ID_LOGIN, {
                        replacements: {
                            _id_login : result[0].id_login,
                            _refresh : true
                        },
                        plain: true,
                        type: QueryTypes.SELECT
                    });

                    const authRow = getFirstRow(resultAuth);
                    if(authRow){/*Validamos si existe un registro de salida */
                    let SQLValidAuth = SQLException(resultAuth);
                    if(SQLValidAuth.hasError) response = responseData.notSuccess(Messages.AUTH_NOT_FOUND);
                    else{
                        authRow.id_session = await SessionDao.getActiveSession(result[0].id_login);
                        if(!authRow.id_session) {
                            response = responseData.notSuccess(Messages.DATA_GET_ERROR);
                            return response;
                        }

                        const authPayload = await buildAuthPayload(authRow, result[0].id_login);
                        const tenantState = await getTenantAuthenticationState(
                            authPayload,
                            result[0].id_login,
                            authRow.id_session,
                            null
                        );

                        if (tenantState.block) {
                            response = tenantState.block;
                            return response;
                        }

                        const refreshToken = null;
                        if (!refreshToken) {
                            response = responseData.notSuccess(Messages.AUTH_NOT_FOUND);
                            return response;
                        }
    
                        let auth = token.GetAccessToken(authPayload.tokenData);
    
                        let res = {
                            token : auth.token,
                            refresh_token : refreshToken,
                            permisos : authPayload.permissions,
                            tenantOperational: tenantState.tenantOperational,
                            tenantOperationalMessage: tenantState.tenantOperationalMessage || null
                        };
    
                        response = responseData.success(res, Messages.DATA_GET_SUCCESSFULLY)
                     }

                    }else{
                        response = responseData.bad_request(Messages.DATA_GET_ERROR);
                    }
                 
                }
            }
            else{/* regresamos una excepción controlada al no obtener una respuesta */
                response = responseData.notSuccess(Messages.DATA_GET_ERROR);
            }
        } catch (error) {
                response = SequelizeException(error, Messages.DATA_GET_ERROR);
        }
        return response;
    }


    async session(body) {
        try {
            if (!body || !body.id_login || !body.id_session) {
                return responseData.unauthorized(Messages.AUTH_NOT_FOUND);
            }

            return await buildAuthResponseForSession(body.id_login, body.id_session, null);
        } catch (error) {
            return SequelizeException(error, Messages.DATA_GET_ERROR);
        }
    }


    /**
     * Permite cerrar  una sesión
     * @returns Lista de paises
     */
    async close(body) {
        let response;        
        try {
            if (!body.id_session) {
                await invalidateAuthArtifacts(body.id_login);
                return responseData.success({ success: true }, Messages.DATA_GET_SUCCESSFULLY);
            }

            await sequelize.query(
                `UPDATE \`session\`
                    SET active = 0,
                        \`last\` = 0,
                        forze_by = :_id_login,
                        forze_at = NOW(),
                        updated_by = :_id_login,
                        updated_at = NOW()
                  WHERE id_login COLLATE utf8mb4_unicode_ci = :_id_login COLLATE utf8mb4_unicode_ci
                    AND id_session COLLATE utf8mb4_unicode_ci = :_id_session COLLATE utf8mb4_unicode_ci
                    AND (active = 1 OR \`last\` = 1)`,
                {
                    replacements: {
                        _id_login: body.id_login,
                        _id_session: body.id_session
                    },
                    type: QueryTypes.UPDATE
                }
            );

            await revokeRefreshTokens(body.id_login, {
                idSession: body.id_session,
                reason: 'logout'
            });

            return responseData.success({ success: true }, Messages.DATA_GET_SUCCESSFULLY);

            let date = new Date();
            let result = await sequelize.query(SequelizeSP.SP_LOGIN_CLOSE, {
                replacements: {
                    _id_login : body.id_login
                },
                type: QueryTypes.RAW,
                plain: true
            });

            if(result){/*Validamos si existe un registro de salida */
                let SQLValid = SQLException(result);
                response =  !SQLValid.hasError ? responseData.success(result[0], Messages.DATA_GET_SUCCESSFULLY) : responseData.notSuccess(Messages.DATA_GET_ERROR);
            }
            else{/* regresamos una excepción controlada al no obtener una respuesta */
                response = responseData.notSuccess(Messages.DATA_SAVE_ERROR)    
            }
        } catch (error) {
                response = SequelizeException(error, Messages.DATA_SAVE_ERROR);
        }
        return response;
    }

    /**
     * Permite cerrar de manera forzada una sesión
     * @returns Lista de paises
     */
    async forze_close(body) {
        let response;        
        try {
            let date = new Date();
            let result = await sequelize.query(SequelizeSP.SP_LOGIN_FORZE_CLOSE, {
                replacements: {
                    _id_user : body.id_login,
                    _date : date.toISOString(),
                    _userClose : body.userClose
                },
                type: QueryTypes.RAW,
                plain: true
            });

            if(result){/*Validamos si existe un registro de salida */
                let SQLValid = SQLException(result);
                response =  !SQLValid.hasError ? responseData.success(result[0], Messages.DATA_GET_SUCCESSFULLY) : responseData.notSuccess(Messages.DATA_GET_ERROR);
            }
            else{/* regresamos una excepción controlada al no obtener una respuesta */
                response = responseData.notSuccess(Messages.DATA_SAVE_ERROR)    
            }
        } catch (error) {
                response = SequelizeException(error, Messages.DATA_SAVE_ERROR);
        }
        return response;
    }

    async sendOtpRecoverPassword(phone, metadata = {}) {
        try {
            const account = await getLoginRecoveryAccountByPhone(phone);

            if (!account || !account.email) {
                return withSecurityEvent(
                    responseData.success({ sent: true }, Messages.DATA_SAVE_SUCCESSFULLY),
                    {
                        event: 'auth.password_reset.requested',
                        account_found: Boolean(account),
                        email_available: Boolean(account && account.email)
                    }
                );
            }

            if (SecurityConfig.shouldRevokePreviousPasswordResetCodes()) {
                await revokeActivePasswordResetTokens(account.id_login);
            }

            const tokenRecord = await createPasswordResetChallenge(account, phone, metadata);
            const sendMail = await mail.SendPasswordResetCode(account.email, {
                code: tokenRecord.code,
                ttlMinutes: SecurityConfig.getPasswordResetCodeTtlMinutes()
            });

            if (!sendMail || !sendMail.process) {
                await sequelize.query(
                    `UPDATE auth_password_reset_tokens
                        SET status = 'revoked',
                            revoked_at = COALESCE(revoked_at, NOW()),
                            updated_at = NOW()
                      WHERE code_hash = :_code_hash
                        AND status = 'pending'`,
                    {
                        replacements: { _code_hash: tokenRecord.code_hash },
                        type: QueryTypes.UPDATE
                    }
                );

                return withSecurityEvent(
                    responseData.success({ sent: true }, Messages.DATA_SAVE_SUCCESSFULLY),
                    {
                        event: 'auth.password_reset.email_failed',
                        account_found: true,
                        email_fingerprint: PasswordResetTokenService.fingerprintEmail(account.email),
                        code_fingerprint: tokenRecord.code_fingerprint
                    }
                );
            }

            return withSecurityEvent(
                responseData.success({ sent: true }, Messages.DATA_SAVE_SUCCESSFULLY),
                {
                    event: 'auth.password_reset.requested',
                    account_found: true,
                    email_fingerprint: PasswordResetTokenService.fingerprintEmail(account.email),
                    email_masked: PasswordResetTokenService.maskEmail(account.email),
                    code_fingerprint: tokenRecord.code_fingerprint,
                    expires_at: tokenRecord.expires_at
                }
            );
        } catch (error) {
            return SequelizeException(error, Messages.DATA_GET_ERROR);
        }

    }



/**
 * Permite validar la existencia de un otp
 * @returns Lista de paises
 */
async validateOtp(body) {
    try {
        const phone = body.telephone || body.phone;
        const code = body.code || body.otp;
        const challenge = await getLatestPasswordResetChallenge(phone, ['pending']);

        if (!challenge) {
            return withSecurityEvent(
                responseData.notSuccess(Messages.DATA_GET_ERROR),
                {
                    event: 'auth.password_reset.code_failed',
                    reason: 'not_found'
                }
            );
        }

        if (PasswordResetTokenService.isExpired(challenge.expires_at)) {
            await markPasswordResetChallenge(challenge.id, 'expired');
            return withSecurityEvent(
                responseData.notSuccess(Messages.DATA_GET_ERROR),
                {
                    event: 'auth.password_reset.code_expired',
                    code_fingerprint: challenge.code_fingerprint
                }
            );
        }

        const candidateHash = PasswordResetTokenService.hashCode(phone, code);
        const matches = PasswordResetTokenService.safeCompareHash(candidateHash, challenge.code_hash);

        if (!matches) {
            const attempts = Number(challenge.attempts || 0) + 1;
            const maxAttempts = Number(challenge.max_attempts || SecurityConfig.getPasswordResetMaxAttempts());

            if (attempts >= maxAttempts) {
                await markPasswordResetChallenge(challenge.id, 'locked', { attempts });
                return withSecurityEvent(
                    responseData.notSuccess(Messages.DATA_GET_ERROR),
                    {
                        event: 'auth.password_reset.code_locked',
                        code_fingerprint: challenge.code_fingerprint,
                        attempts,
                        max_attempts: maxAttempts
                    }
                );
            }

            await markPasswordResetChallenge(challenge.id, 'pending', { attempts });
            return withSecurityEvent(
                responseData.notSuccess(Messages.DATA_GET_ERROR),
                {
                    event: 'auth.password_reset.code_failed',
                    code_fingerprint: challenge.code_fingerprint,
                    attempts,
                    max_attempts: maxAttempts
                }
            );
        }

        await markPasswordResetChallenge(challenge.id, 'verified');

        return withSecurityEvent(
            responseData.success({ verified: true }, Messages.DATA_GET_SUCCESSFULLY),
            {
                event: 'auth.password_reset.code_verified',
                code_fingerprint: challenge.code_fingerprint
            }
        );
    } catch (error) {
            return SequelizeException(error, Messages.DATA_SAVE_ERROR);
    }

}


/**
 * Valida la contraseña actual y envia un código para confirmar el cambio.
 */
async requestPasswordChangeCode(idLogin, body, metadata = {}) {
    if (!idLogin) {
        return responseData.unauthorized('La sesion no es valida.');
    }

    let transaction = null;
    const challengeId = randomUUID();

    try {
        transaction = await sequelize.transaction();
        const accounts = await sequelize.query(
            `SELECT id_login, email, password
               FROM login
              WHERE id_login COLLATE utf8mb4_unicode_ci = :_id_login COLLATE utf8mb4_unicode_ci
                AND active = 1
              LIMIT 1
              FOR UPDATE`,
            { replacements: { _id_login: idLogin }, type: QueryTypes.SELECT, transaction }
        );
        const account = accounts[0];

        if (!account) {
            await transaction.rollback();
            transaction = null;
            return responseData.unauthorized('La cuenta de la sesion ya no esta activa.');
        }

        if (!account.email) {
            await transaction.rollback();
            transaction = null;
            return responseData.bad_request('La cuenta no tiene un correo asociado para enviar el codigo.');
        }

        if (!await compare(body.currentPassword, account.password)) {
            await transaction.rollback();
            transaction = null;
            return withSecurityEvent(
                responseData.bad_request('La contrasena actual no es correcta.'),
                { event: 'auth.password_change.current_password_failed', id_login: idLogin }
            );
        }

        if (await compare(body.newPassword, account.password)) {
            await transaction.rollback();
            transaction = null;
            return responseData.bad_request('La nueva contrasena debe ser diferente de la actual.');
        }

        const pendingPasswordHash = await encript(body.newPassword);
        if (!pendingPasswordHash) {
            await transaction.rollback();
            transaction = null;
            return responseData.error('No fue posible preparar el cambio de contrasena.');
        }

        const tokenRecord = PasswordChangeTokenService.buildCodeRecord(idLogin);

        await sequelize.query(
            `UPDATE auth_password_change_tokens
                SET status = CASE WHEN expires_at <= UTC_TIMESTAMP() THEN 'expired' ELSE 'revoked' END,
                    expired_at = CASE WHEN expires_at <= UTC_TIMESTAMP() THEN COALESCE(expired_at, UTC_TIMESTAMP()) ELSE expired_at END,
                    revoked_at = CASE WHEN expires_at > UTC_TIMESTAMP() THEN COALESCE(revoked_at, UTC_TIMESTAMP()) ELSE revoked_at END,
                    pending_password_hash = NULL,
                    updated_at = UTC_TIMESTAMP()
              WHERE id_login COLLATE utf8mb4_unicode_ci = :_id_login COLLATE utf8mb4_unicode_ci
                AND status = 'pending'`,
            { replacements: { _id_login: idLogin }, type: QueryTypes.UPDATE, transaction }
        );

        await sequelize.query(
            `INSERT INTO auth_password_change_tokens (
                id, id_login, destination_email_fingerprint, code_hash, code_fingerprint,
                pending_password_hash, source_password_fingerprint, status, attempts, max_attempts,
                issued_at, expires_at, requested_ip, requested_user_agent, created_at, updated_at
            ) VALUES (
                :_id, :_id_login, :_email_fingerprint, :_code_hash, :_code_fingerprint,
                :_pending_password_hash, :_source_password_fingerprint, 'pending', 0, :_max_attempts,
                UTC_TIMESTAMP(), TIMESTAMPADD(MINUTE, :_ttl_minutes, UTC_TIMESTAMP()),
                :_requested_ip, :_requested_user_agent, UTC_TIMESTAMP(), UTC_TIMESTAMP()
            )`,
            {
                replacements: {
                    _id: challengeId,
                    _id_login: idLogin,
                    _email_fingerprint: PasswordChangeTokenService.fingerprintEmail(account.email),
                    _code_hash: tokenRecord.code_hash,
                    _code_fingerprint: tokenRecord.code_fingerprint,
                    _pending_password_hash: pendingPasswordHash,
                    _source_password_fingerprint: PasswordChangeTokenService.fingerprintPasswordHash(account.password),
                    _max_attempts: tokenRecord.max_attempts,
                    _ttl_minutes: tokenRecord.ttl_minutes,
                    _requested_ip: normalizeClientIp(metadata.ip),
                    _requested_user_agent: normalizeUserAgent(metadata.userAgent)
                },
                type: QueryTypes.INSERT,
                transaction
            }
        );

        await transaction.commit();
        transaction = null;

        const sendMail = await mail.SendPasswordChangeCode(account.email, {
            code: tokenRecord.code,
            ttlMinutes: tokenRecord.ttl_minutes
        });

        if (!sendMail || !sendMail.process) {
            await sequelize.query(
                `UPDATE auth_password_change_tokens
                    SET status = 'revoked',
                        revoked_at = COALESCE(revoked_at, UTC_TIMESTAMP()),
                        pending_password_hash = NULL,
                        updated_at = UTC_TIMESTAMP()
                  WHERE id = :_id AND status = 'pending'`,
                { replacements: { _id: challengeId }, type: QueryTypes.UPDATE }
            );

            return withSecurityEvent(
                responseData.error('No se pudo enviar el codigo. Intentalo de nuevo.'),
                {
                    event: 'auth.password_change.email_failed',
                    id_login: idLogin,
                    email_error_code: sendMail && sendMail.errorCode,
                    email_fingerprint: PasswordChangeTokenService.fingerprintEmail(account.email),
                    code_fingerprint: tokenRecord.code_fingerprint
                }
            );
        }

        return withSecurityEvent(
            responseData.success({
                sent: true,
                emailMasked: PasswordChangeTokenService.maskEmail(account.email),
                ttlMinutes: tokenRecord.ttl_minutes
            }, 'Enviamos un codigo al correo asociado a tu cuenta.'),
            {
                event: 'auth.password_change.code_requested',
                id_login: idLogin,
                email_fingerprint: PasswordChangeTokenService.fingerprintEmail(account.email),
                code_fingerprint: tokenRecord.code_fingerprint
            }
        );
    } catch (error) {
        if (transaction && !transaction.finished) {
            await transaction.rollback();
        }
        return SequelizeException(error, Messages.DATA_SAVE_ERROR);
    }
}

/**
 * Consume el OTP y actualiza la contraseña en una sola transacción.
 */
async confirmPasswordChange(idLogin, currentSessionId, code) {
    if (!idLogin || !currentSessionId) {
        return responseData.unauthorized('La sesion no es valida.');
    }

    const transaction = await sequelize.transaction();
    try {
        const accounts = await sequelize.query(
            `SELECT password, email
               FROM login
              WHERE id_login COLLATE utf8mb4_unicode_ci = :_id_login COLLATE utf8mb4_unicode_ci
                AND active = 1
              LIMIT 1
              FOR UPDATE`,
            { replacements: { _id_login: idLogin }, type: QueryTypes.SELECT, transaction }
        );
        const account = accounts[0];

        if (!account) {
            await transaction.rollback();
            return responseData.unauthorized('La cuenta de la sesion ya no esta activa.');
        }

        const challenges = await sequelize.query(
            `SELECT id, destination_email_fingerprint, code_hash, code_fingerprint, pending_password_hash,
                    source_password_fingerprint, status, attempts, max_attempts,
                    expires_at <= UTC_TIMESTAMP() AS is_expired
               FROM auth_password_change_tokens
              WHERE id_login COLLATE utf8mb4_unicode_ci = :_id_login COLLATE utf8mb4_unicode_ci
                AND status = 'pending'
              ORDER BY issued_at DESC, id DESC
              LIMIT 1
              FOR UPDATE`,
            { replacements: { _id_login: idLogin }, type: QueryTypes.SELECT, transaction }
        );
        const challenge = challenges[0];

        if (!challenge) {
            await transaction.rollback();
            return withSecurityEvent(
                responseData.notSuccess('No hay un codigo activo. Solicita uno nuevo.'),
                { event: 'auth.password_change.code_failed', id_login: idLogin, reason: 'not_found' }
            );
        }

        if (Number(challenge.is_expired) === 1) {
            await sequelize.query(
                `UPDATE auth_password_change_tokens
                    SET status = 'expired', expired_at = COALESCE(expired_at, UTC_TIMESTAMP()),
                        pending_password_hash = NULL, updated_at = UTC_TIMESTAMP()
                  WHERE id = :_id`,
                { replacements: { _id: challenge.id }, type: QueryTypes.UPDATE, transaction }
            );
            await transaction.commit();
            return withSecurityEvent(
                responseData.notSuccess('El codigo vencio. Solicita uno nuevo.'),
                { event: 'auth.password_change.code_expired', id_login: idLogin, code_fingerprint: challenge.code_fingerprint }
            );
        }

        const candidateHash = PasswordChangeTokenService.hashCode(idLogin, code);
        if (!PasswordChangeTokenService.safeCompareHash(candidateHash, challenge.code_hash)) {
            const attempts = Number(challenge.attempts || 0) + 1;
            const maxAttempts = Number(challenge.max_attempts || SecurityConfig.getPasswordResetMaxAttempts());
            const locked = attempts >= maxAttempts;

            await sequelize.query(
                `UPDATE auth_password_change_tokens
                    SET status = :_status,
                        attempts = :_attempts,
                        locked_at = CASE WHEN :_locked = 1 THEN COALESCE(locked_at, UTC_TIMESTAMP()) ELSE locked_at END,
                        pending_password_hash = CASE WHEN :_locked = 1 THEN NULL ELSE pending_password_hash END,
                        updated_at = UTC_TIMESTAMP()
                  WHERE id = :_id`,
                {
                    replacements: {
                        _id: challenge.id,
                        _status: locked ? 'locked' : 'pending',
                        _attempts: attempts,
                        _locked: locked ? 1 : 0
                    },
                    type: QueryTypes.UPDATE,
                    transaction
                }
            );
            await transaction.commit();
            return withSecurityEvent(
                responseData.notSuccess(locked ? 'Se agotaron los intentos. Solicita un nuevo codigo.' : 'El codigo no es correcto.'),
                {
                    event: locked ? 'auth.password_change.code_locked' : 'auth.password_change.code_failed',
                    id_login: idLogin,
                    code_fingerprint: challenge.code_fingerprint,
                    attempts,
                    max_attempts: maxAttempts
                }
            );
        }

        if (!challenge.pending_password_hash) {
            await sequelize.query(
                `UPDATE auth_password_change_tokens
                    SET status = 'revoked', revoked_at = COALESCE(revoked_at, UTC_TIMESTAMP()), updated_at = UTC_TIMESTAMP()
                  WHERE id = :_id`,
                { replacements: { _id: challenge.id }, type: QueryTypes.UPDATE, transaction }
            );
            await transaction.commit();
            return responseData.notSuccess('La solicitud ya no es valida. Inicia el cambio de nuevo.');
        }

        if (!account.email || PasswordChangeTokenService.fingerprintEmail(account.email) !== challenge.destination_email_fingerprint) {
            await sequelize.query(
                `UPDATE auth_password_change_tokens
                    SET status = 'revoked', revoked_at = COALESCE(revoked_at, UTC_TIMESTAMP()),
                        pending_password_hash = NULL, updated_at = UTC_TIMESTAMP()
                  WHERE id = :_id`,
                { replacements: { _id: challenge.id }, type: QueryTypes.UPDATE, transaction }
            );
            await transaction.commit();
            return withSecurityEvent(
                responseData.notSuccess('El correo asociado a la cuenta cambio. Inicia el cambio de contrasena de nuevo.'),
                { event: 'auth.password_change.failed', id_login: idLogin, reason: 'destination_email_changed' }
            );
        }

        if (PasswordChangeTokenService.fingerprintPasswordHash(account.password) !== challenge.source_password_fingerprint) {
            await sequelize.query(
                `UPDATE auth_password_change_tokens
                    SET status = 'revoked', revoked_at = COALESCE(revoked_at, UTC_TIMESTAMP()),
                        pending_password_hash = NULL, updated_at = UTC_TIMESTAMP()
                  WHERE id = :_id`,
                { replacements: { _id: challenge.id }, type: QueryTypes.UPDATE, transaction }
            );
            await transaction.commit();
            return withSecurityEvent(
                responseData.notSuccess('La contrasena cambio durante el proceso. Inicia el cambio de nuevo.'),
                { event: 'auth.password_change.failed', id_login: idLogin, reason: 'source_password_changed' }
            );
        }

        await sequelize.query(
            `UPDATE login
                SET password = :_password,
                    updated_at = NOW(),
                    updated_by = :_id_login
              WHERE id_login COLLATE utf8mb4_unicode_ci = :_id_login COLLATE utf8mb4_unicode_ci
                AND active = 1`,
            {
                replacements: { _id_login: idLogin, _password: challenge.pending_password_hash },
                type: QueryTypes.UPDATE,
                transaction
            }
        );

        await sequelize.query(
            `UPDATE auth_password_change_tokens
                SET status = 'used', used_at = COALESCE(used_at, UTC_TIMESTAMP()),
                    pending_password_hash = NULL, updated_at = UTC_TIMESTAMP()
              WHERE id = :_id`,
            { replacements: { _id: challenge.id }, type: QueryTypes.UPDATE, transaction }
        );

        await sequelize.query(
            `UPDATE auth_password_change_tokens
                SET status = 'revoked', revoked_at = COALESCE(revoked_at, UTC_TIMESTAMP()),
                    pending_password_hash = NULL, updated_at = UTC_TIMESTAMP()
              WHERE id_login COLLATE utf8mb4_unicode_ci = :_id_login COLLATE utf8mb4_unicode_ci
                AND status = 'pending' AND id <> :_id`,
            { replacements: { _id_login: idLogin, _id: challenge.id }, type: QueryTypes.UPDATE, transaction }
        );

        await invalidateOtherAuthArtifacts(idLogin, currentSessionId, transaction);
        await transaction.commit();

        const notification = await mail.SendPasswordChanged(account.email);

        return withSecurityEvent(
            responseData.success({ password_updated: true, other_sessions_invalidated: true }, 'Tu contrasena se actualizo correctamente.'),
            {
                event: 'auth.password_change.success',
                id_login: idLogin,
                code_fingerprint: challenge.code_fingerprint,
                notification_sent: Boolean(notification && notification.process)
            }
        );
    } catch (error) {
        if (!transaction.finished) {
            await transaction.rollback();
        }
        return SequelizeException(error, Messages.DATA_SAVE_ERROR);
    }
}

/**
 * Permite restablecer una contraseña desde el flujo público de recuperación.
 */
async reseetPassword(body) {
    const transaction = await sequelize.transaction();
    try {
        const phone = body.phone || body.telephone;
        const code = body.otp || body.code;
        const challenge = await getLatestPasswordResetChallenge(phone, ['verified'], transaction);

        if (!challenge) {
            await transaction.rollback();
            return withSecurityEvent(
                responseData.notSuccess(Messages.DATA_GET_ERROR),
                {
                    event: 'auth.password_reset.failed',
                    reason: 'verified_challenge_not_found'
                }
            );
        }

        if (PasswordResetTokenService.isExpired(challenge.expires_at)) {
            await markPasswordResetChallenge(challenge.id, 'expired', {}, transaction);
            await transaction.commit();
            return withSecurityEvent(
                responseData.notSuccess(Messages.DATA_GET_ERROR),
                {
                    event: 'auth.password_reset.failed',
                    reason: 'expired_challenge',
                    code_fingerprint: challenge.code_fingerprint
                }
            );
        }

        const candidateHash = PasswordResetTokenService.hashCode(phone, code);
        const matches = PasswordResetTokenService.safeCompareHash(candidateHash, challenge.code_hash);

        if (!matches) {
            await transaction.rollback();
            return withSecurityEvent(
                responseData.notSuccess(Messages.DATA_GET_ERROR),
                {
                    event: 'auth.password_reset.failed',
                    reason: 'code_mismatch',
                    code_fingerprint: challenge.code_fingerprint
                }
            );
        }

        const account = await getPasswordResetAccountById(challenge.id_login, transaction);

        if (!account) {
            await transaction.rollback();
            return withSecurityEvent(
                responseData.notSuccess(Messages.DATA_GET_ERROR),
                {
                    event: 'auth.password_reset.failed',
                    reason: 'account_not_found'
                }
            );
        }

        const pwd = await encript(body.password);
        const updateResult = await sequelize.query(
            `UPDATE login
                SET password = :_password,
                    updated_at = NOW(),
                    updated_by = :_id_login
              WHERE id_login COLLATE utf8mb4_unicode_ci = :_id_login COLLATE utf8mb4_unicode_ci
                AND active = 1`,
            {
                replacements: {
                    _id_login: account.id_login,
                    _password: pwd
                },
                type: QueryTypes.UPDATE,
                transaction
            }
        );

        if (affectedRows(updateResult) < 1) {
            await transaction.rollback();
            return withSecurityEvent(
                responseData.notSuccess(Messages.DATA_GET_ERROR),
                {
                    event: 'auth.password_reset.failed',
                    reason: 'password_update_not_applied'
                }
            );
        }

        await markPasswordResetChallenge(challenge.id, 'used', {}, transaction);
        await revokeActivePasswordResetTokens(account.id_login, { transaction });
        await invalidateAuthArtifacts(account.id_login, null, null, transaction);
        await transaction.commit();

        let notificationSent = false;
        if (account.email) {
            const notification = await mail.SendPasswordChanged(account.email);
            notificationSent = Boolean(notification && notification.process);
        }

        return withSecurityEvent(
            responseData.success({
                password_updated: true,
                sessions_invalidated: true
            }, Messages.DATA_GET_SUCCESSFULLY),
            {
                event: 'auth.password_reset.success',
                code_fingerprint: challenge.code_fingerprint,
                email_fingerprint: PasswordResetTokenService.fingerprintEmail(account.email),
                notification_sent: notificationSent
            }
        );
    } catch (error) {
            if (!transaction.finished) {
                await transaction.rollback();
            }
            return SequelizeException(error, Messages.DATA_SAVE_ERROR);
    }

}

}

module.exports = new AuthDao;

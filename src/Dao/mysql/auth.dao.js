const effectivePermissions = require('../../util/effectivePermissions');
const { randomUUID } = require('crypto');
const identityAuth = require('../../services/registration/identityAuth');
const { normalizeEmail } = require('../../services/registration/identity');
const registrationPasswords = require('../../services/security/registrationPassword.service');
const { AccountActivationService, isActivationConfirmed } = require('../../services/registration/accountActivation.service');
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
                l.first_name AS login_first_name,
                l.last_name AS login_last_name,
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

const getRecoveryAccount = async (identifier, transaction) => {
    const email = normalizeEmail(identifier);
    if (!email) return null;
    if (identityAuth.enabled()) return identityAuth.findOwner(sequelize, email, { transaction, lock: true, allowExpired: true });
    const rows = await sequelize.query(
        `SELECT id_login,email,telephone,password FROM login
         WHERE LOWER(TRIM(email))=:email AND active=1 LIMIT 2 FOR UPDATE`,
        { replacements: { email }, type: QueryTypes.SELECT, transaction }
    );
    return rows.length === 1 ? rows[0] : null;
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

const createPasswordResetChallenge = async (account, email, metadata, transaction) => {
    const record = PasswordResetTokenService.buildCodeRecord(email);
    await sequelize.query(
        `INSERT INTO auth_password_reset_tokens (
            id_login,identifier_normalized,destination_email_fingerprint,code_hash,code_fingerprint,
            purpose,status,attempts,max_attempts,issued_at,expires_at,requested_ip,requested_user_agent,created_at,updated_at)
         VALUES (:login,:email,:destination,:hash,:fingerprint,:purpose,'pending',0,:max,NOW(),
            DATE_ADD(NOW(),INTERVAL :ttl MINUTE),:ip,:agent,NOW(),NOW())`,
        { replacements: { login: account.id_login, email, destination: PasswordResetTokenService.fingerprintEmail(account.email),
            hash: record.code_hash, fingerprint: record.code_fingerprint, purpose: PasswordResetTokenService.PURPOSE,
            max: record.max_attempts, ttl: SecurityConfig.getPasswordResetCodeTtlMinutes(),
            ip: normalizeClientIp(metadata.ip), agent: normalizeUserAgent(metadata.userAgent) }, type: QueryTypes.INSERT, transaction }
    );
    return record;
};

const getLatestPasswordResetChallenge = async (email, account, transaction) => {
    const rows = await sequelize.query(
        `SELECT id,id_login,identifier_normalized,destination_email_fingerprint,code_hash,code_fingerprint,
            purpose,status,attempts,max_attempts,expires_at
         FROM auth_password_reset_tokens
         WHERE identifier_normalized=:email AND id_login=:login AND purpose=:purpose
         ORDER BY issued_at DESC,id DESC LIMIT 1 FOR UPDATE`,
        { replacements: { email, login: account.id_login, purpose: PasswordResetTokenService.PURPOSE }, type: QueryTypes.SELECT, transaction }
    );
    return rows[0] || null;
};

const markPasswordResetChallenge = async (id, status, previousStatus, transaction, attempts) => {
    const timestamps = { expired: 'expired_at', locked: 'locked_at', used: 'used_at', revoked: 'revoked_at', verified: 'verified_at' };
    const rows = await sequelize.query(
        `UPDATE auth_password_reset_tokens SET status=:status,updated_at=NOW()
            ${timestamps[status] ? `,${timestamps[status]}=COALESCE(${timestamps[status]},NOW())` : ''}
            ${attempts !== undefined ? ',attempts=:attempts' : ''}
         WHERE id=:id AND status=:previousStatus`,
        { replacements: { id, status, previousStatus, ...(attempts !== undefined ? { attempts } : {}) }, type: QueryTypes.UPDATE, transaction }
    );
    return affectedRows(rows);
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
                l.first_name,
                l.last_name,
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
    let registrationWelcomePending=false;
    let registrationActivationConfirmed=false;
    if(require('../../services/registration/accountActivation.service').enabled() && role?.code==='admin' && role.id_business) {
        const [registration]=await sequelize.query(`SELECT a.setup_welcome_acknowledged_at,a.activation_completed_at,
            EXISTS(SELECT 1 FROM auth_identity i JOIN login l ON l.id_login=i.id_login AND l.email=i.normalized_value
                WHERE i.id_login=a.id_login AND i.kind='email' AND i.reservation_status='verified' AND i.verified_at IS NOT NULL AND i.expires_at IS NULL) email_verified
            FROM registration_account a WHERE a.id_login=:login AND a.id_business=:business`,
        {replacements:{login:idLogin,business:role.id_business},type:QueryTypes.SELECT});
        registrationWelcomePending=Boolean(registration && !registration.setup_welcome_acknowledged_at);
        registrationActivationConfirmed=isActivationConfirmed({active:role.business_active,status:role.business_status,
            subscription_status:role.subscription_status,trial_ends_at:role.trial_ends_at,plan:role.business_plan,
            activation_completed_at:registration?.activation_completed_at,email_verified:registration?.email_verified});
    }

    return {
        tokenData: {
            email: authRow.email || authRow.login_email || (role && role.login_email ? role.login_email : null),
            first_name: authRow.first_name || authRow.login_first_name || role?.login_first_name || null,
            last_name: authRow.last_name || authRow.login_last_name || role?.login_last_name || '',
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
            registrationWelcomePending,
            registrationActivationConfirmed,
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
            let result = identityAuth.enabled()
                ? await identityAuth.findOwner(sequelize, body.param, {allowExpired:true}).then(row => row ? [row] : null)
                : String(body.param || '').includes('@')
                    ? await sequelize.query('SELECT id_login,password,email,telephone FROM login WHERE LOWER(TRIM(email))=:email AND active=1 LIMIT 2', {replacements:{email:require('../../services/registration/identity').normalizeEmail(body.param)},type:QueryTypes.SELECT})
                        .then(rows => rows.length===1 ? rows : null)
                : await sequelize.query(SequelizeSP.SP_LOGIN_BY_TELEPHONE, {
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
                        if ((metadata.expectedLoginId && result[0].id_login !== metadata.expectedLoginId)
                            || (identityAuth.enabled() && !await identityAuth.confirmLoginOwner(sequelize, body.param, result[0].id_login, result[0].password))) {
                            return responseData.notSuccess(Messages.AUTH_NOT_FOUND);
                        }
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

                            // Password reset or identity reassignment can race the
                            // legacy session SP. Check again after all issuance writes;
                            // a later reset will revoke these already-created artifacts.
                            if (identityAuth.enabled()) {
                                const current = await identityAuth.findOwner(sequelize, body.param);
                                if (!current || current.id_login !== result[0].id_login || current.password !== result[0].password) {
                                    await invalidateAuthArtifacts(result[0].id_login, authRow.id_session);
                                    return responseData.notSuccess(Messages.AUTH_NOT_FOUND);
                                }
                            }
        
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

    async sendOtpRecoverPassword(identifier, metadata = {}) {
        let transaction;
        try {
            const email = normalizeEmail(identifier);
            if (!email) return responseData.success({ sent: true }, Messages.DATA_SAVE_SUCCESSFULLY);
            transaction = await sequelize.transaction();
            // Every recovery operation locks the owner before any challenge row.
            const account = await getRecoveryAccount(email, transaction);
            if (!account) {
                await transaction.rollback();
                return responseData.success({ sent: true }, Messages.DATA_SAVE_SUCCESSFULLY);
            }
            await revokeActivePasswordResetTokens(account.id_login, { transaction });
            const record = await createPasswordResetChallenge(account, email, metadata, transaction);
            await transaction.commit();
            const delivery = await mail.SendPasswordResetCode(account.email, { code: record.code, ttlMinutes: SecurityConfig.getPasswordResetCodeTtlMinutes() });
            if (!delivery || !delivery.process) await sequelize.query(
                `UPDATE auth_password_reset_tokens SET status='revoked',revoked_at=NOW(),updated_at=NOW()
                 WHERE id_login=:login AND code_hash=:hash AND status='pending'`,
                { replacements: { login: account.id_login, hash: record.code_hash }, type: QueryTypes.UPDATE }
            );
            return withSecurityEvent(responseData.success({ sent: true }, Messages.DATA_SAVE_SUCCESSFULLY), {
                event: delivery?.process ? 'auth.password_reset.requested' : 'auth.password_reset.email_failed',
                email_fingerprint: PasswordResetTokenService.fingerprintEmail(email), code_fingerprint: record.code_fingerprint
            });
        } catch (error) {
            if (transaction && !transaction.finished) await transaction.rollback();
            return SequelizeException(error, Messages.DATA_GET_ERROR);
        }
    }

    async validateOtp(body) {
        let transaction;
        try {
            const email = normalizeEmail(body.email || body.telephone || body.phone), code = body.code || body.otp;
            if (!email) return responseData.notSuccess(Messages.DATA_GET_ERROR);
            transaction = await sequelize.transaction();
            const account = await getRecoveryAccount(email, transaction);
            const challenge = account && await getLatestPasswordResetChallenge(email, account, transaction);
            if (!challenge || challenge.status !== 'pending'
                || challenge.destination_email_fingerprint !== PasswordResetTokenService.fingerprintEmail(account.email)) {
                await transaction.rollback(); return responseData.notSuccess(Messages.DATA_GET_ERROR);
            }
            if (PasswordResetTokenService.isExpired(challenge.expires_at)) {
                await markPasswordResetChallenge(challenge.id, 'expired', 'pending', transaction);
                await transaction.commit(); return responseData.notSuccess(Messages.DATA_GET_ERROR);
            }
            const attempts = Number(challenge.attempts || 0), max = Number(challenge.max_attempts || SecurityConfig.getPasswordResetMaxAttempts());
            if (attempts >= max) {
                await markPasswordResetChallenge(challenge.id, 'locked', 'pending', transaction);
                await transaction.commit(); return responseData.notSuccess(Messages.DATA_GET_ERROR);
            }
            const valid = PasswordResetTokenService.safeCompareHash(PasswordResetTokenService.hashCode(email, code), challenge.code_hash);
            const status = valid ? 'verified' : attempts + 1 >= max ? 'locked' : 'pending';
            const changed = await markPasswordResetChallenge(challenge.id, status, 'pending', transaction, valid ? attempts : attempts + 1);
            if (changed !== 1) { await transaction.rollback(); return responseData.notSuccess(Messages.DATA_GET_ERROR); }
            await transaction.commit();
            return valid ? responseData.success({ verified: true }, Messages.DATA_GET_SUCCESSFULLY) : responseData.notSuccess(Messages.DATA_GET_ERROR);
        } catch (error) {
            if (transaction && !transaction.finished) await transaction.rollback();
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

        const [lastChallenge] = await sequelize.query(
            `SELECT GREATEST(0,60-TIMESTAMPDIFF(SECOND,issued_at,UTC_TIMESTAMP())) AS retryAfterSeconds
             FROM auth_password_change_tokens WHERE id_login=:_id_login
             ORDER BY issued_at DESC,id DESC LIMIT 1`,
            { replacements: { _id_login: idLogin }, type: QueryTypes.SELECT, transaction }
        );
        if (Number(lastChallenge?.retryAfterSeconds) > 0) {
            await transaction.rollback(); transaction = null;
            return { status: 429, data: null, retryAfterSeconds: Number(lastChallenge.retryAfterSeconds),
                message: 'Espera antes de solicitar otro código.' };
        }

        const pendingPasswordHash = await registrationPasswords.hash(body.newPassword);
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

        let sendMail;
        try {
            sendMail = await mail.SendPasswordChangeCode(account.email, {
                code: tokenRecord.code,
                ttlMinutes: tokenRecord.ttl_minutes
            });
        } catch (_) { /* Revoke the challenge when delivery is not confirmed. */ }

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
                ttlMinutes: tokenRecord.ttl_minutes,
                resendAfterSeconds: 60
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
        if (error.code === 'PASSWORD_COMPROMISED') return responseData.bad_request('Esta contraseña es demasiado común. Elige otra.');
        if (error.code === 'PASSWORD_INVALID') return responseData.bad_request('La contraseña debe tener entre 8 y 128 caracteres.');
        if (['PASSWORD_POLICY_UNAVAILABLE','PASSWORD_CAPACITY_BUSY'].includes(error.code)) return {
            status: 503, data: null, message: 'No fue posible preparar el cambio. Inténtalo más tarde.'
        };
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

        await revokeActivePasswordResetTokens(idLogin, { transaction });
        await invalidateOtherAuthArtifacts(idLogin, currentSessionId, transaction);
        const changedAt = new Date().toISOString();
        await transaction.commit();

        let notification;
        try { notification = await mail.SendPasswordChanged(account.email, { changedAt, changeMethod: 'settings' }); }
        catch (_) { /* The password change is already committed. */ }

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
    let transaction;
    try {
        const email = normalizeEmail(body.email || body.phone || body.telephone), code = body.otp || body.code;
        if (!email) return responseData.notSuccess(Messages.DATA_GET_ERROR);
        transaction = await sequelize.transaction();
        const account = await getRecoveryAccount(email, transaction);
        const challenge = account && await getLatestPasswordResetChallenge(email, account, transaction);
        if (!challenge || challenge.status !== 'verified'
            || challenge.destination_email_fingerprint !== PasswordResetTokenService.fingerprintEmail(account.email)) {
            await transaction.rollback(); return responseData.notSuccess(Messages.DATA_GET_ERROR);
        }
        if (PasswordResetTokenService.isExpired(challenge.expires_at)) {
            await markPasswordResetChallenge(challenge.id, 'expired', 'verified', transaction);
            await transaction.commit(); return responseData.notSuccess(Messages.DATA_GET_ERROR);
        }
        const maxAttempts = Number(challenge.max_attempts || SecurityConfig.getPasswordResetMaxAttempts());
        if (Number(challenge.attempts || 0) >= maxAttempts) {
            await markPasswordResetChallenge(challenge.id, 'locked', 'verified', transaction);
            await transaction.commit(); return responseData.notSuccess(Messages.DATA_GET_ERROR);
        }
        if (!PasswordResetTokenService.safeCompareHash(PasswordResetTokenService.hashCode(email, code), challenge.code_hash)) {
            const attempts = Number(challenge.attempts || 0) + 1;
            await markPasswordResetChallenge(challenge.id, attempts >= maxAttempts ? 'locked' : 'verified', 'verified', transaction, attempts);
            await transaction.commit(); return responseData.notSuccess(Messages.DATA_GET_ERROR);
        }
        const pwd = await registrationPasswords.hash(body.password);
        const changed = await sequelize.query(
            `UPDATE login SET password=:_password,updated_at=NOW(),updated_by=:_id_login
             WHERE id_login=:_id_login AND active=1`,
            { replacements: { _password: pwd, _id_login: account.id_login }, type: QueryTypes.UPDATE, transaction }
        );
        if (affectedRows(changed) !== 1 || await markPasswordResetChallenge(challenge.id, 'used', 'verified', transaction) !== 1) {
            await transaction.rollback(); return responseData.notSuccess(Messages.DATA_SAVE_ERROR);
        }
        if (identityAuth.enabled()) {
            await sequelize.query(
                `UPDATE auth_identity SET reservation_status='verified',verified_at=COALESCE(verified_at,NOW(3)),expires_at=NULL,updated_at=NOW(3)
                 WHERE kind='email' AND normalized_value=:email AND id_login=:login`,
                { replacements: { email, login: account.id_login }, type: QueryTypes.UPDATE, transaction }
            );
            await new AccountActivationService(sequelize).activateVerifiedEmail(account.id_login, transaction);
        }
        await revokeActivePasswordResetTokens(account.id_login, { transaction });
        await invalidateAuthArtifacts(account.id_login, null, null, transaction);
        const changedAt = new Date().toISOString();
        await transaction.commit();
        let notificationSent = false;
        try { notificationSent = Boolean((await mail.SendPasswordChanged(account.email, { changedAt, changeMethod: 'recovery' }))?.process); }
        catch (_) { /* The password change is already committed. */ }
        return withSecurityEvent(responseData.success({ password_updated: true, sessions_invalidated: true }, Messages.DATA_GET_SUCCESSFULLY), {
            event: 'auth.password_reset.success', code_fingerprint: challenge.code_fingerprint,
            email_fingerprint: PasswordResetTokenService.fingerprintEmail(email), notification_sent: notificationSent
        });
    } catch (error) {
        if (transaction && !transaction.finished) await transaction.rollback();
        return SequelizeException(error, Messages.DATA_SAVE_ERROR);
    }
}

}

module.exports = new AuthDao;

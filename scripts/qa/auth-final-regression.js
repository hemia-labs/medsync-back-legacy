require('../../src/config/env');

const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { QueryTypes } = require('sequelize');
const sequelize = require('../../src/db/Sequelize.connection');
const SecurityConfig = require('../../src/config/security');
const AuthController = require('../../src/controller/mysql/auth.controller');
const AuthDao = require('../../src/Dao/mysql/auth.dao');
const SessionDao = require('../../src/Dao/mysql/session.Dao');
const SuperAdminDao = require('../../src/Dao/mysql/superAdmin.dao');
const awaitHandlerFactory = require('../../src/middleware/awaitHandlerFactory.middleware');
const { validateAuthPayload } = require('../../src/middleware/authPayloadValidation.middleware');
const authRateLimit = require('../../src/middleware/authRateLimit.middleware');
const SecurityLogger = require('../../src/services/security/securityLogger.service');
const PasswordResetTokenService = require('../../src/services/security/passwordResetToken.service');
const { encript } = require('../../src/util/bcrypt');

const CREATED_BY = 'QA_AUTH_FINAL_REGRESSION';
const BUSINESS_ID = 'QA_AUTH_FINAL_BUSINESS';
const QA_USER_AGENT = 'QA_AUTH_FINAL_REGRESSION';
const USERS = {
  userA: {
    id: 'QA_AUTH_FINAL_USER_A',
    name: 'QA Auth Final User A',
    email: process.env.QA_AUTH_RESET_EMAIL_TO || 'qa.auth.final.a@example.test',
    phone: '9993000001',
    roleCode: 'admin'
  },
  userB: {
    id: 'QA_AUTH_FINAL_USER_B',
    name: 'QA Auth Final User B',
    email: process.env.QA_AUTH_RESET_EMAIL_TO || 'qa.auth.final.b@example.test',
    phone: '9993000002',
    roleCode: 'admin'
  },
  userC: {
    id: 'QA_AUTH_FINAL_USER_C',
    name: 'QA Auth Final User C',
    email: process.env.QA_AUTH_RESET_EMAIL_TO || 'qa.auth.final.c@example.test',
    phone: '9993000003',
    roleCode: 'admin'
  },
  superAdmin: {
    id: 'QA_AUTH_FINAL_SUPERADMIN',
    name: 'QA Auth Final Super Admin',
    email: process.env.QA_AUTH_RESET_EMAIL_TO || 'qa.auth.final.superadmin@example.test',
    phone: '9993000099',
    roleCode: 'super_admin'
  }
};

function fixtureUsers() {
  return Object.keys(USERS).map((key) => USERS[key]);
}

function fixtureIds() {
  return fixtureUsers().map((user) => user.id);
}

function fixturePhones() {
  return fixtureUsers().map((user) => user.phone);
}

function safeResponse(response) {
  const status = response ? Number(response.status) : null;
  return {
    status,
    success: Boolean(response && response.success),
    successCompatible: Boolean(status && status >= 200 && status < 300),
    message: response ? response.message : null,
    code: response ? response.code || null : null
  };
}

function decodeAccessToken(response) {
  const rawToken = response && response.data ? response.data.token : null;
  return rawToken ? jwt.decode(rawToken) : null;
}

function getRuntimeEnv() {
  return process.env.APP_ENV || process.env.ENVIRONMENT || process.env.NODE_ENV || 'development';
}

async function dbIdentity() {
  try {
    const rows = await sequelize.query(
      'SELECT DATABASE() AS database_name, @@hostname AS database_host, @@port AS database_port',
      { type: QueryTypes.SELECT }
    );
    return rows[0] || {};
  } catch (error) {
    return {
      database_name: null,
      database_host: null,
      database_port: null,
      lookup_error: error.message
    };
  }
}

function looksProductionLikeDatabase(identity) {
  const value = `${identity.database_name || ''} ${identity.database_host || ''}`.toLowerCase();
  return /\b(prod|production|live)\b/.test(value) || value.indexOf('prod_') !== -1 || value.indexOf('_prod') !== -1;
}

async function assertNotProduction() {
  const identity = await dbIdentity();
  if (SecurityConfig.isProductionLike() || looksProductionLikeDatabase(identity)) {
    throw new Error('Abortado: ambiente production-like detectado.');
  }
}

function missingWriteEnv() {
  const missing = [];
  if (process.env.ALLOW_QA_AUTH_FIXTURES !== 'true') missing.push('ALLOW_QA_AUTH_FIXTURES');
  if (!process.env.QA_AUTH_PASSWORD) missing.push('QA_AUTH_PASSWORD');
  if (!process.env.REFRESH_TOKEN_SECRET) missing.push('REFRESH_TOKEN_SECRET');
  if (!process.env.PASSWORD_RESET_CODE_SECRET) missing.push('PASSWORD_RESET_CODE_SECRET');
  if (process.env.REQUIRE_ACTIVE_SESSION !== 'true') missing.push('REQUIRE_ACTIVE_SESSION');
  return missing;
}

async function assertWriteAllowed(command) {
  await assertNotProduction();
  const missing = missingWriteEnv();
  if (missing.length > 0) {
    throw new Error(`${command} requiere variables QA: ${missing.join(', ')}.`);
  }
}

async function technicalQaGate(command, flagName) {
  await assertNotProduction();
  const missing = [];
  if (process.env.ALLOW_AUTH_TECHNICAL_QA !== 'true') missing.push('ALLOW_AUTH_TECHNICAL_QA');
  if (flagName && process.env[flagName] !== 'true') missing.push(flagName);
  if (missing.length > 0) {
    return {
      skipped: true,
      command,
      missingEnv: missing
    };
  }
  return null;
}

async function tableExists(tableName) {
  const rows = await sequelize.query(
    `SELECT COUNT(*) AS total
       FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = :tableName`,
    { replacements: { tableName }, type: QueryTypes.SELECT }
  );
  return Number(rows[0] ? rows[0].total : 0) > 0;
}

async function requirePasswordResetTable() {
  if (!(await tableExists('auth_password_reset_tokens'))) {
    throw new Error('La tabla auth_password_reset_tokens no existe.');
  }
}

async function roleByCode(code) {
  const rows = await sequelize.query(
    `SELECT id_rol, code
       FROM rol
      WHERE code COLLATE utf8mb4_unicode_ci = :code COLLATE utf8mb4_unicode_ci
        AND active = 1
      LIMIT 1`,
    { replacements: { code }, type: QueryTypes.SELECT }
  );
  return rows[0] || null;
}

async function ensureBusiness(transaction) {
  await sequelize.query(
    `INSERT INTO business (
        id_business, name, legal_name, slug, email, phone, address, status, plan,
        active, subscription_status, current_period_starts_at, created_at, created_by
      ) VALUES (
        :id, 'QA Auth Final Clinic', 'QA Auth Final Clinic', 'qa-auth-final-clinic',
        'qa.auth.final.business@example.test', '9993000000', 'QA fixture local/dev',
        'active', 'enterprise', 1, 'active', NOW(), NOW(), :createdBy
      )
      ON DUPLICATE KEY UPDATE
        name = VALUES(name),
        legal_name = VALUES(legal_name),
        email = VALUES(email),
        phone = VALUES(phone),
        status = 'active',
        plan = 'enterprise',
        active = 1,
        subscription_status = 'active',
        updated_at = NOW(),
        updated_by = :createdBy`,
    {
      replacements: { id: BUSINESS_ID, createdBy: CREATED_BY },
      type: QueryTypes.INSERT,
      transaction
    }
  );
}

async function ensureLogin(user, role, passwordHash, transaction) {
  await sequelize.query(
    `INSERT INTO login (
        id_login, id_business, id_rol, name, email, telephone, password, locked,
        active, created_at, created_by, updated_at, updated_by
      ) VALUES (
        :id, :businessId, :roleId, :name, :email, :phone, :password, 0,
        1, NOW(), :createdBy, NOW(), :createdBy
      )
      ON DUPLICATE KEY UPDATE
        id_business = VALUES(id_business),
        id_rol = VALUES(id_rol),
        name = VALUES(name),
        email = VALUES(email),
        telephone = VALUES(telephone),
        password = VALUES(password),
        locked = 0,
        active = 1,
        updated_at = NOW(),
        updated_by = :createdBy`,
    {
      replacements: {
        id: user.id,
        businessId: user.roleCode === 'super_admin' ? null : BUSINESS_ID,
        roleId: role.id_rol,
        name: user.name,
        email: user.email,
        phone: user.phone,
        password: passwordHash,
        createdBy: CREATED_BY
      },
      type: QueryTypes.INSERT,
      transaction
    }
  );
}

async function resetAuthState(transaction = null) {
  if (await tableExists('auth_password_reset_tokens')) {
    await sequelize.query(
      `DELETE FROM auth_password_reset_tokens
        WHERE id_login IN (:ids)
           OR phone_normalized IN (:phones)`,
      { replacements: { ids: fixtureIds(), phones: fixturePhones() }, type: QueryTypes.DELETE, transaction }
    );
  }
  await sequelize.query(
    `DELETE FROM refresh_token WHERE id_login IN (:ids)`,
    { replacements: { ids: fixtureIds() }, type: QueryTypes.DELETE, transaction }
  );
  await sequelize.query(
    `DELETE FROM \`session\` WHERE id_login IN (:ids)`,
    { replacements: { ids: fixtureIds() }, type: QueryTypes.DELETE, transaction }
  );
}

async function refreshRows(idLogin) {
  return sequelize.query(
    `SELECT id_refresh_token, id_login, id_session, token_hash, token_fingerprint,
            family_id, parent_token_hash, expires_at, rotated_at, revoked_at,
            revoked_reason, reused_at, last
       FROM refresh_token
      WHERE id_login COLLATE utf8mb4_unicode_ci = :idLogin COLLATE utf8mb4_unicode_ci
      ORDER BY created_at DESC`,
    { replacements: { idLogin }, type: QueryTypes.SELECT }
  );
}

async function sessionRows(idLogin) {
  return sequelize.query(
    `SELECT id_session, id_login, active, last
       FROM \`session\`
      WHERE id_login COLLATE utf8mb4_unicode_ci = :idLogin COLLATE utf8mb4_unicode_ci
      ORDER BY created_at DESC`,
    { replacements: { idLogin }, type: QueryTypes.SELECT }
  );
}

async function resetRowsForUser(userId) {
  return sequelize.query(
    `SELECT id, id_login, phone_normalized, code_hash, code_fingerprint, status,
            attempts, max_attempts, expires_at, verified_at, used_at, revoked_at,
            locked_at, expired_at
       FROM auth_password_reset_tokens
      WHERE id_login COLLATE utf8mb4_unicode_ci = :userId COLLATE utf8mb4_unicode_ci
      ORDER BY id DESC`,
    { replacements: { userId }, type: QueryTypes.SELECT }
  );
}

async function insertChallenge(user, options = {}) {
  const tokenRecord = PasswordResetTokenService.buildCodeRecord(user.phone);
  const ttlSql = options.expired
    ? 'DATE_SUB(NOW(), INTERVAL 1 MINUTE)'
    : 'DATE_ADD(NOW(), INTERVAL :ttlMinutes MINUTE)';

  await sequelize.query(
    `INSERT INTO auth_password_reset_tokens (
        id_login, phone_normalized, destination_email_fingerprint, code_hash,
        code_fingerprint, purpose, status, attempts, max_attempts, issued_at,
        expires_at, requested_ip, requested_user_agent, created_at, updated_at
      ) VALUES (
        :idLogin, :phone, :emailFingerprint, :codeHash,
        :codeFingerprint, :purpose, :status, :attempts, :maxAttempts, NOW(),
        ${ttlSql}, '127.0.0.1', :userAgent, NOW(), NOW()
      )`,
    {
      replacements: {
        idLogin: user.id,
        phone: user.phone,
        emailFingerprint: PasswordResetTokenService.fingerprintEmail(user.email),
        codeHash: tokenRecord.code_hash,
        codeFingerprint: tokenRecord.code_fingerprint,
        purpose: PasswordResetTokenService.PURPOSE,
        status: options.status || 'pending',
        attempts: options.attempts || 0,
        maxAttempts: options.maxAttempts || SecurityConfig.getPasswordResetMaxAttempts(),
        ttlMinutes: SecurityConfig.getPasswordResetCodeTtlMinutes(),
        userAgent: QA_USER_AGENT
      },
      type: QueryTypes.INSERT
    }
  );

  return {
    code: tokenRecord.code,
    code_fingerprint: tokenRecord.code_fingerprint
  };
}

async function login(user, password, refresh) {
  return AuthDao.login({
    param: user.phone,
    pwd: password,
    refresh
  }, {
    ip: '127.0.0.1',
    userAgent: QA_USER_AGENT
  });
}

async function refreshToken(rawRefreshToken) {
  return AuthDao.refreshToken({ id_refresh_token: rawRefreshToken }, {
    ip: '127.0.0.1',
    userAgent: QA_USER_AGENT
  });
}

async function protectedMiddlewareStatus(decodedToken) {
  const req = {
    tokenDecode: decodedToken,
    ip: '127.0.0.1',
    method: 'GET',
    originalUrl: '/qa/protected',
    get: () => QA_USER_AGENT
  };
  const res = {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    }
  };
  let middlewareCalled = false;
  const middleware = awaitHandlerFactory(async () => {
    middlewareCalled = true;
  });

  await middleware(req, res, () => {});
  return {
    status: res.statusCode || (middlewareCalled ? 200 : null),
    middlewareCalled
  };
}

function runPayloadValidation(type, body) {
  const middleware = validateAuthPayload(type);
  const req = { body };
  const res = {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(payload) {
      this.body = payload;
      return this;
    }
  };
  let nextCalled = false;
  middleware(req, res, () => {
    nextCalled = true;
  });
  return {
    status: res.statusCode || (nextCalled ? 200 : null),
    nextCalled,
    genericShape: !res.body || !String(res.body.message || '').toLowerCase().includes('sql')
  };
}

async function runAuthRoute(options) {
  const req = {
    body: options.body || {},
    ip: '127.0.0.1',
    method: options.method || 'POST',
    originalUrl: options.url || `/api/auth/${options.payloadType}`,
    get: () => QA_USER_AGENT
  };
  const res = {
    statusCode: null,
    body: null,
    retryAfter: null,
    setHeader(name, value) {
      if (String(name).toLowerCase() === 'retry-after') {
        this.retryAfter = value;
      }
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(payload) {
      this.body = payload;
      return this;
    }
  };

  const validator = validateAuthPayload(options.payloadType);
  let stopped = false;
  validator(req, res, () => {});
  if (res.statusCode) {
    stopped = true;
  }
  if (stopped) {
    return {
      status: res.statusCode,
      message: res.body ? res.body.message : null,
      code: res.body ? res.body.code || null : null,
      success: Boolean(res.body && res.body.success)
    };
  }

  if (options.rateType) {
    const limiter = authRateLimit(options.rateType);
    let nextCalled = false;
    limiter(req, res, () => {
      nextCalled = true;
    });
    if (!nextCalled || res.statusCode) {
      return {
        status: res.statusCode,
        message: res.body ? res.body.message : null,
        code: res.body ? res.body.code || null : null,
        success: Boolean(res.body && res.body.success)
      };
    }
  }

  await AuthController[options.handler](req, res, () => {});
  return {
    status: res.statusCode,
    message: res.body ? res.body.message : null,
    code: res.body ? res.body.code || null : null,
    success: Boolean(res.body && res.body.success)
  };
}

function runRateLimitMiddleware(type, phone, attempts, failureMode) {
  if (authRateLimit._private && authRateLimit._private.buckets) {
    authRateLimit._private.buckets.clear();
  }

  const middleware = authRateLimit(type);
  const results = [];
  for (let index = 0; index < attempts; index += 1) {
    const req = {
      ip: `127.0.4.${type.length}`,
      authIdentity: { phone },
      method: type === 'resetPassword' ? 'PUT' : 'POST',
      originalUrl: `/api/auth/${type}`,
      get: () => QA_USER_AGENT
    };
    const res = {
      statusCode: null,
      body: null,
      retryAfter: null,
      setHeader(name, value) {
        if (String(name).toLowerCase() === 'retry-after') {
          this.retryAfter = value;
        }
      },
      status(code) {
        this.statusCode = code;
        return this;
      },
      send(payload) {
        this.body = payload;
        return this;
      }
    };
    let nextCalled = false;
    middleware(req, res, () => {
      nextCalled = true;
    });
    if (failureMode && req.authRateLimit && req.authRateLimit.recordFailure) {
      const failureResult = req.authRateLimit.recordFailure();
      if (failureResult && failureResult.limited && !res.statusCode) {
        res.statusCode = 429;
      }
    }
    results.push({
      status: res.statusCode || (nextCalled ? 200 : null),
      hasRetryAfter: Boolean(res.retryAfter),
      message: res.body ? res.body.message : null,
      exposesSql: res.body ? /sql|procedure|stack|bucket/i.test(String(res.body.message || '')) : false
    });
  }

  return {
    limited: results.some((result) => result.status === 429),
    lastStatus: results[results.length - 1] ? results[results.length - 1].status : null,
    hasRetryAfter: results.some((result) => result.hasRetryAfter),
    exposesInternals: results.some((result) => result.exposesSql)
  };
}

async function procedureStatus() {
  const rows = await sequelize.query('SHOW PROCEDURE STATUS WHERE Db = DATABASE()', { type: QueryTypes.SELECT });
  const names = rows.map((row) => row.Name || row.name);
  const has = (name) => names.some((candidate) => String(candidate || '').toLowerCase() === name.toLowerCase());
  return {
    legacyForgotPassword: {
      SP_otp_Save: has('SP_otp_Save'),
      SP_otp_validate_code: has('SP_otp_validate_code'),
      SP_login_update_password: has('SP_login_update_password')
    },
    requiredLoginSession: {
      SP_login_by_telephone: has('SP_login_by_telephone'),
      SP_login_by_idlogin: has('SP_login_by_idlogin'),
      SP_Close_session: has('SP_Close_session')
    }
  };
}

async function status() {
  await assertNotProduction();
  const identity = await dbIdentity();
  const hasResetTable = await tableExists('auth_password_reset_tokens');
  const hasRefreshTable = await tableExists('refresh_token');
  const fixtureRows = await sequelize.query(
    `SELECT id_login, telephone, active
       FROM login
      WHERE id_login IN (:ids)
      ORDER BY id_login`,
    { replacements: { ids: fixtureIds() }, type: QueryTypes.SELECT }
  );
  const sessionCounts = await sequelize.query(
    `SELECT COUNT(*) AS total
       FROM \`session\`
      WHERE id_login IN (:ids)`,
    { replacements: { ids: fixtureIds() }, type: QueryTypes.SELECT }
  );
  const refreshCounts = hasRefreshTable ? await sequelize.query(
    `SELECT COUNT(*) AS total, SUM(CASE WHEN last = 1 THEN 1 ELSE 0 END) AS active_count
       FROM refresh_token
      WHERE id_login IN (:ids)`,
    { replacements: { ids: fixtureIds() }, type: QueryTypes.SELECT }
  ) : [{ total: 0, active_count: 0 }];
  const resetCounts = hasResetTable ? await sequelize.query(
    `SELECT status, COUNT(*) AS total
       FROM auth_password_reset_tokens
      WHERE id_login IN (:ids)
         OR phone_normalized IN (:phones)
      GROUP BY status
      ORDER BY status`,
    { replacements: { ids: fixtureIds(), phones: fixturePhones() }, type: QueryTypes.SELECT }
  ) : [];

  return {
    runtimeEnv: getRuntimeEnv(),
    productionLike: SecurityConfig.isProductionLike(),
    database: {
      name: identity.database_name || null,
      host: identity.database_host || null,
      port: identity.database_port || null,
      productionLikeNameOrHost: looksProductionLikeDatabase(identity)
    },
    env: {
      allowQaFixtures: process.env.ALLOW_QA_AUTH_FIXTURES === 'true',
      allowTechnicalQa: process.env.ALLOW_AUTH_TECHNICAL_QA === 'true',
      runRateLimit: process.env.AUTH_QA_RUN_RATE_LIMIT === 'true',
      runInjection: process.env.AUTH_QA_RUN_INJECTION === 'true',
      runBrowser: process.env.AUTH_QA_RUN_BROWSER === 'true',
      hasQaPassword: Boolean(process.env.QA_AUTH_PASSWORD),
      hasQaResetEmailTo: Boolean(process.env.QA_AUTH_RESET_EMAIL_TO),
      requireActiveSession: SecurityConfig.isActiveSessionRequired(),
      refreshSecretConfigured: SecurityConfig.getRefreshTokenSecretState().configured,
      refreshSecretWeak: SecurityConfig.getRefreshTokenSecretState().isWeak,
      passwordResetSecretConfigured: SecurityConfig.getPasswordResetCodeSecretState().configured,
      passwordResetSecretWeak: SecurityConfig.getPasswordResetCodeSecretState().isWeak
    },
    tables: {
      authPasswordResetTokens: hasResetTable,
      refreshToken: hasRefreshTable
    },
    storedProcedures: await procedureStatus(),
    fixtures: {
      users: fixtureRows.map((row) => ({
        id_login: row.id_login,
        telephone: row.telephone,
        active: row.active
      })),
      sessionCount: Number(sessionCounts[0] ? sessionCounts[0].total : 0),
      refreshTokenCount: Number(refreshCounts[0] ? refreshCounts[0].total || 0 : 0),
      activeRefreshTokenCount: Number(refreshCounts[0] ? refreshCounts[0].active_count || 0 : 0),
      resetChallengeCounts: resetCounts
    }
  };
}

async function up() {
  await assertWriteAllowed('up');
  await requirePasswordResetTable();
  const normalRole = await roleByCode(USERS.userA.roleCode);
  const superAdminRole = await roleByCode(USERS.superAdmin.roleCode);
  if (!normalRole) {
    throw new Error('No se encontro rol activo admin.');
  }

  const passwordHash = await encript(process.env.QA_AUTH_PASSWORD);
  const transaction = await sequelize.transaction();
  try {
    await ensureBusiness(transaction);
    await ensureLogin(USERS.userA, normalRole, passwordHash, transaction);
    await ensureLogin(USERS.userB, normalRole, passwordHash, transaction);
    await ensureLogin(USERS.userC, normalRole, passwordHash, transaction);
    if (superAdminRole) {
      await ensureLogin(USERS.superAdmin, superAdminRole, passwordHash, transaction);
    }
    await resetAuthState(transaction);
    await transaction.commit();
  } catch (error) {
    await transaction.rollback();
    throw error;
  }

  return {
    createdBy: CREATED_BY,
    users: [
      USERS.userA,
      USERS.userB,
      USERS.userC,
      ...(superAdminRole ? [USERS.superAdmin] : [])
    ].map((user) => ({
      id_login: user.id,
      phone: user.phone,
      roleCode: user.roleCode,
      email_masked: PasswordResetTokenService.maskEmail(user.email)
    })),
    superAdminFixture: superAdminRole ? 'created' : 'blocked_role_not_found'
  };
}

async function validate() {
  await assertWriteAllowed('validate');
  await requirePasswordResetTable();
  const oldPassword = process.env.QA_AUTH_PASSWORD;
  const newPassword = `${oldPassword}Final9`;
  const results = {};

  await resetAuthState();

  const validLogin = await login(USERS.userA, oldPassword, false);
  const validDecoded = decodeAccessToken(validLogin);
  const noRefreshRows = await refreshRows(USERS.userA.id);
  results.login = {
    validLogin: safeResponse(validLogin),
    hasAccessToken: Boolean(validLogin.data && validLogin.data.token),
    jwtHasLoginAndSession: Boolean(validDecoded && validDecoded.id_login && validDecoded.id_session),
    refreshFalseHasRefreshToken: Boolean(validLogin.data && validLogin.data.refresh_token),
    activeRefreshRowsAfterRefreshFalse: noRefreshRows.filter((row) => Number(row.last) === 1).length,
    invalidPhone400: runPayloadValidation('login', { param: 'abc', pwd: 'sample', refresh: false }),
    missingPassword400: runPayloadValidation('login', { param: USERS.userA.phone, refresh: false }),
    badCredentialsDaoInternal: safeResponse(await login(USERS.userA, `${oldPassword}x`, false)),
    badCredentialsPublicApi: await runAuthRoute({
      payloadType: 'login',
      rateType: 'login',
      handler: 'login',
      body: { param: USERS.userA.phone, pwd: `${oldPassword}x`, refresh: false },
      url: '/api/auth/login'
    })
  };

  const loginWithRefresh = await login(USERS.userA, oldPassword, true);
  const loginRefreshToken = loginWithRefresh && loginWithRefresh.data ? loginWithRefresh.data.refresh_token : null;
  const initialRows = await refreshRows(USERS.userA.id);
  const initialActive = initialRows.find((row) => Number(row.last) === 1);
  const refreshResponse = await refreshToken(loginRefreshToken);
  const rotatedRows = await refreshRows(USERS.userA.id);
  const oldRow = rotatedRows.find((row) => initialActive && row.id_refresh_token === initialActive.id_refresh_token);
  const newRow = rotatedRows.find((row) => Number(row.last) === 1);
  const rotatedRefreshToken = refreshResponse && refreshResponse.data ? refreshResponse.data.refresh_token : null;
  const reuseResponse = await refreshToken(loginRefreshToken);
  const reuseRows = await refreshRows(USERS.userA.id);
  const reusedOld = reuseRows.find((row) => initialActive && row.id_refresh_token === initialActive.id_refresh_token);
  results.refresh = {
    loginWithRefresh: safeResponse(loginWithRefresh),
    hasRefreshToken: Boolean(loginRefreshToken),
    rowHasSession: Boolean(initialActive && initialActive.id_session),
    tokenHashLength: initialActive && initialActive.token_hash ? initialActive.token_hash.length : 0,
    fingerprintLength: initialActive && initialActive.token_fingerprint ? initialActive.token_fingerprint.length : 0,
    rawTokenStored: Boolean(initialActive && loginRefreshToken && initialActive.token_hash === loginRefreshToken),
    rotation: {
      response: safeResponse(refreshResponse),
      newRefreshReturned: Boolean(rotatedRefreshToken),
      oldLast: oldRow ? Number(oldRow.last) : null,
      oldRevoked: Boolean(oldRow && oldRow.revoked_at),
      sameFamily: Boolean(oldRow && newRow && oldRow.family_id === newRow.family_id),
      hashChanged: Boolean(oldRow && newRow && oldRow.token_hash !== newRow.token_hash)
    },
    reuseDetection: {
      response: safeResponse(reuseResponse),
      reusedAtSet: Boolean(reusedOld && reusedOld.reused_at),
      activeFamilyRows: reuseRows.filter((row) => oldRow && row.family_id === oldRow.family_id && Number(row.last) === 1).length,
      securityEvent: reuseResponse && reuseResponse.securityEvent ? reuseResponse.securityEvent.event : null
    }
  };

  const logoutLogin = await login(USERS.userC, oldPassword, true);
  const logoutRefreshToken = logoutLogin && logoutLogin.data ? logoutLogin.data.refresh_token : null;
  const logoutDecoded = decodeAccessToken(logoutLogin);
  const logoutResponse = await AuthDao.close({
    id_login: logoutDecoded.id_login,
    id_session: logoutDecoded.id_session
  });
  const logoutProtectedStatus = await protectedMiddlewareStatus(logoutDecoded);
  const logoutRefreshResponse = await refreshToken(logoutRefreshToken);
  results.logout = {
    response: safeResponse(logoutResponse),
    protectedStatusAfterClose: logoutProtectedStatus.status,
    refreshAfterClose: safeResponse(logoutRefreshResponse),
    sessionActiveAfterClose: await SessionDao.checkActiveSession(logoutDecoded.id_login, logoutDecoded.id_session)
  };

  const superAdminRole = await roleByCode(USERS.superAdmin.roleCode);
  if (superAdminRole) {
    const targetLogin = await login(USERS.userB, oldPassword, true);
    const targetDecoded = decodeAccessToken(targetLogin);
    const adminLogin = await login(USERS.superAdmin, oldPassword, true);
    const adminDecoded = decodeAccessToken(adminLogin);
    const actor = {
      actorLoginId: adminDecoded.id_login,
      actorRole: 'super_admin',
      actorSessionId: adminDecoded.id_session,
      ip: '127.0.0.1',
      userAgent: QA_USER_AGENT
    };
    const closeOne = await SuperAdminDao.closeSession(targetDecoded.id_session, actor, {
      confirmation: 'CERRAR',
      reason: 'QA auth final regression'
    });
    const targetProtected = await protectedMiddlewareStatus(targetDecoded);
    const ownClose = await SuperAdminDao.closeSession(adminDecoded.id_session, actor, {
      confirmation: 'CERRAR',
      reason: 'QA own close check'
    });
    results.superAdmin = {
      fixture: 'available',
      closeIndividual: safeResponse(closeOne),
      targetProtectedStatusAfterClose: targetProtected.status,
      ownCloseBlockedStatus: ownClose.status,
      ownCloseBlocked: Number(ownClose.status) === 403
    };
  } else {
    results.superAdmin = {
      fixture: 'blocked_role_not_found'
    };
  }

  if (!process.env.QA_AUTH_RESET_EMAIL_TO) {
    process.env.EMAIL_PROVIDER = 'disabled';
    process.env.NODE_ENV = 'test';
  }
  await resetAuthState();
  const beforeResetLogin = await login(USERS.userA, oldPassword, true);
  const beforeResetDecoded = decodeAccessToken(beforeResetLogin);
  const beforeResetRefresh = beforeResetLogin && beforeResetLogin.data ? beforeResetLogin.data.refresh_token : null;
  const knownRecovery = await AuthDao.sendOtpRecoverPassword(USERS.userA.phone, {
    ip: '127.0.0.1',
    userAgent: QA_USER_AGENT
  });
  const knownRows = await resetRowsForUser(USERS.userA.id);
  const unknownRecovery = await AuthDao.sendOtpRecoverPassword('9993999999', {
    ip: '127.0.0.1',
    userAgent: QA_USER_AGENT
  });
  await AuthDao.sendOtpRecoverPassword(USERS.userB.phone, {
    ip: '127.0.0.1',
    userAgent: QA_USER_AGENT
  });
  const maxAttempts = SecurityConfig.getPasswordResetMaxAttempts();
  let wrongCodeResponse = null;
  for (let index = 0; index < maxAttempts; index += 1) {
    wrongCodeResponse = await AuthDao.validateOtp({ telephone: USERS.userB.phone, code: '000000' });
  }
  const userBRows = await resetRowsForUser(USERS.userB.id);
  const controlled = await insertChallenge(USERS.userA, { status: 'pending' });
  const validCodeResponse = await AuthDao.validateOtp({ telephone: USERS.userA.phone, code: controlled.code });
  const resetResponse = await AuthDao.reseetPassword({
    phone: USERS.userA.phone,
    otp: controlled.code,
    password: newPassword,
    confirmPassword: newPassword
  });
  const afterResetRows = await resetRowsForUser(USERS.userA.id);
  const oldAccessStatus = await protectedMiddlewareStatus(beforeResetDecoded);
  const oldRefreshAfterReset = await refreshToken(beforeResetRefresh);
  const oldPasswordLogin = await login(USERS.userA, oldPassword, false);
  const newPasswordLogin = await login(USERS.userA, newPassword, false);
  const expired = await insertChallenge(USERS.userB, { expired: true });
  const expiredResponse = await AuthDao.validateOtp({ telephone: USERS.userB.phone, code: expired.code });
  const expiredRows = await resetRowsForUser(USERS.userB.id);
  results.forgotPassword = {
    sendOtpKnown: safeResponse(knownRecovery),
    sendOtpUnknown: safeResponse(unknownRecovery),
    knownPendingCount: knownRows.filter((row) => row.status === 'pending').length,
    knownHasCodeHash: knownRows.some((row) => row.code_hash && row.code_hash.length === 64),
    rawCodeStored: knownRows.some((row) => row.code_hash === controlled.code),
    wrongCode: {
      response: safeResponse(wrongCodeResponse),
      locked: userBRows.some((row) => row.status === 'locked')
    },
    validCode: {
      response: safeResponse(validCodeResponse),
      codeFingerprint: controlled.code_fingerprint,
      rawCodePrinted: false
    },
    reset: {
      response: safeResponse(resetResponse),
      notificationSentOrMocked: Boolean(resetResponse.securityEvent && resetResponse.securityEvent.notification_sent),
      challengeUsed: afterResetRows.some((row) => row.code_fingerprint === controlled.code_fingerprint && row.status === 'used'),
      oldAccessProtectedStatus: oldAccessStatus.status,
      oldRefreshResponse: safeResponse(oldRefreshAfterReset),
      oldPasswordFails: !safeResponse(oldPasswordLogin).successCompatible,
      newPasswordSucceeds: safeResponse(newPasswordLogin).successCompatible
    },
    expired: {
      response: safeResponse(expiredResponse),
      markedExpired: expiredRows.some((row) => row.code_fingerprint === expired.code_fingerprint && row.status === 'expired')
    },
    emailMode: process.env.QA_AUTH_RESET_EMAIL_TO ? 'sandbox_or_real_configured' : 'mock_disabled_provider'
  };

  return {
    results,
    noSecretsPrinted: true,
    noTokensPrinted: true,
    noRecoveryCodesPrinted: true
  };
}

async function security() {
  await assertNotProduction();
  const badLoginDao = await login(USERS.userA, '__qa_bad_password__', false);
  const wrongCodeDao = await AuthDao.validateOtp({ telephone: USERS.userA.phone, code: '000000' });
  const resetNoChallengeDao = await AuthDao.reseetPassword({
    phone: USERS.userA.phone,
    otp: '000000',
    password: 'Password123'
  });
  const badLoginPublic = await runAuthRoute({
    payloadType: 'login',
    rateType: 'login',
    handler: 'login',
    body: { param: USERS.userA.phone, pwd: '__qa_bad_password__', refresh: false },
    url: '/api/auth/login'
  });
  const wrongCodePublic = await runAuthRoute({
    payloadType: 'validateOtp',
    rateType: 'validateOtp',
    handler: 'validateOtp',
    body: { telephone: USERS.userA.phone, code: '000000' },
    url: '/api/auth/validateOtp'
  });
  const resetNoChallengePublic = await runAuthRoute({
    payloadType: 'resetPassword',
    rateType: 'resetPassword',
    handler: 'ressetPassword',
    method: 'PUT',
    body: { phone: USERS.userA.phone, otp: '000000', password: 'Password123' },
    url: '/api/auth/resetPassword'
  });
  const sanitized = SecurityLogger.sanitizeMetadata({
    password: 'sample',
    pwd: 'sample',
    otp: 'sample',
    code: 'sample',
    access_token: 'sample',
    refresh_token: 'sample',
    id_refresh_token: 'sample',
    authorization: 'sample',
    smtp_secret: 'sample',
    db_password: 'sample',
    code_fingerprint: 'safe-fingerprint',
    nested: {
      token: 'sample',
      token_fingerprint: 'safe-token-fingerprint'
    }
  });

  return {
    daoInternalMessages: {
      badLogin: safeResponse(badLoginDao),
      wrongCode: safeResponse(wrongCodeDao),
      resetNoChallenge: safeResponse(resetNoChallengeDao),
      note: 'DAO interno conserva mensajes legacy; la superficie publica se valida abajo.'
    },
    publicApiMessages: {
      badLogin: badLoginPublic,
      wrongCode: wrongCodePublic,
      resetNoChallenge: resetNoChallengePublic
    },
    genericErrors: {
      publicBadLoginGeneric: /No pudimos iniciar sesion/i.test(String(badLoginPublic.message || '')),
      publicWrongCodeGeneric: /No pudimos validar/i.test(String(wrongCodePublic.message || '')),
      publicResetGeneric: /No pudimos actualizar/i.test(String(resetNoChallengePublic.message || '')),
      publicBadLoginNoSql: !/sql|procedure|stack/i.test(String(badLoginPublic.message || '')),
      publicWrongCodeNoSql: !/sql|procedure|stack/i.test(String(wrongCodePublic.message || '')),
      publicResetNoSql: !/sql|procedure|stack/i.test(String(resetNoChallengePublic.message || ''))
    },
    loggerSanitization: {
      passwordRedacted: sanitized.password === '[redacted]',
      otpRedacted: sanitized.otp === '[redacted]',
      codeRedacted: sanitized.code === '[redacted]',
      accessTokenRedacted: sanitized.access_token === '[redacted]',
      refreshTokenRedacted: sanitized.refresh_token === '[redacted]',
      authorizationRedacted: sanitized.authorization === '[redacted]',
      nestedTokenRedacted: sanitized.nested && sanitized.nested.token === '[redacted]',
      fingerprintsPreserved: sanitized.code_fingerprint === 'safe-fingerprint' &&
        sanitized.nested &&
        sanitized.nested.token_fingerprint === 'safe-token-fingerprint'
    }
  };
}

async function rateLimit() {
  const gate = await technicalQaGate('rate-limit', 'AUTH_QA_RUN_RATE_LIMIT');
  if (gate) return gate;
  return {
    login: runRateLimitMiddleware('login', USERS.userB.phone, 8, true),
    sendOtp: runRateLimitMiddleware('sendOtp', USERS.userB.phone, 6, false),
    validateOtp: runRateLimitMiddleware('validateOtp', USERS.userB.phone, 8, false),
    resetPassword: runRateLimitMiddleware('resetPassword', USERS.userB.phone, 8, false),
    store: 'memory',
    multiInstanceLimitation: 'El rate limit en memoria no comparte buckets entre multiples instancias.'
  };
}

function injectionPayloadCases() {
  return [
    { endpoint: 'login', field: 'param', category: 'sql_like', body: { param: "' OR '1'='1", pwd: 'Password123', refresh: false } },
    { endpoint: 'login', field: 'param', category: 'numeric_sql_like', body: { param: '9993000001 OR 1=1', pwd: 'Password123', refresh: false } },
    { endpoint: 'login', field: 'pwd', category: 'xss_like', body: { param: USERS.userA.phone, pwd: '<script>alert(1)</script>', refresh: false } },
    { endpoint: 'sendOtp', field: 'phone', category: 'object_type', body: { phone: { value: USERS.userA.phone } } },
    { endpoint: 'sendOtp', field: 'phone', category: 'long_string', body: { phone: '9'.repeat(520) } },
    { endpoint: 'validateOtp', field: 'code', category: 'xss_like', body: { telephone: USERS.userA.phone, code: '<img src=x onerror=alert(1)>' } },
    { endpoint: 'validateOtp', field: 'code', category: 'malformed_code', body: { telephone: USERS.userA.phone, code: '@@@@' } },
    { endpoint: 'resetPassword', field: 'password', category: 'confirm_mismatch', body: { phone: USERS.userA.phone, otp: '123456', password: 'Password123', confirmPassword: 'Password124' } },
    { endpoint: 'resetPassword', field: 'password', category: 'weak_password', body: { phone: USERS.userA.phone, otp: '123456', password: 'weak' } },
    { endpoint: 'resetPassword', field: 'phone', category: 'unicode_edge', body: { phone: '９９９３０００００１', otp: '123456', password: 'Password123' } }
  ];
}

async function injection() {
  const gate = await technicalQaGate('injection', 'AUTH_QA_RUN_INJECTION');
  if (gate) return gate;
  const before = await status();
  const results = injectionPayloadCases().map((testCase) => {
    const validation = runPayloadValidation(testCase.endpoint, testCase.body);
    return {
      endpoint: testCase.endpoint,
      field: testCase.field,
      category: testCase.category,
      status: validation.status,
      nextCalled: validation.nextCalled,
      noSqlMessage: validation.genericShape,
      noServerError: validation.status !== 500
    };
  });
  const after = await status();
  return {
    cases: results,
    no500: results.every((result) => result.noServerError),
    noSqlMessages: results.every((result) => result.noSqlMessage),
    noNewFixtureSessions: before.fixtures.sessionCount === after.fixtures.sessionCount,
    noNewFixtureRefreshTokens: before.fixtures.refreshTokenCount === after.fixtures.refreshTokenCount
  };
}

function readTextIfExists(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
}

async function storage() {
  await assertNotProduction();
  const root = path.resolve(__dirname, '..', '..', '..');
  const frontRoot = path.join(root, 'hemia-assistance-front-legacy');
  const files = {
    login: path.join(frontRoot, 'src', 'views', 'Auth', 'Login.vue'),
    relogin: path.join(frontRoot, 'src', 'views', 'Auth', 'ReLogin.vue'),
    remembered: path.join(frontRoot, 'src', 'utils', 'authRememberedIdentifier.js'),
    actions: path.join(frontRoot, 'src', 'store', 'modules', 'auth', 'actions.js'),
    service: path.join(frontRoot, 'src', 'services', 'core', 'auth', 'DAAuthService.js')
  };
  const loginText = readTextIfExists(files.login);
  const reloginText = readTextIfExists(files.relogin);
  const rememberedText = readTextIfExists(files.remembered);
  const authViews = `${loginText}\n${reloginText}`;
  const rememberKey = 'medsync.auth.rememberedIdentifier.v1';

  return {
    filesFound: Object.keys(files).reduce((safe, key) => {
      safe[key] = fs.existsSync(files[key]);
      return safe;
    }, {}),
    keepSessionRemoved: !/Mantener\s+sesi[oó]n\s+iniciada/i.test(authViews),
    loginRefreshTrueAbsent: !/refresh\s*=\s*true|refresh=true/i.test(authViews),
    authRefreshFalsePresent: /auth\.refresh\s*=\s*false/.test(authViews),
    rememberKeyPresent: rememberedText.indexOf(rememberKey) !== -1,
    rememberStoresOnlyIdentifier: /localStorage\.setItem\(REMEMBERED_IDENTIFIER_KEY,\s*normalized\)/.test(rememberedText),
    rememberDoesNotStorePassword: !/password|pwd|token|permissions|tenant|business|profile/i.test(rememberedText),
    forgotDoesNotPersistCodeOrPassword: !/localStorage|sessionStorage/.test(loginText.replace(/rememberIdentifier|RememberedIdentifier|REMEMBERED_IDENTIFIER_KEY/g, '')),
    noSensitiveConsoleLog: !/console\.log/.test(authViews),
    noUnsafeVHtml: !/v-html/.test(authViews),
    genericCopyPresent: /Si existe una cuenta asociada|No pudimos validar|No pudimos actualizar|No pudimos conectar/.test(loginText),
    browserAutomation: process.env.AUTH_QA_RUN_BROWSER === 'true'
      ? 'requested_but_not_implemented_without_existing_browser_tool'
      : 'not_requested'
  };
}

async function down() {
  await assertWriteAllowed('down');
  const transaction = await sequelize.transaction();
  try {
    await resetAuthState(transaction);
    await sequelize.query(
      `DELETE FROM login WHERE id_login IN (:ids)`,
      { replacements: { ids: fixtureIds() }, type: QueryTypes.DELETE, transaction }
    );
    await sequelize.query(
      `DELETE FROM business WHERE id_business = :businessId`,
      { replacements: { businessId: BUSINESS_ID }, type: QueryTypes.DELETE, transaction }
    );
    await transaction.commit();
  } catch (error) {
    await transaction.rollback();
    throw error;
  }

  const remaining = await status();
  return {
    fixturesRemoved: true,
    remainingFixtureUsers: remaining.fixtures.users.length,
    remainingSessions: remaining.fixtures.sessionCount,
    remainingRefreshTokens: remaining.fixtures.refreshTokenCount,
    remainingResetChallenges: remaining.fixtures.resetChallengeCounts
  };
}

async function full() {
  const steps = [];
  async function runStep(name, fn) {
    try {
      steps.push({ command: name, ok: true, result: await fn() });
    } catch (error) {
      steps.push({ command: name, ok: false, error: error.message });
    }
  }

  await runStep('status', status);
  await runStep('up', up);
  await runStep('validate', validate);
  await runStep('security', security);
  await runStep('rate-limit', rateLimit);
  await runStep('injection', injection);
  await runStep('storage', storage);
  await runStep('down', down);
  await runStep('status', status);

  return {
    steps,
    ok: steps.every((step) => step.ok)
  };
}

async function main() {
  const command = process.argv[2] || 'status';
  const commands = {
    status,
    up,
    validate,
    security,
    'rate-limit': rateLimit,
    injection,
    storage,
    down,
    full
  };
  if (!commands[command]) {
    throw new Error(`Comando no soportado: ${command}`);
  }

  const result = await commands[command]();
  console.log(JSON.stringify({ command, ok: true, result }, null, 2));
}

main()
  .then(async () => {
    await sequelize.close();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error(JSON.stringify({
      ok: false,
      error: error.message
    }, null, 2));
    try {
      await sequelize.close();
    } catch (closeError) {
      console.error(JSON.stringify({ ok: false, closeError: closeError.message }));
    }
    process.exit(1);
  });

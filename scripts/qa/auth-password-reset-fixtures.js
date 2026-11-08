require('../../src/config/env');

const jwt = require('jsonwebtoken');
const { QueryTypes } = require('sequelize');
const sequelize = require('../../src/db/Sequelize.connection');
const SecurityConfig = require('../../src/config/security');
const AuthDao = require('../../src/Dao/mysql/auth.dao');
const SessionDao = require('../../src/Dao/mysql/session.Dao');
const awaitHandlerFactory = require('../../src/middleware/awaitHandlerFactory.middleware');
const validateAuthPayload = require('../../src/middleware/authPayloadValidation.middleware').validateAuthPayload;
const authRateLimit = require('../../src/middleware/authRateLimit.middleware');
const PasswordResetTokenService = require('../../src/services/security/passwordResetToken.service');
const SecurityLogger = require('../../src/services/security/securityLogger.service');
const { encript } = require('../../src/util/bcrypt');

const CREATED_BY = 'QA_AUTH_PASSWORD_RESET_FIXTURES';
const BUSINESS_ID = 'QA_AUTH_PASSWORD_RESET_BUSINESS';
const USERS = {
  userA: {
    id: 'QA_AUTH_RESET_USER_A',
    name: 'QA Auth Reset User A',
    email: process.env.QA_AUTH_RESET_EMAIL_TO || 'qa.auth.reset.a@example.test',
    phone: '9992000001',
    roleCode: 'admin'
  },
  userB: {
    id: 'QA_AUTH_RESET_USER_B',
    name: 'QA Auth Reset User B',
    email: process.env.QA_AUTH_RESET_EMAIL_TO || 'qa.auth.reset.b@example.test',
    phone: '9992000002',
    roleCode: 'admin'
  }
};

function assertNotProduction() {
  if (SecurityConfig.isProductionLike()) {
    throw new Error('Abortado: ambiente production-like detectado.');
  }
}

function assertWriteAllowed(command) {
  assertNotProduction();
  if (process.env.ALLOW_QA_AUTH_FIXTURES !== 'true') {
    throw new Error(`${command} escribe datos QA. Requiere ALLOW_QA_AUTH_FIXTURES=true.`);
  }
}

function assertPasswordAvailable(command) {
  if (!process.env.QA_AUTH_PASSWORD) {
    throw new Error(`${command} requiere QA_AUTH_PASSWORD configurado.`);
  }
}

function safeResponse(response) {
  const status = response ? Number(response.status) : null;
  return {
    status,
    successCompatible: Boolean(status && status >= 200 && status < 300),
    message: response ? response.message : null
  };
}

function maskEmail(email) {
  return PasswordResetTokenService.maskEmail(email);
}

function decodeAccessToken(response) {
  const rawToken = response && response.data ? response.data.token : null;
  return rawToken ? jwt.decode(rawToken) : null;
}

function fixtureIds() {
  return Object.values(USERS).map((user) => user.id);
}

function fixturePhones() {
  return Object.values(USERS).map((user) => user.phone);
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
    throw new Error('La tabla auth_password_reset_tokens no existe. Ejecuta primero la migracion 2C.');
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
        :id, 'QA Auth Password Reset Clinic', 'QA Auth Password Reset Clinic',
        'qa-auth-password-reset-clinic', 'qa.auth.reset.business@example.test',
        '9992000000', 'QA fixture local/dev', 'active', 'enterprise',
        1, 'active', NOW(), NOW(), :createdBy
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
        businessId: BUSINESS_ID,
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
  await requirePasswordResetTable();
  await sequelize.query(
    `DELETE FROM auth_password_reset_tokens
      WHERE id_login IN (:ids)
         OR identifier_normalized IN (:phones)`,
    { replacements: { ids: fixtureIds(), phones: fixturePhones() }, type: QueryTypes.DELETE, transaction }
  );
  await sequelize.query(
    `DELETE FROM refresh_token WHERE id_login IN (:ids)`,
    { replacements: { ids: fixtureIds() }, type: QueryTypes.DELETE, transaction }
  );
  await sequelize.query(
    `DELETE FROM \`session\` WHERE id_login IN (:ids)`,
    { replacements: { ids: fixtureIds() }, type: QueryTypes.DELETE, transaction }
  );
}

async function resetRowsForUser(userId) {
  return sequelize.query(
    `SELECT id, id_login, identifier_normalized, code_hash, code_fingerprint, status,
            attempts, max_attempts, expires_at, verified_at, used_at, revoked_at, locked_at, expired_at
       FROM auth_password_reset_tokens
      WHERE id_login COLLATE utf8mb4_unicode_ci = :userId COLLATE utf8mb4_unicode_ci
      ORDER BY id DESC`,
    { replacements: { userId }, type: QueryTypes.SELECT }
  );
}

async function sessionRows(userId) {
  return sequelize.query(
    `SELECT id_session, active, last
       FROM \`session\`
      WHERE id_login COLLATE utf8mb4_unicode_ci = :userId COLLATE utf8mb4_unicode_ci
      ORDER BY created_at DESC`,
    { replacements: { userId }, type: QueryTypes.SELECT }
  );
}

async function refreshRows(userId) {
  return sequelize.query(
    `SELECT id_refresh_token, id_session, token_hash, token_fingerprint, revoked_at, revoked_reason, last
       FROM refresh_token
      WHERE id_login COLLATE utf8mb4_unicode_ci = :userId COLLATE utf8mb4_unicode_ci
      ORDER BY created_at DESC`,
    { replacements: { userId }, type: QueryTypes.SELECT }
  );
}

async function insertChallenge(user, options = {}) {
  const tokenRecord = PasswordResetTokenService.buildCodeRecord(user.email);
  const ttlSql = options.expired
    ? 'DATE_SUB(NOW(), INTERVAL 1 MINUTE)'
    : 'DATE_ADD(NOW(), INTERVAL :ttlMinutes MINUTE)';

  await sequelize.query(
    `INSERT INTO auth_password_reset_tokens (
        id_login, identifier_normalized, destination_email_fingerprint, code_hash, code_fingerprint,
        purpose, status, attempts, max_attempts, issued_at, expires_at,
        requested_ip, requested_user_agent, created_at, updated_at
      ) VALUES (
        :idLogin, :phone, :emailFingerprint, :codeHash, :codeFingerprint,
        :purpose, :status, :attempts, :maxAttempts, NOW(), ${ttlSql},
        '127.0.0.1', 'QA_AUTH_PASSWORD_RESET_FIXTURE', NOW(), NOW()
      )`,
    {
      replacements: {
        idLogin: user.id,
        phone: user.email,
        emailFingerprint: PasswordResetTokenService.fingerprintEmail(user.email),
        codeHash: tokenRecord.code_hash,
        codeFingerprint: tokenRecord.code_fingerprint,
        purpose: PasswordResetTokenService.PURPOSE,
        status: options.status || 'pending',
        attempts: options.attempts || 0,
        maxAttempts: options.maxAttempts || SecurityConfig.getPasswordResetMaxAttempts(),
        ttlMinutes: SecurityConfig.getPasswordResetCodeTtlMinutes()
      },
      type: QueryTypes.INSERT
    }
  );

  return {
    code: tokenRecord.code,
    code_fingerprint: tokenRecord.code_fingerprint
  };
}

async function protectedMiddlewareStatus(decodedToken) {
  const req = {
    tokenDecode: decodedToken,
    ip: '127.0.0.1',
    method: 'GET',
    originalUrl: '/qa/protected',
    get: () => 'QA_AUTH_PASSWORD_RESET_FIXTURE'
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
    nextCalled
  };
}

function runRateLimit(type, phone, attempts) {
  if (authRateLimit._private && authRateLimit._private.buckets) {
    authRateLimit._private.buckets.clear();
  }

  const middleware = authRateLimit(type);
  const results = [];
  for (let index = 0; index < attempts; index += 1) {
    const req = {
      ip: `127.0.0.${type.length}`,
      authIdentity: { phone },
      method: 'POST',
      originalUrl: `/api/auth/${type}`,
      get: () => 'QA_AUTH_PASSWORD_RESET_FIXTURE'
    };
    const res = {
      statusCode: null,
      body: null,
      setHeader() {},
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
    results.push({ status: res.statusCode || (nextCalled ? 200 : null) });
  }

  return {
    limited: results.some((result) => result.status === 429),
    lastStatus: results[results.length - 1] ? results[results.length - 1].status : null
  };
}

async function login(user, password, refresh) {
  return AuthDao.login({
    param: user.phone,
    pwd: password,
    refresh
  }, {
    ip: '127.0.0.1',
    userAgent: 'QA_AUTH_PASSWORD_RESET_FIXTURE'
  });
}

async function refreshToken(rawRefreshToken) {
  return AuthDao.refreshToken({ id_refresh_token: rawRefreshToken }, {
    ip: '127.0.0.1',
    userAgent: 'QA_AUTH_PASSWORD_RESET_FIXTURE'
  });
}

async function status() {
  assertNotProduction();
  const hasTable = await tableExists('auth_password_reset_tokens');
  const columns = hasTable ? await sequelize.query('DESCRIBE auth_password_reset_tokens', { type: QueryTypes.SELECT }) : [];
  const indexes = hasTable ? await sequelize.query('SHOW INDEX FROM auth_password_reset_tokens', { type: QueryTypes.SELECT }) : [];
  const fixtureUsers = await sequelize.query(
    `SELECT id_login, telephone, active
       FROM login
      WHERE id_login IN (:ids)
      ORDER BY id_login`,
    { replacements: { ids: fixtureIds() }, type: QueryTypes.SELECT }
  );
  const challengeCounts = hasTable ? await sequelize.query(
    `SELECT status, COUNT(*) AS total
       FROM auth_password_reset_tokens
      WHERE id_login IN (:ids)
         OR identifier_normalized IN (:phones)
      GROUP BY status
      ORDER BY status`,
    { replacements: { ids: fixtureIds(), phones: fixturePhones() }, type: QueryTypes.SELECT }
  ) : [];

  return {
    productionLike: SecurityConfig.isProductionLike(),
    requireActiveSession: SecurityConfig.isActiveSessionRequired(),
    allowQaFixtures: process.env.ALLOW_QA_AUTH_FIXTURES === 'true',
    hasQaPassword: Boolean(process.env.QA_AUTH_PASSWORD),
    hasQaResetEmailTo: Boolean(process.env.QA_AUTH_RESET_EMAIL_TO),
    passwordResetSecretConfigured: SecurityConfig.getPasswordResetCodeSecretState().configured,
    passwordResetSecretWeak: SecurityConfig.getPasswordResetCodeSecretState().isWeak,
    refreshSecretConfigured: SecurityConfig.getRefreshTokenSecretState().configured,
    refreshSecretWeak: SecurityConfig.getRefreshTokenSecretState().isWeak,
    tableExists: hasTable,
    requiredColumnsPresent: [
      'id',
      'id_login',
      'identifier_normalized',
      'destination_email_fingerprint',
      'code_hash',
      'code_fingerprint',
      'purpose',
      'status',
      'attempts',
      'max_attempts',
      'issued_at',
      'expires_at',
      'verified_at',
      'used_at',
      'revoked_at',
      'locked_at',
      'requested_ip',
      'requested_user_agent',
      'created_at',
      'updated_at'
    ].every((field) => columns.some((column) => column.Field === field)),
    indexNames: Array.from(new Set(indexes.map((index) => index.Key_name))).sort(),
    fixtureUsers: fixtureUsers.map((user) => ({
      id_login: user.id_login,
      telephone: user.telephone,
      active: user.active
    })),
    challengeCounts
  };
}

async function up() {
  assertWriteAllowed('up');
  assertPasswordAvailable('up');
  await requirePasswordResetTable();

  const role = await roleByCode(USERS.userA.roleCode);
  if (!role) {
    throw new Error('No se encontro rol activo admin.');
  }

  const passwordHash = await encript(process.env.QA_AUTH_PASSWORD);
  const transaction = await sequelize.transaction();
  try {
    await ensureBusiness(transaction);
    await ensureLogin(USERS.userA, role, passwordHash, transaction);
    await ensureLogin(USERS.userB, role, passwordHash, transaction);
    await resetAuthState(transaction);
    await transaction.commit();
  } catch (error) {
    await transaction.rollback();
    throw error;
  }

  return {
    createdBy: CREATED_BY,
    users: Object.values(USERS).map((user) => ({
      id_login: user.id,
      phone: user.phone,
      email_masked: maskEmail(user.email)
    }))
  };
}

async function validate() {
  assertWriteAllowed('validate');
  assertPasswordAvailable('validate');
  await requirePasswordResetTable();

  const oldPassword = process.env.QA_AUTH_PASSWORD;
  const newPassword = `${oldPassword}Reset9`;
  const results = {};

  await resetAuthState();

  const loginBefore = await login(USERS.userA, oldPassword, true);
  const oldAccessDecoded = decodeAccessToken(loginBefore);
  const oldRefreshToken = loginBefore && loginBefore.data ? loginBefore.data.refresh_token : null;
  results.loginBeforeReset = {
    response: safeResponse(loginBefore),
    hasAccessToken: Boolean(loginBefore.data && loginBefore.data.token),
    hasRefreshToken: Boolean(oldRefreshToken),
    tokenPrinted: false
  };

  const previous = await insertChallenge(USERS.userA, { status: 'pending' });
  if (!process.env.QA_AUTH_RESET_EMAIL_TO) {
    process.env.EMAIL_PROVIDER = 'disabled';
    process.env.NODE_ENV = 'test';
  }
  const requestRecovery = await AuthDao.sendOtpRecoverPassword(USERS.userA.email, {
    ip: '127.0.0.1',
    userAgent: 'QA_AUTH_PASSWORD_RESET_FIXTURE'
  });
  const recoveryRows = await resetRowsForUser(USERS.userA.id);
  results.requestRecovery = {
    response: safeResponse(requestRecovery),
    emailMode: process.env.QA_AUTH_RESET_EMAIL_TO ? 'configured_smtp_or_provider' : 'mock_disabled_provider',
    pendingCount: recoveryRows.filter((row) => row.status === 'pending').length,
    previousChallengeRevoked: recoveryRows.some((row) => row.code_fingerprint === previous.code_fingerprint && row.status === 'revoked'),
    hasCodeHash: recoveryRows.some((row) => row.code_hash && row.code_hash.length === 64),
    hasCodeFingerprint: recoveryRows.some((row) => row.code_fingerprint && row.code_fingerprint.length === 32),
    hasExpiresAt: recoveryRows.some((row) => Boolean(row.expires_at)),
    rawCodeStored: recoveryRows.some((row) => row.code_hash === previous.code)
  };

  await AuthDao.sendOtpRecoverPassword(USERS.userB.email, {
    ip: '127.0.0.1',
    userAgent: 'QA_AUTH_PASSWORD_RESET_FIXTURE'
  });
  const maxAttempts = SecurityConfig.getPasswordResetMaxAttempts();
  let wrongResponse = null;
  for (let index = 0; index < maxAttempts; index += 1) {
    wrongResponse = await AuthDao.validateOtp({ email: USERS.userB.email, code: '000000' });
  }
  const userBRows = await resetRowsForUser(USERS.userB.id);
  results.wrongCodeAndLock = {
    lastResponse: safeResponse(wrongResponse),
    locked: userBRows.some((row) => row.status === 'locked'),
    maxAttempts,
    attemptsReachedMax: userBRows.some((row) => Number(row.attempts) >= maxAttempts)
  };

  const controlled = await insertChallenge(USERS.userA, { status: 'pending' });
  const validResponse = await AuthDao.validateOtp({ email: USERS.userA.email, code: controlled.code });
  const verifiedRows = await resetRowsForUser(USERS.userA.id);
  results.validCode = {
    response: safeResponse(validResponse),
    codeSource: 'fixture_internal_not_printed',
    verified: verifiedRows.some((row) => row.code_fingerprint === controlled.code_fingerprint && row.status === 'verified'),
    verifiedAtSet: verifiedRows.some((row) => row.code_fingerprint === controlled.code_fingerprint && Boolean(row.verified_at)),
    codeFingerprint: controlled.code_fingerprint
  };

  const resetResponse = await AuthDao.reseetPassword({
    email: USERS.userA.email,
    otp: controlled.code,
    password: newPassword
  });
  const afterResetRows = await resetRowsForUser(USERS.userA.id);
  const sessionsAfterReset = await sessionRows(USERS.userA.id);
  const refreshAfterReset = await refreshRows(USERS.userA.id);
  const oldAccessStatus = await protectedMiddlewareStatus(oldAccessDecoded);
  const oldRefreshResponse = await refreshToken(oldRefreshToken);
  results.resetPassword = {
    response: safeResponse(resetResponse),
    notificationSentOrMocked: Boolean(resetResponse.securityEvent && resetResponse.securityEvent.notification_sent),
    used: afterResetRows.some((row) => row.code_fingerprint === controlled.code_fingerprint && row.status === 'used'),
    usedAtSet: afterResetRows.some((row) => row.code_fingerprint === controlled.code_fingerprint && Boolean(row.used_at)),
    activeChallengesRemaining: afterResetRows.filter((row) => ['pending', 'verified'].includes(row.status)).length,
    sessionsInactive: sessionsAfterReset.every((row) => Number(row.active) === 0 && Number(row.last) === 0),
    refreshTokensRevoked: refreshAfterReset.every((row) => Number(row.last) === 0 || Boolean(row.revoked_at)),
    oldAccessProtectedStatus: oldAccessStatus.status,
    oldRefreshResponse: safeResponse(oldRefreshResponse)
  };

  const oldLoginAfterReset = await login(USERS.userA, oldPassword, false);
  const newLoginAfterReset = await login(USERS.userA, newPassword, false);
  results.loginAfterReset = {
    oldPasswordFails: !safeResponse(oldLoginAfterReset).successCompatible,
    newPasswordSucceeds: safeResponse(newLoginAfterReset).successCompatible,
    newLoginHasAccessToken: Boolean(newLoginAfterReset.data && newLoginAfterReset.data.token)
  };

  const expired = await insertChallenge(USERS.userB, { expired: true });
  const expiredResponse = await AuthDao.validateOtp({ email: USERS.userB.email, code: expired.code });
  const expiredRows = await resetRowsForUser(USERS.userB.id);
  const resetWithoutVerified = await AuthDao.reseetPassword({
    email: USERS.userB.email,
    otp: expired.code,
    password: newPassword
  });
  results.negativeCases = {
    unknownPhoneGeneric: safeResponse(await AuthDao.sendOtpRecoverPassword('missing@example.test')),
    invalidPhone400: runPayloadValidation('sendOtp', { phone: 'abc' }),
    invalidCodeShape400: runPayloadValidation('validateOtp', { email: USERS.userA.email, code: '@@@' }),
    weakPassword400: runPayloadValidation('resetPassword', { email: USERS.userA.email, otp: '123456', password: 'weak' }),
    confirmMismatch400: runPayloadValidation('resetPassword', {
      email: USERS.userA.email,
      otp: '123456',
      password: 'Password123',
      confirmPassword: 'Password124'
    }),
    expiredMarked: expiredRows.some((row) => row.code_fingerprint === expired.code_fingerprint && row.status === 'expired'),
    expiredResponse: safeResponse(expiredResponse),
    resetWithoutVerified: safeResponse(resetWithoutVerified)
  };

  results.rateLimiting = {
    sendOtp: runRateLimit('sendOtp', USERS.userA.phone, 4),
    validateOtp: runRateLimit('validateOtp', USERS.userA.phone, 6),
    resetPassword: runRateLimit('resetPassword', USERS.userA.phone, 6)
  };

  results.securityLogging = {
    sanitized: SecurityLogger.sanitizeMetadata({
      password: 'sample',
      otp: 'sample',
      code: 'sample',
      access_token: 'sample',
      refresh_token: 'sample',
      authorization: 'sample',
      code_fingerprint: controlled.code_fingerprint
    }),
    rawSecretsPrinted: false
  };

  return results;
}

async function down() {
  assertWriteAllowed('down');
  await requirePasswordResetTable();
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

  const remainingUsers = await sequelize.query(
    `SELECT COUNT(*) AS total FROM login WHERE id_login IN (:ids)`,
    { replacements: { ids: fixtureIds() }, type: QueryTypes.SELECT }
  );
  const remainingChallenges = await sequelize.query(
    `SELECT COUNT(*) AS total
       FROM auth_password_reset_tokens
      WHERE id_login IN (:ids)
         OR identifier_normalized IN (:phones)`,
    { replacements: { ids: fixtureIds(), phones: fixturePhones() }, type: QueryTypes.SELECT }
  );

  return {
    fixturesRemoved: true,
    remainingFixtureUsers: Number(remainingUsers[0] ? remainingUsers[0].total : 0),
    remainingResetChallenges: Number(remainingChallenges[0] ? remainingChallenges[0].total : 0)
  };
}

async function main() {
  const command = process.argv[2] || 'status';
  let result;
  if (command === 'status') result = await status();
  else if (command === 'up') result = await up();
  else if (command === 'validate') result = await validate();
  else if (command === 'down') result = await down();
  else throw new Error(`Comando no soportado: ${command}`);

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

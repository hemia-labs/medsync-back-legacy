require('../../src/config/env');

const jwt = require('jsonwebtoken');
const { QueryTypes } = require('sequelize');
const sequelize = require('../../src/db/Sequelize.connection');
const SecurityConfig = require('../../src/config/security');
const AuthDao = require('../../src/Dao/mysql/auth.dao');
const SessionDao = require('../../src/Dao/mysql/session.Dao');
const SuperAdminDao = require('../../src/Dao/mysql/superAdmin.dao');
const awaitHandlerFactory = require('../../src/middleware/awaitHandlerFactory.middleware');
const { encript } = require('../../src/util/bcrypt');
const { v4: uuidv4 } = require('uuid');

const CREATED_BY = 'QA_AUTH_REFRESH_FIXTURES';
const BUSINESS_ID = 'QA_AUTH_REFRESH_BUSINESS';
const USERS = {
  userA: {
    id: 'QA_AUTH_REFRESH_USER_A',
    name: 'QA Auth Normal User A',
    email: 'qa.auth.user.a@example.test',
    phone: '9991000001',
    roleCode: 'admin'
  },
  userB: {
    id: 'QA_AUTH_REFRESH_USER_B',
    name: 'QA Auth Normal User B',
    email: 'qa.auth.user.b@example.test',
    phone: '9991000002',
    roleCode: 'admin'
  },
  superAdmin: {
    id: 'QA_AUTH_REFRESH_SUPER_ADMIN',
    name: 'QA Auth Super Admin',
    email: 'qa.auth.superadmin@example.test',
    phone: '9991000099',
    roleCode: 'super_admin'
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
  return {
    status: response ? response.status : null,
    success: Boolean(response && response.success),
    message: response ? response.message : null
  };
}

function decodeAccessToken(response) {
  const token = response && response.data ? response.data.token : null;
  if (!token) {
    return null;
  }
  return jwt.decode(token);
}

async function protectedMiddlewareStatus(decodedToken) {
  const req = {
    tokenDecode: decodedToken,
    ip: '127.0.0.1',
    method: 'GET',
    originalUrl: '/qa/protected',
    get: () => 'QA_AUTH_REFRESH_FIXTURE'
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

async function roleByCode(code) {
  const rows = await sequelize.query(
    `SELECT id_rol, code, desc_rol
       FROM rol
      WHERE code COLLATE utf8mb4_unicode_ci = :code COLLATE utf8mb4_unicode_ci
        AND active = 1
      LIMIT 1`,
    { replacements: { code }, type: QueryTypes.SELECT }
  );
  return rows[0] || null;
}

async function getRoles() {
  return {
    normal: await roleByCode(USERS.userA.roleCode),
    superAdmin: await roleByCode(USERS.superAdmin.roleCode)
  };
}

async function ensureBusiness(transaction) {
  await sequelize.query(
    `INSERT INTO business (
        id_business, name, legal_name, slug, email, phone, address, status, plan,
        active, subscription_status, current_period_starts_at, created_at, created_by
      ) VALUES (
        :id, 'QA Auth Refresh Clinic', 'QA Auth Refresh Clinic', 'qa-auth-refresh-clinic',
        'qa.auth.refresh.business@example.test', '9991000000', 'QA fixture local/dev',
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

async function refreshRows(idLogin) {
  return sequelize.query(
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
        last
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

async function resetAuthState(transaction = null) {
  const ids = Object.values(USERS).map((user) => user.id);
  await sequelize.query(
    `DELETE FROM refresh_token WHERE id_login IN (:ids)`,
    { replacements: { ids }, type: QueryTypes.DELETE, transaction }
  );
  await sequelize.query(
    `DELETE FROM \`session\` WHERE id_login IN (:ids)`,
    { replacements: { ids }, type: QueryTypes.DELETE, transaction }
  );
}

async function up() {
  assertWriteAllowed('up');
  assertPasswordAvailable('up');
  const roles = await getRoles();
  if (!roles.normal || !roles.superAdmin) {
    throw new Error('No se encontraron roles activos admin y/o super_admin.');
  }

  const passwordHash = await encript(process.env.QA_AUTH_PASSWORD);
  const transaction = await sequelize.transaction();
  try {
    await ensureBusiness(transaction);
    await ensureLogin(USERS.userA, roles.normal, passwordHash, transaction);
    await ensureLogin(USERS.userB, roles.normal, passwordHash, transaction);
    await ensureLogin(USERS.superAdmin, roles.superAdmin, passwordHash, transaction);
    await resetAuthState(transaction);
    await transaction.commit();
    return {
      createdBy: CREATED_BY,
      users: Object.values(USERS).map((user) => ({
        id_login: user.id,
        email: user.email,
        phone: user.phone,
        roleCode: user.roleCode
      })),
      rolesUsed: {
        normal: roles.normal,
        superAdmin: roles.superAdmin
      }
    };
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

async function status() {
  assertNotProduction();
  const columns = await sequelize.query('DESCRIBE refresh_token', { type: QueryTypes.SELECT });
  const indexes = await sequelize.query('SHOW INDEX FROM refresh_token', { type: QueryTypes.SELECT });
  const fixtureUsers = await sequelize.query(
    `SELECT id_login, email, telephone, active
       FROM login
      WHERE id_login IN (:ids)
      ORDER BY id_login`,
    { replacements: { ids: Object.values(USERS).map((user) => user.id) }, type: QueryTypes.SELECT }
  );
  const tokenCounts = await sequelize.query(
    `SELECT COUNT(*) AS total, SUM(CASE WHEN last = 1 THEN 1 ELSE 0 END) AS active_count
       FROM refresh_token
      WHERE id_login IN (:ids)`,
    { replacements: { ids: Object.values(USERS).map((user) => user.id) }, type: QueryTypes.SELECT }
  );
  return {
    productionLike: SecurityConfig.isProductionLike(),
    allowQa: process.env.ALLOW_QA_AUTH_FIXTURES === 'true',
    hasQaPassword: Boolean(process.env.QA_AUTH_PASSWORD),
    hasRefreshSecret: Boolean(process.env.REFRESH_TOKEN_SECRET),
    requiredColumnsPresent: [
      'id_session',
      'token_hash',
      'token_fingerprint',
      'family_id',
      'parent_token_hash',
      'issued_at',
      'expires_at',
      'rotated_at',
      'revoked_at',
      'revoked_reason',
      'reused_at',
      'created_ip',
      'created_user_agent'
    ].every((field) => columns.some((column) => column.Field === field)),
    indexNames: Array.from(new Set(indexes.map((index) => index.Key_name))).sort(),
    fixtureUsers,
    qaRefreshTokenCounts: tokenCounts[0] || {}
  };
}

async function login(user, refresh) {
  return AuthDao.login({
    param: user.phone,
    pwd: process.env.QA_AUTH_PASSWORD,
    refresh
  }, {
    ip: '127.0.0.1',
    userAgent: 'QA_AUTH_REFRESH_FIXTURE'
  });
}

async function refreshToken(rawRefreshToken) {
  return AuthDao.refreshToken({ id_refresh_token: rawRefreshToken }, {
    ip: '127.0.0.1',
    userAgent: 'QA_AUTH_REFRESH_FIXTURE'
  });
}

async function validate() {
  assertWriteAllowed('validate');
  assertPasswordAvailable('validate');
  await resetAuthState();

  const results = {};

  const loginNoRefresh = await login(USERS.userA, false);
  const noRefreshDecoded = decodeAccessToken(loginNoRefresh);
  const noRefreshRows = await refreshRows(USERS.userA.id);
  results.loginWithoutRefresh = {
    response: safeResponse(loginNoRefresh),
    hasAccessToken: Boolean(loginNoRefresh.data && loginNoRefresh.data.token),
    hasRefreshToken: Boolean(loginNoRefresh.data && loginNoRefresh.data.refresh_token),
    jwtHasLoginAndSession: Boolean(noRefreshDecoded && noRefreshDecoded.id_login && noRefreshDecoded.id_session),
    activeRefreshRows: noRefreshRows.filter((row) => Number(row.last) === 1).length
  };

  const loginWithRefresh = await login(USERS.userA, true);
  const loginRefreshToken = loginWithRefresh.data ? loginWithRefresh.data.refresh_token : null;
  const withRefreshDecoded = decodeAccessToken(loginWithRefresh);
  const initialRows = await refreshRows(USERS.userA.id);
  const initialActive = initialRows.find((row) => Number(row.last) === 1);
  results.loginWithRefresh = {
    response: safeResponse(loginWithRefresh),
    hasAccessToken: Boolean(loginWithRefresh.data && loginWithRefresh.data.token),
    hasRefreshToken: Boolean(loginRefreshToken),
    jwtHasLoginAndSession: Boolean(withRefreshDecoded && withRefreshDecoded.id_login && withRefreshDecoded.id_session),
    rowHasSession: Boolean(initialActive && initialActive.id_session),
    tokenHashLength: initialActive && initialActive.token_hash ? initialActive.token_hash.length : 0,
    fingerprintLength: initialActive && initialActive.token_fingerprint ? initialActive.token_fingerprint.length : 0,
    hasFamily: Boolean(initialActive && initialActive.family_id),
    hasExpiresAt: Boolean(initialActive && initialActive.expires_at),
    rawTokenStored: Boolean(initialActive && loginRefreshToken && initialActive.token_hash === loginRefreshToken),
    token_fingerprint: initialActive ? initialActive.token_fingerprint : null
  };

  const refreshResponse = await refreshToken(loginRefreshToken);
  const rotatedRows = await refreshRows(USERS.userA.id);
  const oldRow = rotatedRows.find((row) => initialActive && row.id_refresh_token === initialActive.id_refresh_token);
  const newRow = rotatedRows.find((row) => Number(row.last) === 1);
  const rotatedRefreshToken = refreshResponse.data ? refreshResponse.data.refresh_token : null;
  results.refreshRotation = {
    response: safeResponse(refreshResponse),
    newRefreshReturned: Boolean(rotatedRefreshToken),
    oldLast: oldRow ? Number(oldRow.last) : null,
    oldRotatedAt: Boolean(oldRow && oldRow.rotated_at),
    oldRevokedAt: Boolean(oldRow && oldRow.revoked_at),
    oldRevokedReason: oldRow ? oldRow.revoked_reason : null,
    sameFamily: Boolean(oldRow && newRow && oldRow.family_id === newRow.family_id),
    sessionPreserved: Boolean(oldRow && newRow && oldRow.id_session === newRow.id_session),
    hashChanged: Boolean(oldRow && newRow && oldRow.token_hash !== newRow.token_hash),
    parentMatches: Boolean(oldRow && newRow && newRow.parent_token_hash === oldRow.token_hash),
    token_fingerprint: newRow ? newRow.token_fingerprint : null
  };

  const reuseResponse = await refreshToken(loginRefreshToken);
  const reuseRows = await refreshRows(USERS.userA.id);
  const reusedOld = reuseRows.find((row) => initialActive && row.id_refresh_token === initialActive.id_refresh_token);
  results.reuseDetection = {
    response: safeResponse(reuseResponse),
    reusedAtSet: Boolean(reusedOld && reusedOld.reused_at),
    activeFamilyRows: reuseRows.filter((row) => oldRow && row.family_id === oldRow.family_id && Number(row.last) === 1).length,
    securityEvent: reuseResponse.securityEvent ? reuseResponse.securityEvent.event : null,
    revokeScope: reuseResponse.securityEvent ? reuseResponse.securityEvent.revoke_scope : null
  };

  const logoutLogin = await login(USERS.userA, true);
  const logoutDecoded = decodeAccessToken(logoutLogin);
  const logoutResponse = await AuthDao.close({
    id_login: logoutDecoded.id_login,
    id_session: logoutDecoded.id_session
  });
  const logoutSessionActive = await SessionDao.checkActiveSession(logoutDecoded.id_login, logoutDecoded.id_session);
  const logoutProtectedStatus = await protectedMiddlewareStatus(logoutDecoded);
  const logoutRows = await refreshRows(USERS.userA.id);
  results.logoutSessionRevocation = {
    logout: safeResponse(logoutResponse),
    closedSessionRejectedBySessionDao: !logoutSessionActive,
    closedSessionProtectedStatus: logoutProtectedStatus.status,
    revokedRowsForSession: logoutRows.filter((row) => row.id_session === logoutDecoded.id_session && Number(row.last) === 0).length
  };

  const targetLogin = await login(USERS.userB, true);
  const targetDecoded = decodeAccessToken(targetLogin);
  const adminLogin = await login(USERS.superAdmin, true);
  const adminDecoded = decodeAccessToken(adminLogin);
  const actor = {
    actorLoginId: adminDecoded.id_login,
    actorRole: 'super_admin',
    actorSessionId: adminDecoded.id_session,
    ip: '127.0.0.1',
    userAgent: 'QA_AUTH_REFRESH_FIXTURE'
  };
  const closeOne = await SuperAdminDao.closeSession(targetDecoded.id_session, actor, {
    confirmation: 'CERRAR',
    reason: 'QA auth verification'
  });
  const targetSessionAfterClose = await SessionDao.checkActiveSession(targetDecoded.id_login, targetDecoded.id_session);
  const targetProtectedAfterClose = await protectedMiddlewareStatus(targetDecoded);
  const targetRowsAfterClose = await refreshRows(USERS.userB.id);
  const ownClose = await SuperAdminDao.closeSession(adminDecoded.id_session, actor, {
    confirmation: 'CERRAR',
    reason: 'QA own close check'
  });
  results.superAdminIndividualClose = {
    closeResponse: safeResponse(closeOne),
    selectedSessionClosed: !targetSessionAfterClose,
    selectedSessionProtectedStatus: targetProtectedAfterClose.status,
    revokedRowsForSelectedSession: targetRowsAfterClose.filter((row) => row.id_session === targetDecoded.id_session && Number(row.last) === 0).length,
    ownCloseBlockedStatus: ownClose.status,
    ownCloseBlocked: Number(ownClose.status) === 403
  };

  const targetBatchLogin = await login(USERS.userB, true);
  const targetBatchDecoded = decodeAccessToken(targetBatchLogin);
  const closeAll = await SuperAdminDao.closeUserSessions(USERS.userB.id, actor, {
    confirmation: 'CERRAR',
    reason: 'QA auth verification'
  });
  const batchSessionAfterClose = await SessionDao.checkActiveSession(targetBatchDecoded.id_login, targetBatchDecoded.id_session);
  const batchProtectedAfterClose = await protectedMiddlewareStatus(targetBatchDecoded);
  const batchRows = await refreshRows(USERS.userB.id);
  const adminSessionStillActive = await SessionDao.checkActiveSession(adminDecoded.id_login, adminDecoded.id_session);
  results.superAdminCloseAll = {
    closeResponse: safeResponse(closeAll),
    allTargetSessionsInactive: (await sessionRows(USERS.userB.id)).every((row) => Number(row.active) === 0 && Number(row.last) === 0),
    selectedAccessSessionRejected: !batchSessionAfterClose,
    selectedProtectedStatus: batchProtectedAfterClose.status,
    allTargetRefreshTokensInactive: batchRows.every((row) => Number(row.last) === 0),
    adminSessionRemainsActive: Boolean(adminSessionStillActive)
  };

  const legacyLogin = await login(USERS.userA, false);
  const legacyDecoded = decodeAccessToken(legacyLogin);
  const legacyToken = uuidv4();
  await sequelize.query(
    `INSERT INTO refresh_token (
        id_refresh_token, id_login, id_session, token_hash, token_fingerprint, family_id,
        last, created_at, created_by
      ) VALUES (
        :token, :idLogin, NULL, NULL, NULL, NULL, 1, NOW(), :createdBy
      )`,
    {
      replacements: {
        token: legacyToken,
        idLogin: legacyDecoded.id_login,
        createdBy: CREATED_BY
      },
      type: QueryTypes.INSERT
    }
  );
  const legacyRefresh = await refreshToken(legacyToken);
  const legacyRows = await refreshRows(USERS.userA.id);
  const legacyRow = legacyRows.find((row) => row.id_refresh_token === legacyToken);
  const migratedRow = legacyRows.find((row) => Number(row.last) === 1 && row.token_hash);
  results.legacyMigration = {
    response: safeResponse(legacyRefresh),
    legacyInactive: Boolean(legacyRow && Number(legacyRow.last) === 0),
    legacyRevokedReason: legacyRow ? legacyRow.revoked_reason : null,
    newV2Issued: Boolean(legacyRefresh.data && legacyRefresh.data.refresh_token),
    migratedRowHasHash: Boolean(migratedRow && migratedRow.token_hash),
    migratedRowHasSession: Boolean(migratedRow && migratedRow.id_session),
    token_fingerprint: migratedRow ? migratedRow.token_fingerprint : null
  };

  const activeAfterValidate = await sequelize.query(
    `SELECT COUNT(*) AS active_count
       FROM refresh_token
      WHERE id_login IN (:ids)
        AND last = 1`,
    { replacements: { ids: Object.values(USERS).map((user) => user.id) }, type: QueryTypes.SELECT }
  );

  results.summary = {
    activeRefreshRowsAfterValidate: Number(activeAfterValidate[0] ? activeAfterValidate[0].active_count : 0),
    spClosesPreviousSessionsByDesign: true,
    noRawTokensPrinted: true
  };

  return results;
}

async function down() {
  assertWriteAllowed('down');
  const transaction = await sequelize.transaction();
  try {
    await resetAuthState(transaction);
    await sequelize.query(
      `DELETE FROM login WHERE id_login IN (:ids)`,
      {
        replacements: { ids: Object.values(USERS).map((user) => user.id) },
        type: QueryTypes.DELETE,
        transaction
      }
    );
    await sequelize.query(
      `DELETE FROM business WHERE id_business = :businessId`,
      {
        replacements: { businessId: BUSINESS_ID },
        type: QueryTypes.DELETE,
        transaction
      }
    );
    await transaction.commit();
  } catch (error) {
    await transaction.rollback();
    await sequelize.query(
      `UPDATE login
          SET active = 0,
              updated_at = NOW(),
              updated_by = :createdBy
        WHERE id_login IN (:ids)`,
      {
        replacements: {
          ids: Object.values(USERS).map((user) => user.id),
          createdBy: CREATED_BY
        },
        type: QueryTypes.UPDATE
      }
    );
    throw error;
  }

  const remaining = await status();
  return {
    deletedFixtures: true,
    remainingFixtureUsers: remaining.fixtureUsers.length,
    remainingRefreshTokens: Number(remaining.qaRefreshTokenCounts.total || 0),
    remainingActiveRefreshTokens: Number(remaining.qaRefreshTokenCounts.active_count || 0)
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

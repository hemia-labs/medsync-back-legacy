#!/usr/bin/env node
'use strict';

require('../../src/config/env');

const assert = require('assert');

const requireTenantOperational = require('../../src/middleware/requireTenantOperational.middleware');
const UserDao = require('../../src/Dao/mysql/user.dao');
const {
  requireAnyPermission,
  requirePermission,
  requireSelfOrPermission
} = require('../../src/middleware/requirePermission.middleware');

const originalHasPermission = UserDao.hasPermission.bind(UserDao);

const permissionMap = {
  business_admin: ['admin.users', 'admin.config', 'px.new', 'px.all', 'px.dates'],
  doctor: ['px.new', 'px.all', 'px.dates'],
  assistant: ['px.all', 'px.dates'],
  reception: ['px.all', 'px.dates'],
  no_permission: []
};

function invoke(middleware, reqOverrides = {}) {
  return new Promise((resolve, reject) => {
    const req = Object.assign({
      method: 'GET',
      baseUrl: '/api/px',
      path: '/get/qa-patient',
      url: '/get/qa-patient',
      headers: {},
      params: {},
      body: {},
      query: {},
      get() {
        return null;
      },
      tokenDecode: {
        id_login: 'doctor',
        id_business: 'business-a',
        rol: 'doctor'
      }
    }, reqOverrides);

    const res = {
      statusCode: null,
      payload: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      send(payload) {
        this.payload = payload;
        resolve({
          nextCalled: false,
          status: this.statusCode,
          payload
        });
      }
    };

    middleware(req, res, (error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve({
        nextCalled: true,
        status: null,
        payload: null
      });
    });
  });
}

function superAdminReq(baseUrl, path, method) {
  return {
    method: method || 'GET',
    baseUrl,
    path,
    url: path,
    tokenDecode: {
      id_login: 'qa-super-admin',
      id_business: 'business-a',
      rol: 'super_admin'
    }
  };
}

function permissionReq(idLogin, role) {
  return {
    tokenDecode: {
      id_login: idLogin,
      id_business: 'business-a',
      rol: role || idLogin
    }
  };
}

async function main() {
  UserDao.hasPermission = async (idLogin, permission) => {
    const permissions = permissionMap[idLogin] || [];
    return permissions.includes(permission);
  };

  const checks = [];
  const addCheck = (name, ok, evidence) => {
    checks.push({ name, ok: Boolean(ok), evidence });
    assert.strictEqual(Boolean(ok), true, name);
  };

  try {
    const phiRoutes = [
      ['patients', '/api/px', '/get/patient-b', 'GET'],
      ['clinical histories', '/api/clinical-history', '/patient/patient-b', 'GET'],
      ['prescriptions', '/api/prescription', '/patient/patient-b', 'GET'],
      ['documents/signature', '/api/document', '/patient/patient-b', 'GET'],
      ['appointments', '/api/appointment', '/list', 'GET'],
      ['files', '/api/file', '/px/file/patient-b', 'GET'],
      ['clinical config', '/api/config', '/clinical-modules/get', 'GET']
    ];

    for (const route of phiRoutes) {
      const result = await invoke(requireTenantOperational, superAdminReq(route[1], route[2], route[3]));
      addCheck(`super_admin denied on ${route[0]}`, result.status === 403 && result.payload && result.payload.code === 'SUPER_ADMIN_PHI_FORBIDDEN', result);
    }

    const businessAdminUsers = await invoke(requirePermission('admin.users'), permissionReq('business_admin', 'business_admin'));
    addCheck('business_admin can pass admin.users backend permission', businessAdminUsers.nextCalled, businessAdminUsers);

    const doctorPatientWrite = await invoke(requirePermission('px.new'), permissionReq('doctor', 'doctor'));
    addCheck('doctor with px.new can pass patient write permission', doctorPatientWrite.nextCalled, doctorPatientWrite);

    const assistantAppointment = await invoke(requireAnyPermission(['px.dates', 'admin.config']), permissionReq('assistant', 'assistant'));
    addCheck('assistant/reception appointment permission can pass via px.dates', assistantAppointment.nextCalled, assistantAppointment);

    const noPermission = await invoke(requirePermission('admin.config'), permissionReq('no_permission', 'assistant'));
    addCheck('user without permission receives 403', noPermission.status === 403 && noPermission.payload && noPermission.payload.data && noPermission.payload.data.code === 'AUTHZ_FORBIDDEN', noPermission);

    const selfProfile = await invoke(
      requireSelfOrPermission('admin.users', { selfFields: ['id'] }),
      Object.assign(permissionReq('doctor', 'doctor'), { params: { id: 'doctor' } })
    );
    addCheck('self professional profile bypasses admin.users only for own id', selfProfile.nextCalled, selfProfile);

    const crossProfile = await invoke(
      requireSelfOrPermission('admin.users', { selfFields: ['id'] }),
      Object.assign(permissionReq('doctor', 'doctor'), { params: { id: 'other-user' } })
    );
    addCheck('cross-user professional profile requires admin.users and receives 403', crossProfile.status === 403, crossProfile);

    const output = {
      ok: true,
      script: 'authz-fase0-regression',
      checks,
      dbAccess: false,
      externalTargets: false,
      secretsPrinted: false
    };
    console.log(JSON.stringify(output, null, 2));
  } finally {
    UserDao.hasPermission = originalHasPermission;
  }
}

main().catch((error) => {
  UserDao.hasPermission = originalHasPermission;
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});

const assert = require('node:assert/strict');
const dbPath = require.resolve('../../src/db/Sequelize.connection');
let rollbacks = 0;
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {
  query: async () => { throw new Error('Unexpected database read/write'); },
  transaction: async () => ({ rollback: async () => { rollbacks++; } })
} };
const dao = require('../../src/Dao/mysql/clinicalHistoryTemplate.dao');
const body = { id_login: 'actor', id_business: 'clinic', template_id: 'template' };
(async () => {
  dao.hasPermission = async () => false;
  for(const method of ['current', 'createBusinessTemplate', 'createVersion']) {
    const result = await dao[method](body);
    assert.equal(result.status, 403, method + ' must not invalidate the authenticated session');
    assert.equal(result.data.code, 'PERMISSION_DENIED');
  }
  dao.hasPermission = async () => true;
  dao.getEditableTemplate = async () => null;
  assert.equal((await dao.createVersion(body)).status, 403);
  assert.equal(rollbacks, 3);
  let event = false;
  dao.getCurrentTemplateForBusiness = async () => ({ template: { id_clinical_history_template: 'allowed' }, source: 'BUSINESS' });
  dao.addEvent = async () => { event = true; };
  assert.equal((await dao.current(body)).status, 200);
  assert.equal(event, true);
  console.log('PASS: template permission and tenant denials return 403; authorized read preserved. No DB connection.');
})().catch(error => { console.error(error); process.exitCode = 1; });

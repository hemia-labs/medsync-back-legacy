'use strict';
const assert=require('node:assert/strict');
const id=require.resolve('../../src/db/Sequelize.connection');require.cache[id]={id,filename:id,loaded:true,exports:{}};
const dao=require('../../src/Dao/mysql/odontogramV2.dao');
let rows=[];
dao.query=async(sql,values)=>{assert.equal(values.business,'tenant');assert.match(sql,/cp.is_active=1/);assert.match(sql,/COALESCE\(bp.active,pr.active,0\)=1/);return rows;};
const row=(user,role,code)=>({id_login:user,id_rol:role,role_code:role,code});
(async()=>{
 rows=[row('u1','custom-reception','px.tab.odontogram'),row('u1','custom-reception','clinical_history.finalize')];
 let matrix=await dao.activationMatrix('tenant');assert.equal(matrix.ready,false);assert.equal(matrix.roles[0].candidates.finalize,true);assert.equal(matrix.roles[0].finalize,false);
 rows.push(row('u1','custom-reception','odontogram.capture'));rows.push(row('u2','other','px.tab.odontogram'),row('u2','other','odontogram.finalize'));
 matrix=await dao.activationMatrix('tenant',{});assert.equal(matrix.ready,true);assert.equal(matrix.capture_operators,1);assert.equal(matrix.finalize_operators,1);
 rows=rows.filter(row=>!(row.id_login==='u2'&&row.code==='px.tab.odontogram'));matrix=await dao.activationMatrix('tenant');assert.equal(matrix.ready,false);
 console.log('PASS activation preflight: effective/catalog-enabled grants, independent operators and code-based D01 candidates without automatic role changes. Fake SQL only.');
})().catch(error=>{console.error(error);process.exitCode=1;});

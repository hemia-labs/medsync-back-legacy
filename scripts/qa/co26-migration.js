'use strict';
const assert=require('node:assert/strict');
const {migrate,ddl,definitions}=require('../migrations/co26-odontogram');
const {sequence}=require('../../src/domain/odontogram/dentalContract');
const tables=new Map(),catalog=new Map(),ledger=new Map();let mode=false,alters=0,grants=0,failure=true;
const db={async beginTransaction(){},async commit(){},async rollback(){},async query(sql,values=[]){
 if(sql.startsWith('SELECT VERSION'))return [[{version:'8.0-qa',db:'qa_co26'}]];
 if(sql.startsWith('SELECT id_tooth,sec'))return [sequence('mixed').map(sec=>({id_tooth:'existing-'+sec,sec}))];
 if(sql==='SHOW CREATE TABLE clinical_module_config')return [[{'Create Table':'existing clinical configuration'}]];
 if(sql==='SHOW COLUMNS FROM clinical_module_config')return [mode?[{Field:'odontogram_mode',Type:'varchar(16)',Default:'v1'}]:[]];
 if(sql.startsWith('ALTER TABLE clinical_module_config')){mode=true;alters++;return [[]];}
 if(sql.includes('information_schema.TABLES'))return [tables.has(values[0])?[{TABLE_NAME:values[0],ENGINE:'InnoDB',TABLE_COLLATION:'utf8mb4_unicode_ci'}]:[]];
 if(sql.includes('information_schema.KEY_COLUMN_USAGE'))return [definitions(tables.get(values[0])).filter(field=>field.startsWith('FOREIGN KEY')).flatMap((field,index)=>{const match=field.match(/^FOREIGN KEY\(([^)]+)\) REFERENCES (\w+)\(([^)]+)\)/);return match[1].split(',').map((column,position)=>({CONSTRAINT_NAME:'fk_'+index,COLUMN_NAME:column,REFERENCED_TABLE_NAME:match[2],REFERENCED_COLUMN_NAME:match[3].split(',')[position],ORDINAL_POSITION:position+1}));})];
 if(sql.startsWith('SHOW CREATE TABLE '))return [[{'Create Table':'created '+sql.slice(18)}]];
 if(sql.startsWith('CREATE TABLE')){const name=sql.match(/EXISTS (\w+)/)[1];if(name==='odontogram_v2_batch'&&failure){failure=false;throw Error('Simulated DDL interruption');}tables.set(name,ddl.find(([table])=>table===name)[1]);return [[]];}
 if(sql.startsWith('SHOW COLUMNS FROM ')){const fields=definitions(tables.get(sql.slice(18)));return [fields.filter(field=>!/^(PRIMARY|KEY|UNIQUE|FOREIGN)/.test(field)).map(field=>{const match=field.match(/^(\w+)\s+((?:(?:VAR)?CHAR\(\d+\)|DATETIME\(\d+\)|LONGTEXT|SMALLINT|TINYINT|INT)(?:\s+UNSIGNED)?)/);return {Field:match[1],Type:match[2].toLowerCase(),Null:field.includes('NOT NULL')?'NO':'YES'};})];}
 if(sql.startsWith('SHOW INDEX FROM ')){return [definitions(tables.get(sql.slice(16))).filter(field=>/^(PRIMARY|UNIQUE)/.test(field)).flatMap(field=>field.match(/\(([^)]+)\)/)[1].split(',').map((column,index)=>({Key_name:field.startsWith('PRIMARY')?'PRIMARY':field.match(/^UNIQUE KEY (\w+)/)[1],Column_name:column.trim(),Seq_in_index:index+1,Non_unique:0})))];}
 if(sql.startsWith('SELECT * FROM cat_permission'))return [catalog.has(values[0])?[catalog.get(values[0])]:[]];
 if(sql.startsWith('INSERT INTO cat_permission')){catalog.set(values[1],{code:values[1]});grants++;return [[]];}
 if(sql.startsWith('SELECT checksum'))return [ledger.has(values[0])?[{checksum:ledger.get(values[0])}]:[]];
 if(sql.startsWith('INSERT IGNORE INTO odontogram_v2_migration')){ledger.set(values[0],values[1]);return [[]];}
 throw Error('Unexpected migration SQL: '+sql);
}};
(async()=>{
 const files=[];const backup=async(name,data)=>files.push({name,data});
 await assert.rejects(()=>migrate(db,backup),/interruption/);assert.equal(tables.size,2);assert.equal(catalog.size,0);
 await migrate(db,backup);await migrate(db,backup);
 assert.equal(alters,1);assert.equal(grants,4);assert.equal(tables.size,ddl.length);assert.equal(ledger.size,ddl.length);
 assert.ok(files.some(file=>file.name==='permission-delta.json'));assert.ok(files.some(file=>file.name==='manifest.json'));
 ledger.set('odontogram_v2_chart','wrong-checksum');await assert.rejects(()=>migrate(db,backup),/checksum mismatch/);
 console.log('PASS migration planning: interrupted DDL resumes, repeated execution, schema/unique-key checks, catalog-only seed without role grants, backups and checksum mismatch. SQL emulator, not MySQL.');
})().catch(error=>{console.error(error);process.exitCode=1;});

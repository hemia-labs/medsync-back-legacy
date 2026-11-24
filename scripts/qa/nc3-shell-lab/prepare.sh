#!/usr/bin/env bash
# NC3/C22: prepara la base del laboratorio de shell completo (solo local). Uso: bash scripts/qa/nc3-shell-lab/prepare.sh
set -euo pipefail
cd "$(dirname "$0")/../../.."
ORRICO="${ORRICO_DIR:-../../u575589445_orrico}"   # carpeta del esquema exportado (solo DDL; nunca Data)
C=nc3-shell-mysql; DB=medsync_shell
docker rm -f $C >/dev/null 2>&1 || true
docker run -d --name $C -p 127.0.0.1:33950:3306 -e MYSQL_ALLOW_EMPTY_PASSWORD=yes mysql:8.4 >/dev/null
until docker exec $C mysqladmin ping -h127.0.0.1 -uroot --silent >/dev/null 2>&1; do sleep 1; done; sleep 4
docker exec $C mysql -uroot -e "CREATE DATABASE $DB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci; CREATE USER IF NOT EXISTS 'marcos'@'%' IDENTIFIED BY 'lab-only-no-login'; GRANT ALL ON $DB.* TO 'marcos'@'%'"
(echo "SET FOREIGN_KEY_CHECKS=0;"; for f in "$ORRICO"/Tables/*.sql; do cat "$f"; echo ";"; done) | docker exec -i $C mysql -uroot --force $DB
for d in Functions Procedures Views; do for f in "$ORRICO"/$d/*.sql; do docker exec -i $C mysql -uroot --force $DB < "$f" || true; done; done
export NODE_PATH="$PWD/node_modules" DB_HOST=127.0.0.1 DB_PORT=33950 DB_USER=root DB_PASSWORD= DB_NAME=$DB
node -e "
const mysql=require('mysql2/promise'),fs=require('fs');
(async()=>{const c=await mysql.createConnection({host:'127.0.0.1',port:33950,user:'root',database:'$DB',multipleStatements:true});
for(const f of ['nc5-evolution-draft.sql','nc5-evolution-signed.sql','nc5-performed-extra.sql','nc3-evolution-integrity.sql','nc3-evolution-integrity-delivery.sql']) await c.query(fs.readFileSync('scripts/migrations/'+f,'utf8'));
await require('./scripts/migrations/nc5-internal-chat').apply(c);
const n1=require('./scripts/migrations/nc1-identity');await n1.apply(c,{expectedDatabase:'$DB',expectedChecksum:n1.checksum,actor:'lab'});
await c.query('ALTER TABLE login ADD first_name varchar(500) NULL, ADD last_name varchar(500) NULL, ADD first_surname varchar(500) NULL, ADD second_surname varchar(500) NULL');
await c.query('ALTER TABLE person ADD UNIQUE INDEX uq_person_code(code)');
await c.end()})()"
E="--expect-database=$DB"
node scripts/migrations/payments-license-projection.js $E --apply
node scripts/migrations/payments-welcome-outbox.js $E --apply
node scripts/migrations/apply-co8-treatment-plan.js --apply $E
node scripts/migrations/apply-co9-treatment-consent-document.js --apply $E
node scripts/migrations/apply-cd13-allergy-state.js --apply $E
node scripts/migrations/co11-professional-agendas-prescription-config.js --direction up $E --apply
node scripts/migrations/co21-agenda-safe-writes.js --direction up --expect-database $DB --apply
node scripts/migrations/s16-tracing-safety.js >/dev/null 2>&1 || true
node scripts/migrations/s17-dashboard-permissions.js >/dev/null 2>&1 || true
node scripts/qa/nc3-shell-lab/seed-catalogs.js
node scripts/qa/nc3-shell-lab/seed-users.js
echo "Base lista. Siguiente: testigo (scripts/ops/nc3-witness-server.js), backend (node src/index.js) y frontend con el .env del laboratorio."

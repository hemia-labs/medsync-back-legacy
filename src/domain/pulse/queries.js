'use strict';
// Canonical populations shared by aggregates and paged incidents. Never a period filter.
const followUps = `WITH linked AS (
 SELECT a.id_tracing,a.id_person,
 MAX(CASE WHEN a.status IN('confirmed','pending_confirmation','completed') THEN a.appointment_date END) AS coverThrough,
 MAX(CASE WHEN a.status NOT IN('cancelled','no_show','rescheduled') AND
 (a.status NOT IN('confirmed','pending_confirmation','completed') OR a.appointment_date IS NULL OR a.appointment_date<'1000-01-01') THEN 1 ELSE 0 END) AS uncertain
 FROM appointment a WHERE a.id_business=:business AND a.active=1 AND a.id_tracing IS NOT NULL GROUP BY a.id_tracing,a.id_person
), base AS (
 SELECT t.id_tracing AS recordId,t.id_person AS patientId,t.quote_date_after AS dueAt,
 p.id_person AS patientExists,p.active AS patientActive,
 COALESCE(a.coverThrough>=t.quote_date_after,0) AS covered,COALESCE(a.uncertain,0) AS uncertain
 FROM tracing t LEFT JOIN person p ON p.id_person=t.id_person AND p.id_business=t.id_business
 LEFT JOIN linked a ON a.id_tracing=t.id_tracing AND a.id_person=t.id_person
 WHERE t.id_business=:business AND t.status='active'
), population AS (
 SELECT *,CASE WHEN patientExists IS NULL OR patientActive IS NULL OR
  (patientActive=1 AND (dueAt IS NULL OR dueAt<'1000-01-01' OR (dueAt<:today AND covered=0 AND uncertain=1))) THEN 1 ELSE 0 END AS invalid,
 CASE WHEN patientActive=1 AND dueAt<:today AND dueAt>='1000-01-01' THEN 1 ELSE 0 END AS eligible,
 DATEDIFF(:today,dueAt) AS ageDays
 FROM base
), obligations AS (
 SELECT *,CASE WHEN eligible=1 AND invalid=0 AND covered=0 THEN 1 ELSE 0 END AS pending,
 CASE WHEN ageDays>=14 THEN 1 ELSE 0 END AS priority FROM population LIMIT 18446744073709551615
)`;
function appointmentPopulation(grouped = false) { return `WITH base AS (
 SELECT ${grouped ? 'COUNT(*) AS weight,1 AS recordId,1 AS patientId,NULL AS doctorProfileId' : 'a.id_appointment AS recordId,a.id_person AS patientId,a.doctor_profile_id AS doctorProfileId'},a.status,a.appointment_date,a.start_time,a.end_time,
 ${grouped ? 'CASE WHEN COUNT(p.id_person)>0 THEN 1 ELSE NULL END' : 'p.id_person'} AS patientExists,p.active AS patientActive,
 TIMESTAMP(a.appointment_date,a.start_time) AS startLocal,TIMESTAMP(a.appointment_date,a.end_time) AS endLocal
 FROM appointment a LEFT JOIN person p ON p.id_person=a.id_person AND p.id_business=a.id_business
 WHERE a.id_business=:business AND a.active=1
 ${grouped ? 'GROUP BY a.status,a.appointment_date,a.start_time,a.end_time,(p.id_person IS NULL),p.active' : ''}
), converted AS (
 SELECT *,CONVERT_TZ(startLocal,:zone,'+00:00') AS startUtc,CONVERT_TZ(endLocal,:zone,'+00:00') AS endUtc FROM base LIMIT 18446744073709551615
), population AS (
 SELECT *,DATE_ADD(endUtc,INTERVAL 2 HOUR) AS dueAt,
 CASE WHEN patientExists IS NULL OR patientActive IS NULL OR (patientActive=1 AND (
  appointment_date<'1000-01-01' OR start_time<'00:00:00' OR end_time>='24:00:00' OR end_time<=start_time
  OR status NOT IN('confirmed','pending_confirmation','completed','cancelled','rescheduled','no_show')
  OR startUtc IS NULL OR endUtc IS NULL OR endUtc<=startUtc
  OR CONVERT_TZ(startUtc,'+00:00',:zone)<>startLocal OR CONVERT_TZ(endUtc,'+00:00',:zone)<>endLocal
  OR CONVERT_TZ(DATE_ADD(startUtc,INTERVAL 1 HOUR),'+00:00',:zone)=startLocal
  OR CONVERT_TZ(DATE_SUB(startUtc,INTERVAL 1 HOUR),'+00:00',:zone)=startLocal
  OR CONVERT_TZ(DATE_ADD(endUtc,INTERVAL 1 HOUR),'+00:00',:zone)=endLocal
  OR CONVERT_TZ(DATE_SUB(endUtc,INTERVAL 1 HOUR),'+00:00',:zone)=endLocal)) THEN 1 ELSE 0 END AS invalid
 FROM converted LIMIT 18446744073709551615
), obligations AS (
 SELECT *,CASE WHEN patientActive=1 AND invalid=0 AND dueAt<=:asOf THEN 1 ELSE 0 END AS eligible,
 CASE WHEN patientActive=1 AND invalid=0 AND dueAt<=:asOf AND status IN('confirmed','pending_confirmation') THEN 1 ELSE 0 END AS pending,
 CASE WHEN DATE_ADD(dueAt,INTERVAL 7 DAY)<=:asOf THEN 1 ELSE 0 END AS priority,
 FLOOR(TIMESTAMPDIFF(SECOND,dueAt,:asOf)/86400) AS ageDays FROM population
)`; }
const fields = ['patient','tutor','doctor','witness1','witness2'];
const flag = field => `JSON_UNQUOTE(JSON_EXTRACT(requirements,'$.requires_${field}_signature'))`;
const validFlags = fields.map(f => `(JSON_TYPE(JSON_EXTRACT(requirements,'$.requires_${f}_signature'))='INTEGER' AND ${flag(f)} IN('0','1'))`).join(' AND ');
// MAX of a fixed-width tuple preserves DESC(created_at, expires_at, id),
// including NULL-last ordering and fractional seconds. The ID retains its SQL
// collation. Keep chronology over ALL non-failed requests, not only the latest.
// Each timestamp occupies 27 characters; the request ID starts at position 55.
const timestampKey = field => `CONCAT(IF(${field} IS NULL,'0','1'),COALESCE(DATE_FORMAT(${field},'%Y-%m-%d %H:%i:%s.%f'),'0000-00-00 00:00:00.000000'))`;
function signaturePopulation(doctorOnly = false) { return `WITH request_groups AS (
 SELECT id_patient_document,signature_role,MAX(CONCAT(${timestampKey('created_at')},${timestampKey('expires_at')},id_document_signature_request)) AS latestKey,
 MAX(CASE WHEN created_at IS NULL OR created_at<'1000-01-01' OR created_at>:asOf THEN 1 ELSE 0 END) AS chronologyInvalid
 FROM document_signature_requests WHERE id_business=:business AND status<>'failed'${doctorOnly ? " AND signature_role='DOCTOR'" : ''} GROUP BY id_patient_document,signature_role
), requests_ranked AS (
 SELECT r.id_business,r.id_document_signature_request,r.id_patient_document,r.id_person,r.signature_role,r.status,r.created_at,r.expires_at,1 AS ordinal,g.chronologyInvalid
 FROM request_groups g JOIN document_signature_requests r ON r.id_document_signature_request=SUBSTRING(g.latestKey,55)
 AND r.id_business=:business AND r.id_patient_document=g.id_patient_document AND r.signature_role=g.signature_role
), snapshots AS (
 SELECT e.id_patient_document,COUNT(*) AS copies,MAX(e.notes) AS notes
 FROM patient_document_events e WHERE e.id_business=:business AND e.event_type='SIGNATURE_REQUIREMENTS_SNAPSHOT'
 GROUP BY e.id_patient_document
), raw AS (
 SELECT r.id_document_signature_request AS recordId,r.id_person AS patientId,r.id_patient_document,r.signature_role,r.chronologyInvalid,
 r.status,r.created_at,r.expires_at AS dueAt,p.id_person AS patientExists,
 pd.id_patient_document AS documentExists,pd.active AS documentActive,pd.status AS documentStatus,pd.guardian_name_snapshot,
 CASE WHEN pd.origin='TREATMENT_PLAN' AND pd.treatment_plan_id IS NOT NULL THEN
  CASE WHEN link.id_patient_document IS NOT NULL AND JSON_VALID(link.consent_snapshot_json) THEN JSON_EXTRACT(link.consent_snapshot_json,'$.signature_requirements') ELSE JSON_OBJECT() END
 ELSE CASE WHEN s.copies=1 AND JSON_VALID(s.notes) THEN
  CASE WHEN JSON_EXTRACT(s.notes,'$.version')=1 THEN JSON_EXTRACT(s.notes,'$.requirements') ELSE JSON_OBJECT() END ELSE JSON_OBJECT() END END AS requirements,
 CASE WHEN (r.signature_role='DOCTOR' AND NULLIF(pd.doctor_signature_snapshot,'') IS NOT NULL) OR EXISTS(
 SELECT 1 FROM patient_document_signatures ps WHERE ps.id_business=r.id_business AND ps.id_patient_document=r.id_patient_document
 AND ps.signature_role=r.signature_role AND (NULLIF(ps.signature_image,'') IS NOT NULL OR ps.signed_at>='1000-01-01')) THEN 1 ELSE 0 END AS signed
 FROM requests_ranked r
 LEFT JOIN patient_documents pd ON pd.id_patient_document=r.id_patient_document AND pd.id_business=r.id_business AND pd.id_person=r.id_person
 LEFT JOIN person p ON p.id_person=r.id_person AND p.id_business=r.id_business
 LEFT JOIN snapshots s ON s.id_patient_document=pd.id_patient_document
 LEFT JOIN treatment_plan_consent_document link ON link.id_patient_document=pd.id_patient_document AND link.id_business=pd.id_business
  AND link.id_person=pd.id_person AND link.id_treatment_plan=pd.treatment_plan_id
 WHERE r.ordinal=1
), requirements_checked AS (
 SELECT recordId,patientId,id_patient_document,signature_role,chronologyInvalid,status,created_at,dueAt,patientExists,documentExists,documentActive,documentStatus,signed,CASE WHEN COALESCE(${validFlags},0)=1 THEN 1 ELSE 0 END AS flagsValid,
 CASE signature_role WHEN 'TUTOR' THEN (NULLIF(guardian_name_snapshot,'') IS NOT NULL OR ${flag('tutor')}='1')
 WHEN 'PATIENT' THEN (NULLIF(guardian_name_snapshot,'') IS NULL AND ${flag('tutor')}='0' AND ${flag('patient')}='1')
 WHEN 'DOCTOR' THEN ${flag('doctor')}='1' WHEN 'WITNESS1' THEN ${flag('witness1')}='1' WHEN 'WITNESS2' THEN ${flag('witness2')}='1' ELSE 0 END AS requiredRole
 FROM raw LIMIT 18446744073709551615
), population AS (
 SELECT *,CASE WHEN documentExists IS NULL OR patientExists IS NULL OR
 (documentActive=1 AND documentStatus IN('BORRADOR','PENDIENTE_FIRMA') AND
 (flagsValid=0 OR chronologyInvalid=1 OR dueAt IS NULL OR dueAt<'1000-01-01' OR dueAt<created_at OR (status='expired' AND dueAt>:asOf))) THEN 1 ELSE 0 END AS invalid,
 CASE WHEN documentActive=1 AND patientExists IS NOT NULL AND documentStatus IN('BORRADOR','PENDIENTE_FIRMA') AND flagsValid=1 AND requiredRole=1 AND signed=0
 AND chronologyInvalid=0 AND dueAt>='1000-01-01' AND dueAt>=created_at AND status IN('pending','opened','expired') THEN 1 ELSE 0 END AS eligible
 FROM requirements_checked LIMIT 18446744073709551615
), obligations AS (
 SELECT *,CASE WHEN eligible=1 AND (dueAt<=:asOf OR status='expired') THEN 1 ELSE 0 END AS pending,
 CASE WHEN DATE_ADD(dueAt,INTERVAL 7 DAY)<=:asOf THEN 1 ELSE 0 END AS priority,
 GREATEST(0,FLOOR(TIMESTAMPDIFF(SECOND,dueAt,:asOf)/86400)) AS ageDays FROM population
)`; }
const signatures = signaturePopulation();
const populations = { 'PUL-OP01': followUps, 'PUL-OP02': signatures, 'PUL-OP03': appointmentPopulation() };
function aggregate(id) {
    const temporal = id === 'PUL-OP01' ? ':midnight' : `LEAST(COALESCE(MIN(CASE WHEN eligible=1 AND dueAt>:asOf THEN dueAt END),'9999-12-31'),
      COALESCE(MIN(CASE WHEN pending=1 AND DATE_ADD(dueAt,INTERVAL 7 DAY)>:asOf THEN DATE_ADD(dueAt,INTERVAL 7 DAY) END),'9999-12-31')
      ${id === 'PUL-OP03' ? ",COALESCE(MIN(CASE WHEN invalid=0 AND patientActive=1 AND status IN('confirmed','pending_confirmation') AND dueAt>:asOf THEN dueAt END),'9999-12-31'),COALESCE(MIN(CASE WHEN invalid=0 AND patientActive=1 AND status='pending_confirmation' AND startUtc>:asOf THEN startUtc END),'9999-12-31'),COALESCE(MIN(CASE WHEN invalid=0 AND patientActive=1 AND status='pending_confirmation' AND DATE_SUB(startUtc,INTERVAL 24 HOUR)>:asOf THEN DATE_SUB(startUtc,INTERVAL 24 HOUR) END),'9999-12-31')" : ''})`;
    const w = id === 'PUL-OP03' ? '*weight' : '';
    return `${id === 'PUL-OP03' ? appointmentPopulation(true) : populations[id]} SELECT COALESCE(SUM(eligible${w}),0) AS denominator,COALESCE(SUM(pending${w}),0) AS numerator,
    COALESCE(SUM(pending*priority${w}),0) AS priorityCount,MAX(CASE WHEN pending=1 THEN ageDays END) AS oldestAgeDays,
    COALESCE(SUM(invalid${w}),0) AS invalidRecords,${id === 'PUL-OP02' ? '0' : `COALESCE(SUM((patientActive=0 AND dueAt${id === 'PUL-OP01' ? '<:today' : '<=:asOf'})${w}),0)`} AS excludedArchived,${temporal} AS nextTransitionAt
    ${id === 'PUL-OP03' ? ",COALESCE(SUM((invalid=0 AND patientActive=1 AND status='pending_confirmation' AND startUtc>:asOf AND startUtc<=DATE_ADD(:asOf,INTERVAL 24 HOUR))*weight),0) AS upcoming,COALESCE(SUM((invalid=0 AND patientActive=1 AND status IN('confirmed','pending_confirmation') AND startUtc<=:asOf AND dueAt>:asOf)*weight),0) AS inProgress" : ''}
    FROM obligations`;
}
function page(id, hasCursor) {
    return `${populations[id]} SELECT recordId,patientId,NULLIF(TRIM(CONCAT_WS(' ',displayPatient.name,displayPatient.surname)),'') AS patientLabel,priority,DATE_FORMAT(dueAt,'%Y-%m-%d %H:%i:%s.000') AS dueAt,ageDays,${id === 'PUL-OP02' ? 'id_patient_document' : 'NULL'} AS documentId,${id === 'PUL-OP03' ? "DATE_FORMAT(appointment_date,'%Y-%m-%d')" : 'NULL'} AS appointmentDate,${id === 'PUL-OP03' ? 'doctorProfileId' : 'NULL'} AS doctorProfileId FROM obligations LEFT JOIN person displayPatient ON displayPatient.id_person=patientId AND displayPatient.id_business=:business WHERE pending=1
    ${hasCursor ? 'AND (priority<:priority OR (priority=:priority AND (dueAt>:due OR (dueAt=:due AND recordId>:lastId))))' : ''}
    ORDER BY priority DESC,dueAt,recordId LIMIT :limit`;
}
module.exports = { populations, aggregate, page, signaturePopulation };

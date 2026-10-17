CREATE PROCEDURE `SP_appointment_get`(IN _id_appointment varchar(50), IN _id_business varchar(50))
BEGIN
  SELECT a.id_appointment AS id, a.doctor_profile_id AS doctorProfileId, a.doctor_name_snapshot AS doctorName, a.id_person AS patientId,
         COALESCE(NULLIF(a.patient_name, ''), TRIM(CONCAT(IFNULL(p.name, ''), ' ', IFNULL(p.surname, '')))) AS patientName,
         COALESCE(NULLIF(a.contact_phone, ''), NULLIF(p.telephone, ''), NULLIF(p.local_telephone, '')) AS contactPhone,
         a.id_tracing AS followUpId, DATE_FORMAT(a.appointment_date, '%Y-%m-%d') AS date,
         DATE_FORMAT(a.start_time, '%H:%i') AS startTime, DATE_FORMAT(a.end_time, '%H:%i') AS endTime,
         a.status, a.title, a.description, a.source, a.cancellation_reason AS cancellationReason,
         a.rescheduled_from_appointment_id AS rescheduledFromAppointmentId,
         a.rescheduled_to_appointment_id AS rescheduledToAppointmentId,
         a.blocks_availability AS blocksAvailability, a.created_at AS createdAt, a.updated_at AS updatedAt
    FROM appointment a
    LEFT JOIN person p ON p.id_person = a.id_person AND p.id_business = a.id_business
   WHERE a.id_appointment = _id_appointment
     AND a.id_business = _id_business
   LIMIT 1;
END

CREATE PROCEDURE `SP_appointment_list`(IN _date_from date, IN _date_to date, IN _id_person varchar(50), IN _id_business varchar(50), IN _doctor_profile_id varchar(50))
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
   WHERE a.active = 1
     AND a.id_business = _id_business
     AND (_doctor_profile_id IS NULL OR a.doctor_profile_id = _doctor_profile_id)
     AND (_date_from IS NULL OR a.appointment_date >= _date_from)
     AND (_date_to IS NULL OR a.appointment_date <= _date_to)
     AND (_id_person IS NULL OR _id_person = '' OR a.id_person = _id_person)
   ORDER BY a.appointment_date, a.start_time;
END

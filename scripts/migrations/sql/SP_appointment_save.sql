CREATE PROCEDURE `SP_appointment_save`(IN _appointment text, IN _id_login varchar(50), IN _id_business varchar(50))
BEGIN
  SET @id_appointment = NULLIF(JSON_UNQUOTE(JSON_EXTRACT(_appointment, '$.id')), '');
  SET @doctor_profile_id = NULLIF(JSON_UNQUOTE(JSON_EXTRACT(_appointment, '$.doctorProfileId')), '');
  SET @doctor_name = JSON_UNQUOTE(JSON_EXTRACT(_appointment, '$.doctorName'));
  IF @doctor_profile_id IS NULL OR NOT EXISTS (SELECT 1 FROM doctor_professional_profile d JOIN login l ON l.id_login = d.id_login AND l.id_business = d.id_business WHERE d.id_doctor_professional_profile = @doctor_profile_id AND d.id_business = _id_business AND d.is_active = 1 AND l.active = 1) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Doctor no disponible.'; END IF;
  SET @id_person = NULLIF(JSON_UNQUOTE(JSON_EXTRACT(_appointment, '$.patientId')), '');
  IF @id_person IN ('null', 'undefined') THEN SET @id_person = NULL; END IF;
  IF @id_person IS NOT NULL AND NOT EXISTS (SELECT 1 FROM person WHERE id_person = @id_person AND id_business = _id_business LIMIT 1) THEN SET @id_person = NULL; END IF;
  SET @patient_name = NULLIF(JSON_UNQUOTE(JSON_EXTRACT(_appointment, '$.patientName')), '');
  SET @contact_phone = NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(_appointment, '$.contactPhone'))), '');
  IF @contact_phone IN ('null', 'undefined') THEN SET @contact_phone = NULL; END IF;
  IF @contact_phone IS NOT NULL THEN SET @contact_phone = LEFT(@contact_phone, 40); END IF;
  SET @id_tracing = NULLIF(JSON_UNQUOTE(JSON_EXTRACT(_appointment, '$.followUpId')), '');
  IF @id_tracing IN ('null', 'undefined') THEN SET @id_tracing = NULL; END IF;
  IF @id_tracing IS NOT NULL AND NOT EXISTS (SELECT 1 FROM tracing WHERE id_tracing = @id_tracing AND id_business = _id_business LIMIT 1) THEN SET @id_tracing = NULL; END IF;
  SET @appointment_date = JSON_UNQUOTE(JSON_EXTRACT(_appointment, '$.date'));
  SET @start_time = JSON_UNQUOTE(JSON_EXTRACT(_appointment, '$.startTime'));
  SET @end_time = JSON_UNQUOTE(JSON_EXTRACT(_appointment, '$.endTime'));
  SET @status = IFNULL(JSON_UNQUOTE(JSON_EXTRACT(_appointment, '$.status')), 'pending_confirmation');
  SET @title = JSON_UNQUOTE(JSON_EXTRACT(_appointment, '$.title'));
  SET @description = JSON_UNQUOTE(JSON_EXTRACT(_appointment, '$.description'));
  SET @source = IFNULL(JSON_UNQUOTE(JSON_EXTRACT(_appointment, '$.source')), 'manual');
  SET @cancellation_reason = JSON_UNQUOTE(JSON_EXTRACT(_appointment, '$.cancellationReason'));
  SET @rescheduled_from = NULLIF(JSON_UNQUOTE(JSON_EXTRACT(_appointment, '$.rescheduledFromAppointmentId')), '');
  SET @rescheduled_to = NULLIF(JSON_UNQUOTE(JSON_EXTRACT(_appointment, '$.rescheduledToAppointmentId')), '');
  SET @blocks = CASE WHEN @status IN ('pending_confirmation', 'confirmed', 'completed') THEN 1 ELSE 0 END;

  IF @blocks = 1 AND EXISTS (
    SELECT 1 FROM appointment a
     WHERE a.active = 1
       AND a.id_business = _id_business
       AND a.doctor_profile_id = @doctor_profile_id
       AND a.appointment_date = @appointment_date
       AND (@id_appointment IS NULL OR a.id_appointment <> @id_appointment)
       AND (a.status IN ('pending_confirmation', 'confirmed', 'completed') OR a.blocks_availability = 1)
       AND TIME(@start_time) < a.end_time
       AND TIME(@end_time) > a.start_time
     LIMIT 1
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Este horario ya esta ocupado.';
  END IF;

  IF @id_appointment IS NULL THEN
    SET @id_appointment = UUID();
    INSERT INTO appointment (id_appointment, id_business, doctor_profile_id, doctor_name_snapshot, id_person, patient_name, contact_phone, id_tracing, appointment_date, start_time, end_time, status, title, description, source, cancellation_reason, rescheduled_from_appointment_id, rescheduled_to_appointment_id, blocks_availability, active, created_at, created_by)
    VALUES (@id_appointment, _id_business, @doctor_profile_id, @doctor_name, @id_person, @patient_name, @contact_phone, @id_tracing, @appointment_date, @start_time, @end_time, @status, @title, @description, @source, @cancellation_reason, @rescheduled_from, @rescheduled_to, @blocks, 1, NOW(), _id_login);
  ELSE
    UPDATE appointment
       SET doctor_profile_id = @doctor_profile_id, doctor_name_snapshot = @doctor_name, id_person = @id_person, patient_name = @patient_name, contact_phone = @contact_phone, id_tracing = @id_tracing,
           appointment_date = @appointment_date, start_time = @start_time, end_time = @end_time,
           status = @status, title = @title, description = @description, source = @source,
           cancellation_reason = @cancellation_reason, rescheduled_from_appointment_id = @rescheduled_from,
           rescheduled_to_appointment_id = @rescheduled_to, blocks_availability = @blocks,
           updated_at = NOW(), updated_by = _id_login
     WHERE id_appointment = @id_appointment AND id_business = _id_business;
  END IF;

  CALL SP_appointment_get(@id_appointment, _id_business);
END

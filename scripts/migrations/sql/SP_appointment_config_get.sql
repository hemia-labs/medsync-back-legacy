CREATE PROCEDURE `SP_appointment_config_get`(IN _id_business varchar(50), IN _doctor_profile_id varchar(50))
BEGIN
  SET @id_config = UUID();

  INSERT INTO appointment_config (id_appointment_config, id_business, doctor_profile_id, enabled, default_appointment_duration, timezone, active, created_at)
  SELECT @id_config, _id_business, _doctor_profile_id, IF(_doctor_profile_id IS NULL, 1, 0), 30, 'America/Mexico_City', 1, NOW()
  WHERE NOT EXISTS (SELECT 1 FROM appointment_config WHERE id_business = _id_business AND doctor_profile_id <=> _doctor_profile_id AND active = 1);

  SELECT id_appointment_config INTO @id_config
    FROM appointment_config
   WHERE id_business = _id_business AND doctor_profile_id <=> _doctor_profile_id AND active = 1
   ORDER BY created_at DESC
   LIMIT 1;

  IF NOT EXISTS (SELECT 1 FROM appointment_working_day WHERE id_appointment_config = @id_config) THEN
    INSERT INTO appointment_working_day (id_appointment_working_day, id_business, id_appointment_config, day_of_week, enabled, created_at)
    VALUES
      (CONCAT(@id_config, '-wd-1'), _id_business, @id_config, 1, 1, NOW()),
      (CONCAT(@id_config, '-wd-2'), _id_business, @id_config, 2, 1, NOW()),
      (CONCAT(@id_config, '-wd-3'), _id_business, @id_config, 3, 1, NOW()),
      (CONCAT(@id_config, '-wd-4'), _id_business, @id_config, 4, 1, NOW()),
      (CONCAT(@id_config, '-wd-5'), _id_business, @id_config, 5, 1, NOW()),
      (CONCAT(@id_config, '-wd-6'), _id_business, @id_config, 6, 0, NOW()),
      (CONCAT(@id_config, '-wd-0'), _id_business, @id_config, 0, 0, NOW());

    INSERT INTO appointment_time_range (id_appointment_time_range, id_business, id_appointment_working_day, start_time, end_time, created_at)
    SELECT UUID(), _id_business, wd.id_appointment_working_day, '08:00', '12:00', NOW()
      FROM appointment_working_day wd WHERE wd.id_appointment_config = @id_config AND wd.day_of_week IN (1,2,3,4,5);
    INSERT INTO appointment_time_range (id_appointment_time_range, id_business, id_appointment_working_day, start_time, end_time, created_at)
    SELECT UUID(), _id_business, wd.id_appointment_working_day, '14:00', '20:00', NOW()
      FROM appointment_working_day wd WHERE wd.id_appointment_config = @id_config AND wd.day_of_week IN (1,2,3,4,5);
  END IF;

  SELECT JSON_OBJECT(
    'id', c.id_appointment_config,
    'doctorProfileId', IFNULL(c.doctor_profile_id, 'business'),
    'enabled', c.enabled,
    'defaultAppointmentDuration', c.default_appointment_duration,
    'timezone', c.timezone,
    'workingDays', IFNULL((
      SELECT JSON_ARRAYAGG(JSON_OBJECT(
        'id', wd.id_appointment_working_day,
        'dayOfWeek', wd.day_of_week,
        'enabled', wd.enabled,
        'timeRanges', IFNULL((
          SELECT JSON_ARRAYAGG(JSON_OBJECT('id', tr.id_appointment_time_range, 'startTime', DATE_FORMAT(tr.start_time, '%H:%i'), 'endTime', DATE_FORMAT(tr.end_time, '%H:%i')))
            FROM appointment_time_range tr
           WHERE tr.id_appointment_working_day = wd.id_appointment_working_day
             AND tr.id_business = _id_business
        ), JSON_ARRAY())
      ))
      FROM appointment_working_day wd
      WHERE wd.id_appointment_config = c.id_appointment_config
        AND wd.id_business = _id_business
    ), JSON_ARRAY()),
    'blockedDates', IFNULL((
      SELECT JSON_ARRAYAGG(JSON_OBJECT('id', bd.id_appointment_blocked_date, 'date', IFNULL(DATE_FORMAT(bd.blocked_date, '%Y-%m-%d'), ''), 'dayOfWeek', bd.day_of_week, 'reason', bd.reason, 'repeats', bd.repeats, 'repeatType', bd.repeat_type))
        FROM appointment_blocked_date bd
       WHERE bd.id_appointment_config = c.id_appointment_config
         AND bd.id_business = _id_business
    ), JSON_ARRAY()),
    'blockedHours', IFNULL((
      SELECT JSON_ARRAYAGG(JSON_OBJECT('id', bh.id_appointment_blocked_hour, 'date', IFNULL(DATE_FORMAT(bh.blocked_date, '%Y-%m-%d'), ''), 'dayOfWeek', bh.day_of_week, 'startTime', DATE_FORMAT(bh.start_time, '%H:%i'), 'endTime', DATE_FORMAT(bh.end_time, '%H:%i'), 'reason', bh.reason, 'repeats', bh.repeats, 'repeatType', bh.repeat_type))
        FROM appointment_blocked_hour bh
       WHERE bh.id_appointment_config = c.id_appointment_config
         AND bh.id_business = _id_business
    ), JSON_ARRAY())
  ) AS config
  FROM appointment_config c
  WHERE c.id_appointment_config = @id_config
    AND c.id_business = _id_business
  LIMIT 1;
END

CREATE PROCEDURE `SP_appointment_config_save`(IN _config text, IN _id_login varchar(50), IN _id_business varchar(50), IN _doctor_profile_id varchar(50))
BEGIN
  DECLARE _index int DEFAULT 0;
  DECLARE _range_index int DEFAULT 0;
  DECLARE _total int DEFAULT 0;
  DECLARE _range_total int DEFAULT 0;
  DECLARE _day_json longtext;
  DECLARE _range_json longtext;
  DECLARE _day_id varchar(50);

  SET @id_config = UUID();
  SELECT id_appointment_config INTO @id_config FROM appointment_config WHERE id_business = _id_business AND doctor_profile_id <=> _doctor_profile_id AND active = 1 LIMIT 1;
    INSERT INTO appointment_config (id_appointment_config, id_business, doctor_profile_id, enabled, default_appointment_duration, timezone, active, created_at, created_by, updated_at, updated_by)
    VALUES (@id_config, _id_business, _doctor_profile_id,
      CASE WHEN LOWER(IFNULL(JSON_UNQUOTE(JSON_EXTRACT(_config, '$.enabled')), 'true')) IN ('true', '1') THEN 1 ELSE 0 END,
      IFNULL(JSON_UNQUOTE(JSON_EXTRACT(_config, '$.defaultAppointmentDuration')), 30),
      IFNULL(JSON_UNQUOTE(JSON_EXTRACT(_config, '$.timezone')), 'America/Mexico_City'),
      1, NOW(), _id_login, NOW(), _id_login)
    ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), default_appointment_duration = VALUES(default_appointment_duration), timezone = VALUES(timezone), id_business = _id_business, updated_at = NOW(), updated_by = _id_login;

    DELETE FROM appointment_time_range WHERE id_business = _id_business AND id_appointment_working_day IN (SELECT id_appointment_working_day FROM appointment_working_day WHERE id_appointment_config = @id_config);
    DELETE FROM appointment_working_day WHERE id_business = _id_business AND id_appointment_config = @id_config;
    DELETE FROM appointment_blocked_date WHERE id_business = _id_business AND id_appointment_config = @id_config;
    DELETE FROM appointment_blocked_hour WHERE id_business = _id_business AND id_appointment_config = @id_config;

    SET _total = IFNULL(JSON_LENGTH(JSON_EXTRACT(_config, '$.workingDays')), 0);
    SET _index = 0;
    working_days_loop: LOOP
      IF _index >= _total THEN LEAVE working_days_loop; END IF;
      SET _day_json = JSON_EXTRACT(_config, CONCAT('$.workingDays[', _index, ']'));
      SET _day_id = UUID();
      INSERT INTO appointment_working_day (id_appointment_working_day, id_business, id_appointment_config, day_of_week, enabled, created_at, created_by, updated_at, updated_by)
      VALUES (_day_id, _id_business, @id_config, JSON_UNQUOTE(JSON_EXTRACT(_day_json, '$.dayOfWeek')), CASE WHEN LOWER(IFNULL(JSON_UNQUOTE(JSON_EXTRACT(_day_json, '$.enabled')), 'false')) IN ('true', '1') THEN 1 ELSE 0 END, NOW(), _id_login, NOW(), _id_login);

      SET _range_total = IFNULL(JSON_LENGTH(JSON_EXTRACT(_day_json, '$.timeRanges')), 0);
      SET _range_index = 0;
      time_ranges_loop: LOOP
        IF _range_index >= _range_total THEN LEAVE time_ranges_loop; END IF;
        SET _range_json = JSON_EXTRACT(_day_json, CONCAT('$.timeRanges[', _range_index, ']'));
        INSERT INTO appointment_time_range (id_appointment_time_range, id_business, id_appointment_working_day, start_time, end_time, created_at, created_by)
        VALUES (UUID(), _id_business, _day_id, JSON_UNQUOTE(JSON_EXTRACT(_range_json, '$.startTime')), JSON_UNQUOTE(JSON_EXTRACT(_range_json, '$.endTime')), NOW(), _id_login);
        SET _range_index = _range_index + 1;
      END LOOP;
      SET _index = _index + 1;
    END LOOP;

    SET _total = IFNULL(JSON_LENGTH(JSON_EXTRACT(_config, '$.blockedDates')), 0);
    SET _index = 0;
    blocked_dates_loop: LOOP
      IF _index >= _total THEN LEAVE blocked_dates_loop; END IF;
      SET @block_json = JSON_EXTRACT(_config, CONCAT('$.blockedDates[', _index, ']'));
      INSERT INTO appointment_blocked_date (id_appointment_blocked_date, id_business, id_appointment_config, blocked_date, day_of_week, reason, repeats, repeat_type, created_at, created_by, updated_at, updated_by)
      VALUES (UUID(), _id_business, @id_config, NULLIF(JSON_UNQUOTE(JSON_EXTRACT(@block_json, '$.date')), ''), NULLIF(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(@block_json, '$.dayOfWeek')), ''), 'null'), JSON_UNQUOTE(JSON_EXTRACT(@block_json, '$.reason')), CASE WHEN LOWER(IFNULL(JSON_UNQUOTE(JSON_EXTRACT(@block_json, '$.repeats')), 'false')) IN ('true', '1') THEN 1 ELSE 0 END, IFNULL(JSON_UNQUOTE(JSON_EXTRACT(@block_json, '$.repeatType')), 'none'), NOW(), _id_login, NOW(), _id_login);
      SET _index = _index + 1;
    END LOOP;

    SET _total = IFNULL(JSON_LENGTH(JSON_EXTRACT(_config, '$.blockedHours')), 0);
    SET _index = 0;
    blocked_hours_loop: LOOP
      IF _index >= _total THEN LEAVE blocked_hours_loop; END IF;
      SET @hour_json = JSON_EXTRACT(_config, CONCAT('$.blockedHours[', _index, ']'));
      INSERT INTO appointment_blocked_hour (id_appointment_blocked_hour, id_business, id_appointment_config, blocked_date, day_of_week, start_time, end_time, reason, repeats, repeat_type, created_at, created_by, updated_at, updated_by)
      VALUES (UUID(), _id_business, @id_config, NULLIF(JSON_UNQUOTE(JSON_EXTRACT(@hour_json, '$.date')), ''), NULLIF(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(@hour_json, '$.dayOfWeek')), ''), 'null'), JSON_UNQUOTE(JSON_EXTRACT(@hour_json, '$.startTime')), JSON_UNQUOTE(JSON_EXTRACT(@hour_json, '$.endTime')), JSON_UNQUOTE(JSON_EXTRACT(@hour_json, '$.reason')), CASE WHEN LOWER(IFNULL(JSON_UNQUOTE(JSON_EXTRACT(@hour_json, '$.repeats')), 'false')) IN ('true', '1') THEN 1 ELSE 0 END, IFNULL(JSON_UNQUOTE(JSON_EXTRACT(@hour_json, '$.repeatType')), 'none'), NOW(), _id_login, NOW(), _id_login);
      SET _index = _index + 1;
    END LOOP;

  CALL SP_appointment_config_get(_id_business, _doctor_profile_id);
END

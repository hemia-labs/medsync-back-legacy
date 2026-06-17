'use strict';

const crypto = require('crypto');
const { QueryTypes } = require('sequelize');
const {
  CREATED_BY,
  PASSWORD,
  QA_BUSINESSES,
  ROLE_CODES,
  addDays,
  assertExplicitFlag,
  assertWritableDbAllowed,
  closeConnection,
  dateTime,
  encript,
  firstAvailableRole,
  isoDate,
  monthDay,
  monthRange,
  parseReferenceDate,
  resetQaDemoData,
  roleByCode,
  safeDbTarget,
  safeJson,
  sequelize,
  stableId
} = require('./qa-demo-db-utils');

const PROF_PREFIX = 'QAP';
const CLIN_PREFIX = 'QAC';
const BASE_PATIENT_COUNT = 20;

const NAMES = [
  ['Luis', 'Robles Juarez'],
  ['Mariana', 'Torres Medina'],
  ['Carlos', 'Hernandez Soto'],
  ['Paola', 'Garcia Rivas'],
  ['Jorge', 'Lopez Herrera'],
  ['Andrea', 'Castillo Pena'],
  ['Sofia', 'Mendoza Cruz'],
  ['Diego', 'Ramirez Luna'],
  ['Valeria', 'Santos Aguilar'],
  ['Ricardo', 'Flores Navarro'],
  ['Fernanda', 'Vega Salas'],
  ['Miguel', 'Morales Diaz'],
  ['Daniela', 'Ortega Leon'],
  ['Hector', 'Paredes Silva'],
  ['Natalia', 'Suarez Campos'],
  ['Emilio', 'Cortes Bravo'],
  ['Renata', 'Reyes Molina'],
  ['Arturo', 'Nunez Rocha'],
  ['Camila', 'Fuentes Solis'],
  ['Ivan', 'Barrera Cano']
];

const TREATMENTS = [
  ['Limpieza dental', 'Preventivo', 900],
  ['Resina dental', 'Restauracion', 1450],
  ['Blanqueamiento', 'Estetica', 3800],
  ['Extraccion simple', 'Cirugia', 1800],
  ['Endodoncia', 'Endodoncia', 6200],
  ['Corona zirconia', 'Rehabilitacion', 8900],
  ['Guardia oclusal', 'Rehabilitacion', 2400],
  ['Ortodoncia inicial', 'Ortodoncia', 15000]
];

function hashToken(seed) {
  return crypto.createHash('sha256').update(seed).digest('hex');
}

function sqlTime(value) {
  return `${value}:00`;
}

function addMinutes(time, minutes) {
  const [hh, mm] = time.split(':').map(Number);
  const total = hh * 60 + mm + minutes;
  const nextH = String(Math.floor(total / 60)).padStart(2, '0');
  const nextM = String(total % 60).padStart(2, '0');
  return `${nextH}:${nextM}`;
}

function birthdayForAge(referenceDate, age, index) {
  const date = new Date(referenceDate.getFullYear() - age, (index * 3) % 12, ((index * 5) % 24) + 1, 12, 0, 0, 0);
  return isoDate(date);
}

function createdAtForPatient(referenceDate, index, clinical) {
  if (clinical) {
    if (index <= 16) return dateTime(monthDay(referenceDate, Math.max(2, index + 1), 0), '10:00:00');
    if (index <= 19) return dateTime(monthDay(referenceDate, 6 + index, -1), '10:00:00');
    return dateTime(addDays(referenceDate, -75), '10:00:00');
  }

  if (index <= 14) return dateTime(monthDay(referenceDate, Math.max(2, index + 2), 0), '10:00:00');
  if (index <= 18) return dateTime(monthDay(referenceDate, 4 + index, -1), '10:00:00');
  return dateTime(addDays(referenceDate, -65), '10:00:00');
}

function buildPatients(prefix, business, referenceDate, clinical = false) {
  return NAMES.map(([name, surname], index) => {
    const number = index + 1;
    return {
      id: `${prefix}_PATIENT_${String(number).padStart(2, '0')}`,
      code: `${prefix}${String(number).padStart(3, '0')}`,
      businessId: business.id,
      name,
      surname,
      birthday: birthdayForAge(referenceDate, 18 + ((index * 7) % 50), index),
      age: 18 + ((index * 7) % 50),
      phone: clinical ? `5520002${String(number).padStart(3, '0')}` : `5520001${String(number).padStart(3, '0')}`,
      email: `qa+paciente-${business.key}-${String(number).padStart(2, '0')}@medsync.local`,
      sex: index % 2 === 0 ? 'F' : 'M',
      createdAt: createdAtForPatient(referenceDate, number, clinical)
    };
  });
}

function userDefinitions(business, roles, clinical = false) {
  const users = [
    {
      ...business.mainUser,
      roleId: roles.admin.id_rol,
      roleCode: roles.admin.code,
      active: 1
    }
  ];

  const doctors = clinical
    ? [
        ['QA_Clinical_Doctor_1', '5510000211'],
        ['QA_Clinical_Doctor_2', '5510000212'],
        ['QA_Clinical_Doctor_3', '5510000213']
      ]
    : [
        ['QA_Profesional_Doctor_1', '5510000111']
      ];

  doctors.forEach(([name, phone], index) => {
    users.push({
      id: `${clinical ? CLIN_PREFIX : PROF_PREFIX}_DOCTOR_${index + 1}`,
      name,
      email: `${name.toLowerCase()}@medsync.local`,
      phone,
      roleId: roles.doctor.id_rol,
      roleCode: roles.doctor.code,
      active: 1,
      professional: true
    });
  });

  const assistants = clinical
    ? [
        ['QA_Clinical_Assistant_1', '5510000221', 1],
        ['QA_Clinical_Assistant_2', '5510000222', 1],
        ['QA_Clinical_Reception_1', '5510000223', 1],
        ['QA_Clinical_Assistant_Inactive', '5510000229', 0]
      ]
    : [
        ['QA_Profesional_Assistant_1', '5510000121', 1],
        ['QA_Profesional_Assistant_Inactive', '5510000129', 0]
      ];

  assistants.forEach(([name, phone, active], index) => {
    users.push({
      id: `${clinical ? CLIN_PREFIX : PROF_PREFIX}_ASSISTANT_${index + 1}`,
      name,
      email: `${name.toLowerCase()}@medsync.local`,
      phone,
      roleId: roles.assistant.id_rol,
      roleCode: roles.assistant.code,
      active
    });
  });

  return users;
}

async function upsertBusiness(business, referenceDate, transaction) {
  const range = monthRange(referenceDate, 0);
  await sequelize.query(
    `INSERT INTO business (
        id_business, name, legal_name, slug, email, phone, address, logo_url,
        status, plan, active, subscription_status, trial_starts_at, trial_ends_at,
        current_period_starts_at, current_period_ends_at, created_at, created_by, updated_at, updated_by
      ) VALUES (
        :id, :name, :legalName, :slug, :email, :phone, :address, NULL,
        'active', :plan, 1, 'active', NULL, NULL,
        :periodStart, :periodEnd, :createdAt, :createdBy, :createdAt, :createdBy
      )
      ON DUPLICATE KEY UPDATE
        name = VALUES(name),
        legal_name = VALUES(legal_name),
        slug = VALUES(slug),
        email = VALUES(email),
        phone = VALUES(phone),
        address = VALUES(address),
        status = 'active',
        plan = VALUES(plan),
        active = 1,
        subscription_status = 'active',
        current_period_starts_at = VALUES(current_period_starts_at),
        current_period_ends_at = VALUES(current_period_ends_at),
        updated_at = VALUES(updated_at),
        updated_by = VALUES(updated_by)`,
    {
      replacements: {
        id: business.id,
        name: business.name,
        legalName: business.legalName,
        slug: business.slug,
        email: business.email,
        phone: business.phone,
        address: business.address,
        plan: business.plan,
        periodStart: `${range.from} 00:00:00`,
        periodEnd: `${range.to} 23:59:59`,
        createdAt: dateTime(monthDay(referenceDate, 1, -2), '08:00:00'),
        createdBy: CREATED_BY
      },
      type: QueryTypes.INSERT,
      transaction
    }
  );
}

async function upsertLogin(business, user, passwordHash, transaction) {
  await sequelize.query(
    `INSERT INTO login (
        id_login, id_business, id_rol, name, email, telephone, password, locked,
        active, created_at, created_by, updated_at, updated_by
      ) VALUES (
        :id, :businessId, :roleId, :name, :email, :phone, :password, 0,
        :active, NOW(), :createdBy, NOW(), :createdBy
      )
      ON DUPLICATE KEY UPDATE
        id_business = VALUES(id_business),
        id_rol = VALUES(id_rol),
        name = VALUES(name),
        email = VALUES(email),
        telephone = VALUES(telephone),
        password = VALUES(password),
        locked = 0,
        active = VALUES(active),
        updated_at = NOW(),
        updated_by = :createdBy`,
    {
      replacements: {
        id: user.id,
        businessId: business.id,
        roleId: user.roleId,
        name: user.name,
        email: user.email,
        phone: user.phone,
        password: passwordHash,
        active: user.active,
        createdBy: CREATED_BY
      },
      type: QueryTypes.INSERT,
      transaction
    }
  );
}

async function upsertProfessionalProfile(business, user, index, transaction) {
  if (!user.professional) {
    return null;
  }

  const profileId = `${user.id}_PROFILE`;
  await sequelize.query(
    `INSERT INTO doctor_professional_profile (
        id_doctor_professional_profile, id_business, id_login, professional_name,
        professional_license, university, specialty, specialty_license, professional_phone,
        signature_image, can_issue_prescriptions, can_sign_documents, is_active, created_at, created_by,
        updated_at, updated_by
      ) VALUES (
        :profileId, :businessId, :loginId, :professionalName,
        :license, 'Universidad QA', :specialty, :specialtyLicense, :phone,
        :signature, 1, 1, :active, NOW(), :createdBy, NOW(), :createdBy
      )
      ON DUPLICATE KEY UPDATE
        professional_name = VALUES(professional_name),
        professional_license = VALUES(professional_license),
        university = VALUES(university),
        specialty = VALUES(specialty),
        specialty_license = VALUES(specialty_license),
        professional_phone = VALUES(professional_phone),
        signature_image = VALUES(signature_image),
        can_issue_prescriptions = 1,
        can_sign_documents = 1,
        is_active = VALUES(is_active),
        updated_at = NOW(),
        updated_by = :createdBy`,
    {
      replacements: {
        profileId,
        businessId: business.id,
        loginId: user.id,
        professionalName: user.name.replaceAll('_', ' '),
        license: `QA-${business.key.toUpperCase()}-${String(index + 1).padStart(4, '0')}`,
        specialty: index % 2 === 0 ? 'Odontologia general' : 'Rehabilitacion oral',
        specialtyLicense: `QAESP-${business.key.toUpperCase()}-${String(index + 1).padStart(4, '0')}`,
        phone: user.phone,
        signature: `data:image/png;base64,QA_SIGNATURE_${user.id}`,
        active: user.active,
        createdBy: CREATED_BY
      },
      type: QueryTypes.INSERT,
      transaction
    }
  );
  return profileId;
}

async function seedBusinessConfig(business, users, referenceDate, transaction) {
  const configId = `${business.id}_CFG`;
  await sequelize.query(
    `INSERT INTO appointment_config (
        id_appointment_config, id_business, enabled, default_appointment_duration, timezone,
        active, created_at, created_by, updated_at, updated_by
      ) VALUES (
        :configId, :businessId, 1, 30, 'America/Mexico_City',
        1, NOW(), :createdBy, NOW(), :createdBy
      )
      ON DUPLICATE KEY UPDATE
        enabled = 1,
        default_appointment_duration = 30,
        timezone = 'America/Mexico_City',
        active = 1,
        updated_at = NOW(),
        updated_by = :createdBy`,
    {
      replacements: { configId, businessId: business.id, createdBy: CREATED_BY },
      type: QueryTypes.INSERT,
      transaction
    }
  );

  for (let day = 1; day <= 6; day += 1) {
    const dayId = `${business.key.toUpperCase()}_WD_${day}`;
    await sequelize.query(
      `INSERT INTO appointment_working_day (
          id_appointment_working_day, id_business, id_appointment_config, day_of_week,
          enabled, created_at, created_by, updated_at, updated_by
        ) VALUES (
          :dayId, :businessId, :configId, :day, 1, NOW(), :createdBy, NOW(), :createdBy
        )
        ON DUPLICATE KEY UPDATE
          enabled = 1,
          updated_at = NOW(),
          updated_by = :createdBy`,
      {
        replacements: { dayId, businessId: business.id, configId, day, createdBy: CREATED_BY },
        type: QueryTypes.INSERT,
        transaction
      }
    );

    const ranges = day === 6
      ? [['09:00:00', '13:00:00']]
      : [['08:00:00', '13:00:00'], ['14:00:00', '18:00:00']];

    for (let index = 0; index < ranges.length; index += 1) {
      await sequelize.query(
        `INSERT INTO appointment_time_range (
            id_appointment_time_range, id_business, id_appointment_working_day,
            start_time, end_time, created_at, created_by
          ) VALUES (
            :rangeId, :businessId, :dayId, :startTime, :endTime, NOW(), :createdBy
          )
          ON DUPLICATE KEY UPDATE
            start_time = VALUES(start_time),
            end_time = VALUES(end_time)`,
        {
          replacements: {
            rangeId: `${dayId}_R${index + 1}`,
            businessId: business.id,
            dayId,
            startTime: ranges[index][0],
            endTime: ranges[index][1],
            createdBy: CREATED_BY
          },
          type: QueryTypes.INSERT,
          transaction
        }
      );
    }
  }

  await sequelize.query(
    `INSERT INTO clinical_module_config (
        id_clinical_module_config, id_business, odontogram_enabled, treatment_plan_enabled,
        allow_treatment_tooth_selection, show_treatment_costs, show_treatment_status,
        active, created_at, created_by, updated_at, updated_by
      ) VALUES (
        :id, :businessId, 1, 1, 1, 1, 1, 1, NOW(), :createdBy, NOW(), :createdBy
      )
      ON DUPLICATE KEY UPDATE
        odontogram_enabled = 1,
        treatment_plan_enabled = 1,
        allow_treatment_tooth_selection = 1,
        show_treatment_costs = 1,
        show_treatment_status = 1,
        active = 1,
        updated_at = NOW(),
        updated_by = :createdBy`,
    {
      replacements: { id: `${business.id}_CLINICAL_MODULES`, businessId: business.id, createdBy: CREATED_BY },
      type: QueryTypes.INSERT,
      transaction
    }
  );

  const mainDoctor = users.find((item) => item.professional) || users[0];
  await sequelize.query(
    `INSERT INTO prescription_config (
        id_prescription_config, id_business, doctor_name, professional_license, university,
        specialty, specialty_license, clinic_name, clinic_address, clinic_phone,
        signature_image, footer_note, active, created_at, created_by, updated_at, updated_by
      ) VALUES (
        :id, :businessId, :doctorName, :license, 'Universidad QA',
        'Odontologia general', :specialtyLicense, :clinicName, :clinicAddress, :clinicPhone,
        :signature, 'Datos dummy para QA. No usar como receta real.', 1, NOW(), :createdBy, NOW(), :createdBy
      )
      ON DUPLICATE KEY UPDATE
        doctor_name = VALUES(doctor_name),
        professional_license = VALUES(professional_license),
        clinic_name = VALUES(clinic_name),
        clinic_address = VALUES(clinic_address),
        clinic_phone = VALUES(clinic_phone),
        signature_image = VALUES(signature_image),
        active = 1,
        updated_at = NOW(),
        updated_by = :createdBy`,
    {
      replacements: {
        id: `${business.id}_RX_CFG`,
        businessId: business.id,
        doctorName: mainDoctor.name.replaceAll('_', ' '),
        license: `QA-${business.key.toUpperCase()}-0001`,
        specialtyLicense: `QAESP-${business.key.toUpperCase()}-0001`,
        clinicName: business.name,
        clinicAddress: business.address,
        clinicPhone: business.phone,
        signature: `data:image/png;base64,QA_SIGNATURE_${mainDoctor.id}`,
        createdBy: CREATED_BY
      },
      type: QueryTypes.INSERT,
      transaction
    }
  );

  const theme = await sequelize.query(
    `SELECT id_cat_ui_theme
       FROM cat_ui_theme
      WHERE active = 1
      ORDER BY CASE WHEN code = 'medical-blue' THEN 0 ELSE 1 END, id_cat_ui_theme
      LIMIT 1`,
    { type: QueryTypes.SELECT, transaction }
  );

  if (theme[0]) {
    await sequelize.query(
      `INSERT INTO ui_theme_configuration (
          id_ui_theme_configuration, id_business, id_cat_ui_theme, active,
          created_by, created_at, updated_by, updated_at
        ) VALUES (
          :id, :businessId, :themeId, 1, :createdBy, NOW(), :createdBy, NOW()
        )
        ON DUPLICATE KEY UPDATE
          id_cat_ui_theme = VALUES(id_cat_ui_theme),
          active = 1,
          updated_by = :createdBy,
          updated_at = NOW()`,
      {
        replacements: {
          id: `${business.id}_THEME`,
          businessId: business.id,
          themeId: theme[0].id_cat_ui_theme,
          createdBy: CREATED_BY
        },
        type: QueryTypes.INSERT,
        transaction
      }
    );
  }

  return configId;
}

async function seedPatients(business, patients, transaction) {
  for (const patient of patients) {
    await sequelize.query(
      `INSERT INTO person (
          id_person, id_business, code, name, surname, birthday, age, ocupation,
          rfc, local_telephone, telephone, active, created_at, created_by, updated_at, updated_by,
          social_media
        ) VALUES (
          :id, :businessId, :code, :name, :surname, :birthday, :age, 'QA dummy',
          NULL, NULL, :phone, 1, :createdAt, :createdBy, :createdAt, :createdBy,
          NULL
        )
        ON DUPLICATE KEY UPDATE
          id_business = VALUES(id_business),
          code = VALUES(code),
          name = VALUES(name),
          surname = VALUES(surname),
          birthday = VALUES(birthday),
          age = VALUES(age),
          telephone = VALUES(telephone),
          active = 1,
          created_at = VALUES(created_at),
          updated_at = VALUES(updated_at),
          updated_by = :createdBy`,
      {
        replacements: {
          id: patient.id,
          businessId: business.id,
          code: patient.code,
          name: patient.name,
          surname: patient.surname,
          birthday: patient.birthday,
          age: patient.age,
          phone: patient.phone,
          createdAt: patient.createdAt,
          createdBy: CREATED_BY
        },
        type: QueryTypes.INSERT,
        transaction
      }
    );

    await sequelize.query(
      `INSERT INTO patient_extra_info (
          id_patient_extra_info, id_business, id_person, email, sex, address_state,
          address_city, address_references, active, created_at, created_by, updated_at, updated_by
        ) VALUES (
          :id, :businessId, :personId, :email, :sex, 'Jalisco',
          'Guadalajara', 'Domicilio dummy QA', 1, :createdAt, :createdBy, :createdAt, :createdBy
        )
        ON DUPLICATE KEY UPDATE
          email = VALUES(email),
          sex = VALUES(sex),
          active = 1,
          updated_at = VALUES(updated_at),
          updated_by = :createdBy`,
      {
        replacements: {
          id: `${patient.id}_EXTRA`,
          businessId: business.id,
          personId: patient.id,
          email: patient.email,
          sex: patient.sex,
          createdAt: patient.createdAt,
          createdBy: CREATED_BY
        },
        type: QueryTypes.INSERT,
        transaction
      }
    );
  }
}

async function seedAppointment(business, patients, appointment, transaction) {
  const patient = patients[appointment.patient - 1];
  const startTime = sqlTime(appointment.start || '09:00');
  const endTime = sqlTime(addMinutes(appointment.start || '09:00', 30));
  const blocksAvailability = ['confirmed', 'pending_confirmation', 'completed'].includes(appointment.status) ? 1 : 0;

  await sequelize.query(
    `INSERT INTO appointment (
        id_appointment, id_business, id_person, patient_name, contact_phone, id_tracing,
        appointment_date, start_time, end_time, status, title, description, source,
        cancellation_reason, rescheduled_from_appointment_id, rescheduled_to_appointment_id,
        blocks_availability, active, created_at, created_by, updated_at, updated_by
      ) VALUES (
        :id, :businessId, :personId, :patientName, :phone, :tracingId,
        :appointmentDate, :startTime, :endTime, :status, :title, :description, :source,
        :cancellationReason, NULL, NULL, :blocksAvailability, 1, :createdAt, :createdBy, :createdAt, :createdBy
      )
      ON DUPLICATE KEY UPDATE
        id_business = VALUES(id_business),
        id_person = VALUES(id_person),
        patient_name = VALUES(patient_name),
        contact_phone = VALUES(contact_phone),
        id_tracing = VALUES(id_tracing),
        appointment_date = VALUES(appointment_date),
        start_time = VALUES(start_time),
        end_time = VALUES(end_time),
        status = VALUES(status),
        title = VALUES(title),
        description = VALUES(description),
        source = VALUES(source),
        cancellation_reason = VALUES(cancellation_reason),
        blocks_availability = VALUES(blocks_availability),
        active = 1,
        updated_at = VALUES(updated_at),
        updated_by = :createdBy`,
    {
      replacements: {
        id: appointment.id,
        businessId: business.id,
        personId: patient.id,
        patientName: `${patient.name} ${patient.surname}`,
        phone: patient.phone,
        tracingId: appointment.tracingId || null,
        appointmentDate: isoDate(appointment.date),
        startTime,
        endTime,
        status: appointment.status,
        title: appointment.title || 'Consulta QA',
        description: appointment.description || 'Cita dummy para QA de dashboard.',
        source: appointment.source || 'manual',
        cancellationReason: appointment.status === 'cancelled' ? 'Cancelacion dummy QA' : null,
        blocksAvailability,
        createdAt: appointment.createdAt || dateTime(appointment.date, '08:00:00'),
        createdBy: appointment.createdBy || CREATED_BY
      },
      type: QueryTypes.INSERT,
      transaction
    }
  );
}

function appointmentPlans(referenceDate, prefix, clinical = false) {
  const current = clinical
    ? [
        [1, 2, 'completed', '08:30'], [1, 20, 'confirmed', '09:00'], [2, 3, 'completed', '09:30'],
        [3, 4, 'completed', '10:00'], [3, 22, 'confirmed', '10:30'], [4, 5, 'pending_confirmation', '11:00'],
        [5, 6, 'cancelled', '11:30'], [6, 7, 'no_show', '12:00'], [7, 8, 'completed', '14:00'],
        [8, 9, 'pending_confirmation', '14:30'], [9, 10, 'confirmed', '15:00'], [10, 11, 'rescheduled', '15:30'],
        [11, 12, 'completed', '16:00'], [12, 13, 'cancelled', '16:30'], [13, 14, 'pending_confirmation', '08:30'],
        [14, 15, 'completed', '09:00'], [15, 16, 'confirmed', '09:30'], [16, 17, 'pending_confirmation', '10:00'],
        [17, 18, 'cancelled', '10:30'], [18, 19, 'no_show', '11:00'], [19, 21, 'confirmed', '11:30'],
        [20, 23, 'pending_confirmation', '12:00'], [2, 24, 'completed', '14:00'], [4, 25, 'cancelled', '14:30'],
        [6, 26, 'pending_confirmation', '15:00'], [8, 27, 'rescheduled', '15:30'], [10, 28, 'confirmed', '16:00']
      ]
    : [
        [1, 2, 'completed', '09:00'], [1, 19, 'confirmed', '09:30'], [2, 5, 'completed', '10:00'],
        [3, 7, 'confirmed', '10:30'], [3, 22, 'completed', '11:00'], [4, 9, 'pending_confirmation', '11:30'],
        [5, 10, 'cancelled', '12:00'], [6, 12, 'no_show', '14:00'], [7, 14, 'completed', '14:30'],
        [8, 16, 'pending_confirmation', '15:00'], [9, 18, 'confirmed', '15:30'], [10, 20, 'rescheduled', '16:00'],
        [11, 23, 'pending_confirmation', '16:30'], [12, 25, 'cancelled', '09:00'], [13, 26, 'confirmed', '09:30']
      ];

  const previous = clinical
    ? [
        [1, 3, 'completed'], [2, 5, 'completed'], [3, 8, 'cancelled'], [4, 10, 'completed'],
        [5, 13, 'pending_confirmation'], [6, 16, 'completed'], [7, 18, 'no_show'], [8, 20, 'confirmed'],
        [9, 23, 'completed'], [10, 26, 'cancelled'], [11, 27, 'confirmed']
      ]
    : [
        [1, 4, 'completed'], [2, 8, 'completed'], [3, 12, 'cancelled'], [4, 16, 'confirmed'],
        [5, 20, 'pending_confirmation'], [6, 24, 'completed']
      ];

  const rows = [];
  current.forEach(([patient, day, status, start], index) => {
    rows.push({
      id: `${prefix}_APT_${String(index + 1).padStart(3, '0')}`,
      patient,
      date: monthDay(referenceDate, day, 0),
      start,
      status,
      createdAt: dateTime(monthDay(referenceDate, Math.max(1, Math.min(day - 2, 28)), 0), '08:10:00')
    });
  });

  previous.forEach(([patient, day, status], index) => {
    rows.push({
      id: `${prefix}_APT_PREV_${String(index + 1).padStart(3, '0')}`,
      patient,
      date: monthDay(referenceDate, day, -1),
      start: ['09:00', '10:00', '11:00', '14:00'][index % 4],
      status,
      createdAt: dateTime(monthDay(referenceDate, day, -1), '08:10:00')
    });
  });

  return rows;
}

async function seedAppointments(business, patients, referenceDate, prefix, clinical, transaction) {
  for (const appointment of appointmentPlans(referenceDate, prefix, clinical)) {
    await seedAppointment(business, patients, appointment, transaction);
  }
}

async function seedTreatmentPlans(business, patients, users, referenceDate, prefix, clinical, transaction) {
  const doctor = users.find((user) => user.professional) || users[0];
  const planCount = clinical ? 12 : 8;

  for (let index = 1; index <= planCount; index += 1) {
    const patient = patients[index - 1];
    const planId = `${prefix}_TPLAN_${String(index).padStart(2, '0')}`;
    const isClosed = index % 5 === 0;
    const startedAt = monthDay(referenceDate, Math.max(2, index + 2), 0);
    await sequelize.query(
      `INSERT INTO treatment_plan (
          id_treatment_plan, id_business, id_person, title, diagnosis, notes, status,
          started_at, closed_at, closed_by, close_reason, active, created_at, created_by, updated_at, updated_by
        ) VALUES (
          :planId, :businessId, :personId, :title, :diagnosis, :notes, :status,
          :startedAt, :closedAt, :closedBy, :closeReason, 1, :createdAt, :createdBy, :createdAt, :createdBy
        )
        ON DUPLICATE KEY UPDATE
          title = VALUES(title),
          diagnosis = VALUES(diagnosis),
          notes = VALUES(notes),
          status = VALUES(status),
          started_at = VALUES(started_at),
          closed_at = VALUES(closed_at),
          closed_by = VALUES(closed_by),
          close_reason = VALUES(close_reason),
          active = 1,
          updated_at = VALUES(updated_at),
          updated_by = :createdBy`,
      {
        replacements: {
          planId,
          businessId: business.id,
          personId: patient.id,
          title: index % 2 === 0 ? 'Plan restaurativo QA' : 'Plan preventivo QA',
          diagnosis: 'Diagnostico dummy sin datos sensibles.',
          notes: 'Plan dummy para validar KPIs de tratamiento.',
          status: isClosed ? 'closed' : 'active',
          startedAt: isoDate(startedAt),
          closedAt: isClosed ? dateTime(addDays(startedAt, 7), '17:00:00') : null,
          closedBy: isClosed ? doctor.id : null,
          closeReason: isClosed ? 'Cierre dummy QA' : null,
          createdAt: dateTime(startedAt, '09:00:00'),
          createdBy: doctor.id
        },
        type: QueryTypes.INSERT,
        transaction
      }
    );

    const itemCount = index % 3 === 0 ? 2 : 1;
    for (let item = 1; item <= itemCount; item += 1) {
      const treatment = TREATMENTS[(index + item) % TREATMENTS.length];
      const hasCost = clinical ? index <= 10 : index <= 5;
      const cost = hasCost ? treatment[2] + (clinical ? 700 : 0) + item * 250 : null;
      const status = isClosed ? 'completed' : (item % 2 === 0 ? 'in_progress' : 'pending');
      const patientTreatmentId = `${planId}_ITEM_${item}`;
      await sequelize.query(
        `INSERT INTO patient_treatment (
            id_patient_treatment, id_business, id_person, id_treatment_plan, name, description,
            category, status, priority, estimated_start_date, estimated_end_date, cost, notes,
            source, active, created_at, created_by, updated_at, updated_by
          ) VALUES (
            :id, :businessId, :personId, :planId, :name, :description,
            :category, :status, :priority, :estimatedStart, :estimatedEnd, :cost, :notes,
            'manual', 1, :createdAt, :createdBy, :createdAt, :createdBy
          )
          ON DUPLICATE KEY UPDATE
            name = VALUES(name),
            description = VALUES(description),
            category = VALUES(category),
            status = VALUES(status),
            priority = VALUES(priority),
            estimated_start_date = VALUES(estimated_start_date),
            estimated_end_date = VALUES(estimated_end_date),
            cost = VALUES(cost),
            notes = VALUES(notes),
            active = 1,
            updated_at = VALUES(updated_at),
            updated_by = :createdBy`,
        {
          replacements: {
            id: patientTreatmentId,
            businessId: business.id,
            personId: patient.id,
            planId,
            name: treatment[0],
            description: 'Tratamiento dummy QA.',
            category: treatment[1],
            status,
            priority: index % 2 === 0 ? 'medium' : 'high',
            estimatedStart: isoDate(startedAt),
            estimatedEnd: isoDate(addDays(startedAt, 14 + item)),
            cost,
            notes: cost ? 'Costo capturado para KPI.' : 'Sin costo para validar exclusion de KPI.',
            createdAt: dateTime(startedAt, '09:30:00'),
            createdBy: doctor.id
          },
          type: QueryTypes.INSERT,
          transaction
        }
      );

      if (item === 1) {
        await sequelize.query(
          `INSERT INTO patient_treatment_tooth (
              id_patient_treatment_tooth, id_business, id_patient_treatment, tooth_number, tooth_surface, created_at
            ) VALUES (
              :id, :businessId, :patientTreatmentId, :toothNumber, 'oclusal', NOW()
            )
            ON DUPLICATE KEY UPDATE
              tooth_number = VALUES(tooth_number),
              tooth_surface = VALUES(tooth_surface)`,
          {
            replacements: {
              id: `${patientTreatmentId}_TOOTH`,
              businessId: business.id,
              patientTreatmentId,
              toothNumber: String(11 + (index % 20))
            },
            type: QueryTypes.INSERT,
            transaction
          }
        );
      }
    }
  }
}

async function seedFollowUps(business, patients, users, referenceDate, prefix, clinical, transaction) {
  const doctor = users.find((user) => user.professional) || users[0];
  const due = clinical ? 6 : 4;
  const scheduled = clinical ? 3 : 2;

  for (let index = 1; index <= due; index += 1) {
    const patient = patients[index + 1];
    const tracingId = `${prefix}_TRACE_${String(index).padStart(2, '0')}`;
    const dueDate = monthDay(referenceDate, 18 + index, 0);
    await sequelize.query(
      `INSERT INTO tracing (
          id_tracing, id_business, id_treatment_plan, id_patient_treatment, treatment_relation_type,
          treatment_text, quote_date_now, treatment_now, quote_date_after, treatment_after,
          note, id_person, created_at, created_by
        ) VALUES (
          :id, :businessId, NULL, NULL, 'manual',
          'Seguimiento dummy QA', :quoteNow, 'Revision inicial QA', :quoteAfter, 'Seguimiento QA',
          :note, :personId, :createdAt, :createdBy
        )
        ON DUPLICATE KEY UPDATE
          id_business = VALUES(id_business),
          id_person = VALUES(id_person),
          quote_date_now = VALUES(quote_date_now),
          quote_date_after = VALUES(quote_date_after),
          note = VALUES(note)`,
      {
        replacements: {
          id: tracingId,
          businessId: business.id,
          quoteNow: isoDate(addDays(dueDate, -14)),
          quoteAfter: isoDate(dueDate),
          note: index <= scheduled ? 'Seguimiento con cita ligada.' : 'Seguimiento pendiente sin cita ligada.',
          personId: patient.id,
          createdAt: dateTime(addDays(dueDate, -14), '12:00:00'),
          createdBy: doctor.id
        },
        type: QueryTypes.INSERT,
        transaction
      }
    );

    if (index <= scheduled) {
      await seedAppointment(
        business,
        patients,
        {
          id: `${prefix}_TRACE_APT_${String(index).padStart(2, '0')}`,
          patient: index + 2,
          date: dueDate,
          start: ['09:00', '10:00', '11:00'][index % 3],
          status: index % 2 === 0 ? 'pending_confirmation' : 'confirmed',
          tracingId,
          source: 'follow_up',
          title: 'Seguimiento QA',
          description: 'Cita creada desde seguimiento QA.',
          createdAt: dateTime(addDays(dueDate, -8), '08:20:00'),
          createdBy: doctor.id
        },
        transaction
      );
    }
  }
}

async function seedPrescriptions(business, patients, users, referenceDate, prefix, clinical, transaction) {
  const doctors = users.filter((user) => user.professional);
  const current = clinical
    ? { issued: 12, draft: 5, cancelled: 2, previousIssued: 4 }
    : { issued: 5, draft: 2, cancelled: 1, previousIssued: 3 };
  const allRows = [];
  let seq = 1;

  const pushRows = (count, status, monthOffset) => {
    for (let index = 0; index < count; index += 1) {
      const day = 3 + ((index * 3) % 24);
      allRows.push({
        id: `${prefix}_RX_${String(seq).padStart(3, '0')}`,
        seq,
        patient: ((index + seq) % BASE_PATIENT_COUNT) + 1,
        doctor: doctors[index % doctors.length],
        status,
        issueDate: monthDay(referenceDate, day, monthOffset),
        createdAt: dateTime(monthDay(referenceDate, day, monthOffset), '13:00:00')
      });
      seq += 1;
    }
  };

  pushRows(current.issued, 'issued', 0);
  pushRows(current.draft, 'draft', 0);
  pushRows(current.cancelled, 'cancelled', 0);
  pushRows(current.previousIssued, 'issued', -1);

  for (const row of allRows) {
    const patient = patients[row.patient - 1];
    const profileId = `${row.doctor.id}_PROFILE`;
    await sequelize.query(
      `INSERT INTO prescription (
          id_prescription, id_business, id_person, issuer_doctor_id, issuer_doctor_profile_id,
          created_by, issued_by, cancelled_by, folio, status, issue_date, issued_at,
          diagnosis, notes, cancellation_reason, cancelled_at, doctor_name_snapshot,
          professional_license_snapshot, university_snapshot, specialty_snapshot,
          specialty_license_snapshot, professional_phone_snapshot, clinic_name_snapshot,
          clinic_address_snapshot, clinic_phone_snapshot, signature_snapshot, active,
          created_at, updated_at, updated_by
        ) VALUES (
          :id, :businessId, :personId, :doctorId, :profileId,
          :createdBy, :issuedBy, :cancelledBy, :folio, :status, :issueDate, :issuedAt,
          'Diagnostico dummy QA', 'Receta dummy QA', :cancelReason, :cancelledAt, :doctorName,
          :license, 'Universidad QA', 'Odontologia general',
          :specialtyLicense, :doctorPhone, :clinicName,
          :clinicAddress, :clinicPhone, :signature, 1,
          :createdAt, :createdAt, :createdBy
        )
        ON DUPLICATE KEY UPDATE
          id_person = VALUES(id_person),
          issuer_doctor_id = VALUES(issuer_doctor_id),
          issuer_doctor_profile_id = VALUES(issuer_doctor_profile_id),
          status = VALUES(status),
          issue_date = VALUES(issue_date),
          issued_at = VALUES(issued_at),
          cancelled_by = VALUES(cancelled_by),
          cancellation_reason = VALUES(cancellation_reason),
          cancelled_at = VALUES(cancelled_at),
          active = 1,
          updated_at = VALUES(updated_at),
          updated_by = :createdBy`,
      {
        replacements: {
          id: row.id,
          businessId: business.id,
          personId: patient.id,
          doctorId: row.doctor.id,
          profileId,
          createdBy: row.doctor.id,
          issuedBy: row.status === 'issued' ? row.doctor.id : null,
          cancelledBy: row.status === 'cancelled' ? row.doctor.id : null,
          folio: `${business.key.toUpperCase()}-${String(row.seq).padStart(4, '0')}`,
          status: row.status,
          issueDate: isoDate(row.issueDate),
          issuedAt: row.status === 'issued' ? dateTime(row.issueDate, '13:15:00') : null,
          cancelReason: row.status === 'cancelled' ? 'Cancelacion dummy QA' : null,
          cancelledAt: row.status === 'cancelled' ? dateTime(row.issueDate, '14:00:00') : null,
          doctorName: row.doctor.name.replaceAll('_', ' '),
          license: `QA-${business.key.toUpperCase()}-0001`,
          specialtyLicense: `QAESP-${business.key.toUpperCase()}-0001`,
          doctorPhone: row.doctor.phone,
          clinicName: business.name,
          clinicAddress: business.address,
          clinicPhone: business.phone,
          signature: `data:image/png;base64,QA_SIGNATURE_${row.doctor.id}`,
          createdAt: row.createdAt
        },
        type: QueryTypes.INSERT,
        transaction
      }
    );

    await sequelize.query(
      `INSERT INTO prescription_item (
          id_prescription_item, id_prescription, id_business, generic_name, commercial_name,
          presentation, concentration, pharmaceutical_form, dose, administration_route,
          frequency, duration, quantity, indications, sort_order, created_at, updated_at
        ) VALUES (
          :id, :prescriptionId, :businessId, 'Paracetamol', 'QA Medicamento',
          'Tabletas', '500 mg', 'Tableta', '1 tableta', 'Oral',
          'Cada 8 horas', '3 dias', '9 tabletas', 'Indicaciones dummy QA.', 1, :createdAt, :createdAt
        )
        ON DUPLICATE KEY UPDATE
          generic_name = VALUES(generic_name),
          dose = VALUES(dose),
          frequency = VALUES(frequency),
          duration = VALUES(duration),
          updated_at = VALUES(updated_at)`,
      {
        replacements: {
          id: `${row.id}_ITEM_1`,
          prescriptionId: row.id,
          businessId: business.id,
          createdAt: row.createdAt
        },
        type: QueryTypes.INSERT,
        transaction
      }
    );
  }

  await sequelize.query(
    `INSERT INTO prescription_folio_counter (id_business, folio_year, current_value, updated_at)
      VALUES (:businessId, :year, :currentValue, NOW())
      ON DUPLICATE KEY UPDATE current_value = VALUES(current_value), updated_at = NOW()`,
    {
      replacements: {
        businessId: business.id,
        year: referenceDate.getFullYear(),
        currentValue: allRows.length
      },
      type: QueryTypes.INSERT,
      transaction
    }
  );
}

async function seedClinicalHistories(business, patients, users, referenceDate, prefix, clinical, transaction) {
  const doctors = users.filter((user) => user.professional);
  const current = clinical
    ? { finalized: 9, draft: 5, previousFinalized: 3 }
    : { finalized: 4, draft: 3, previousFinalized: 2 };
  const rows = [];
  let seq = 1;

  const pushRows = (count, status, monthOffset) => {
    for (let index = 0; index < count; index += 1) {
      const day = 4 + ((index * 2) % 22);
      const doctor = doctors[index % doctors.length];
      rows.push({
        id: `${prefix}_CH_${String(seq).padStart(3, '0')}`,
        patient: ((index + seq) % BASE_PATIENT_COUNT) + 1,
        doctor,
        status,
        createdAt: dateTime(monthDay(referenceDate, day, monthOffset), '09:45:00'),
        finalizedAt: status === 'FINALIZED' ? dateTime(monthDay(referenceDate, day, monthOffset), '11:00:00') : null
      });
      seq += 1;
    }
  };

  pushRows(current.finalized, 'FINALIZED', 0);
  pushRows(current.draft, 'DRAFT', 0);
  pushRows(current.previousFinalized, 'FINALIZED', -1);

  for (const row of rows) {
    const patient = patients[row.patient - 1];
    await sequelize.query(
      `INSERT INTO clinical_histories (
          id_clinical_history, business_id, patient_id, doctor_responsible_profile_id,
          doctor_responsible_user_id, created_by_user_id, updated_by_user_id,
          finalized_by_user_id, status, version_number, source, consent_document_id,
          template_version_id, template_snapshot_json, clinical_snapshot_json, finalized_at,
          created_at, updated_at, deleted_at
        ) VALUES (
          :id, :businessId, :personId, :profileId,
          :doctorId, :doctorId, :doctorId,
          :finalizedBy, :status, 1, 'MANUAL', NULL,
          NULL, :templateSnapshot, :clinicalSnapshot, :finalizedAt,
          :createdAt, :createdAt, NULL
        )
        ON DUPLICATE KEY UPDATE
          business_id = VALUES(business_id),
          patient_id = VALUES(patient_id),
          doctor_responsible_profile_id = VALUES(doctor_responsible_profile_id),
          doctor_responsible_user_id = VALUES(doctor_responsible_user_id),
          updated_by_user_id = VALUES(updated_by_user_id),
          finalized_by_user_id = VALUES(finalized_by_user_id),
          status = VALUES(status),
          clinical_snapshot_json = VALUES(clinical_snapshot_json),
          finalized_at = VALUES(finalized_at),
          created_at = VALUES(created_at),
          updated_at = VALUES(updated_at),
          deleted_at = NULL`,
      {
        replacements: {
          id: row.id,
          businessId: business.id,
          personId: patient.id,
          profileId: `${row.doctor.id}_PROFILE`,
          doctorId: row.doctor.id,
          finalizedBy: row.status === 'FINALIZED' ? row.doctor.id : null,
          status: row.status,
          templateSnapshot: safeJson({ qa: true, version: 1 }),
          clinicalSnapshot: safeJson({
            qa: true,
            motivo: 'Valoracion dummy QA',
            nota: 'No contiene datos clinicos reales.'
          }),
          finalizedAt: row.finalizedAt,
          createdAt: row.createdAt
        },
        type: QueryTypes.INSERT,
        transaction
      }
    );

    await sequelize.query(
      `INSERT INTO clinical_history_events (
          id_clinical_history_event, clinical_history_id, business_id, patient_id,
          event_type, user_id, metadata_json, created_at
        ) VALUES (
          :idCreated, :historyId, :businessId, :personId,
          'CREATED', :doctorId, :metadata, :createdAt
        )
        ON DUPLICATE KEY UPDATE metadata_json = VALUES(metadata_json), created_at = VALUES(created_at)`,
      {
        replacements: {
          idCreated: `${row.id}_EV_CREATED`,
          historyId: row.id,
          businessId: business.id,
          personId: patient.id,
          doctorId: row.doctor.id,
          metadata: safeJson({ qa: true }),
          createdAt: row.createdAt
        },
        type: QueryTypes.INSERT,
        transaction
      }
    );

    if (row.status === 'DRAFT') {
      await sequelize.query(
        `INSERT INTO clinical_history_events (
            id_clinical_history_event, clinical_history_id, business_id, patient_id,
            event_type, user_id, metadata_json, created_at
          ) VALUES (
            :idUpdated, :historyId, :businessId, :personId,
            'UPDATED', :doctorId, :metadata, :updatedAt
          )
          ON DUPLICATE KEY UPDATE metadata_json = VALUES(metadata_json), created_at = VALUES(created_at)`,
        {
          replacements: {
            idUpdated: `${row.id}_EV_UPDATED`,
            historyId: row.id,
            businessId: business.id,
            personId: patient.id,
            doctorId: row.doctor.id,
            metadata: safeJson({ qa: true, draftStillOpen: true }),
            updatedAt: row.createdAt
          },
          type: QueryTypes.INSERT,
          transaction
        }
      );
    }
  }
}

async function seedDocuments(business, patients, users, referenceDate, prefix, clinical, transaction) {
  const doctor = users.find((user) => user.professional) || users[0];
  const templateId = `${prefix}_DOC_TEMPLATE_1`;
  const versionId = `${templateId}_V1`;

  await sequelize.query(
    `INSERT INTO document_templates (
        id_document_template, id_business, template_type, license_category, template_subtype,
        is_premium, clinical_legal_safe, minimum_plan, block_mode, licensing_review_required,
        licensing_notes, name, description, requires_patient_signature, requires_doctor_signature,
        is_active, active, created_at, created_by, updated_at, updated_by
      ) VALUES (
        :templateId, :businessId, 'CONSENTIMIENTO_GENERAL_ATENCION', 'basic_document',
        'basic_consent', 0, 1, 'basic', 'never', 0,
        'Plantilla QA segura', 'Consentimiento QA', 'Documento dummy QA.',
        1, 1, 1, 1, NOW(), :createdBy, NOW(), :createdBy
      )
      ON DUPLICATE KEY UPDATE
        name = VALUES(name),
        description = VALUES(description),
        is_active = 1,
        active = 1,
        updated_at = NOW(),
        updated_by = :createdBy`,
    {
      replacements: { templateId, businessId: business.id, createdBy: CREATED_BY },
      type: QueryTypes.INSERT,
      transaction
    }
  );

  await sequelize.query(
    `INSERT INTO document_template_versions (
        id_document_template_version, id_document_template, version_number, content_html,
        status, is_current, created_at, created_by
      ) VALUES (
        :versionId, :templateId, 1, '<p>Documento dummy QA sin validez legal.</p>',
        'ACTIVE', 1, NOW(), :createdBy
      )
      ON DUPLICATE KEY UPDATE
        content_html = VALUES(content_html),
        status = 'ACTIVE',
        is_current = 1`,
    {
      replacements: { versionId, templateId, createdBy: CREATED_BY },
      type: QueryTypes.INSERT,
      transaction
    }
  );

  const counts = clinical
    ? { signed: 6, pending: 5, draft: 3, refused: 1 }
    : { signed: 3, pending: 3, draft: 2, refused: 1 };
  const rows = [];
  let seq = 1;
  const push = (count, status) => {
    for (let index = 0; index < count; index += 1) {
      rows.push({
        id: `${prefix}_PDOC_${String(seq).padStart(3, '0')}`,
        patient: ((seq + index) % BASE_PATIENT_COUNT) + 1,
        status,
        createdAt: dateTime(monthDay(referenceDate, 5 + ((seq * 2) % 20), 0), '15:00:00')
      });
      seq += 1;
    }
  };

  push(counts.signed, 'FIRMADO');
  push(counts.pending, 'PENDIENTE_FIRMA');
  push(counts.draft, 'BORRADOR');
  push(counts.refused, 'NO_FIRMADO_POR_NEGATIVA');

  for (const row of rows) {
    const patient = patients[row.patient - 1];
    await sequelize.query(
      `INSERT INTO patient_documents (
          id_patient_document, id_business, id_person, id_document_template,
          id_document_template_version, template_version_number, document_type, origin,
          status, title, content_html_snapshot, signed_content_html_snapshot,
          responsible_doctor_user_id, responsible_doctor_profile_id, doctor_name_snapshot,
          professional_license_snapshot, signed_at, signed_by_user_id, issued_by_user_id,
          active, created_at, created_by, updated_at, updated_by
        ) VALUES (
          :id, :businessId, :personId, :templateId,
          :versionId, 1, 'CONSENTIMIENTO_GENERAL_ATENCION', 'DOCUMENT_CENTER',
          :status, :title, '<p>Documento QA</p>', :signedHtml,
          :doctorId, :profileId, :doctorName,
          :license, :signedAt, :signedBy, :issuedBy,
          1, :createdAt, :createdBy, :createdAt, :createdBy
        )
        ON DUPLICATE KEY UPDATE
          id_person = VALUES(id_person),
          status = VALUES(status),
          signed_content_html_snapshot = VALUES(signed_content_html_snapshot),
          signed_at = VALUES(signed_at),
          signed_by_user_id = VALUES(signed_by_user_id),
          active = 1,
          updated_at = VALUES(updated_at),
          updated_by = :createdBy`,
      {
        replacements: {
          id: row.id,
          businessId: business.id,
          personId: patient.id,
          templateId,
          versionId,
          status: row.status,
          title: `Consentimiento QA ${seq}`,
          signedHtml: row.status === 'FIRMADO' ? '<p>Documento QA firmado</p>' : null,
          doctorId: doctor.id,
          profileId: `${doctor.id}_PROFILE`,
          doctorName: doctor.name.replaceAll('_', ' '),
          license: `QA-${business.key.toUpperCase()}-0001`,
          signedAt: row.status === 'FIRMADO' ? row.createdAt : null,
          signedBy: row.status === 'FIRMADO' ? doctor.id : null,
          issuedBy: doctor.id,
          createdAt: row.createdAt,
          createdBy: doctor.id
        },
        type: QueryTypes.INSERT,
        transaction
      }
    );

    await sequelize.query(
      `INSERT INTO patient_document_events (
          id_patient_document_event, id_patient_document, id_business, event_type,
          notes, created_at, created_by
        ) VALUES (
          :eventId, :documentId, :businessId, :eventType,
          'Evento dummy QA', :createdAt, :createdBy
        )
        ON DUPLICATE KEY UPDATE
          event_type = VALUES(event_type),
          created_at = VALUES(created_at)`,
      {
        replacements: {
          eventId: `${row.id}_EVENT`,
          documentId: row.id,
          businessId: business.id,
          eventType: row.status === 'FIRMADO' ? 'SIGNED' : 'CREATED',
          createdAt: row.createdAt,
          createdBy: doctor.id
        },
        type: QueryTypes.INSERT,
        transaction
      }
    );

    if (row.status === 'FIRMADO') {
      await sequelize.query(
        `INSERT INTO patient_document_signatures (
            id_patient_document_signature, id_patient_document, id_business, signature_role,
            signer_name_snapshot, signature_image, signed_at, signed_by_user_id, created_at, created_by
          ) VALUES (
            :signatureId, :documentId, :businessId, 'DOCTOR',
            :signer, :signatureImage, :signedAt, :doctorId, :signedAt, :doctorId
          )
          ON DUPLICATE KEY UPDATE
            signer_name_snapshot = VALUES(signer_name_snapshot),
            signature_image = VALUES(signature_image),
            signed_at = VALUES(signed_at),
            signed_by_user_id = VALUES(signed_by_user_id)`,
        {
          replacements: {
            signatureId: `${row.id}_SIG_DOCTOR`,
            documentId: row.id,
            businessId: business.id,
            signer: doctor.name.replaceAll('_', ' '),
            signatureImage: `data:image/png;base64,QA_SIGNATURE_${doctor.id}`,
            signedAt: row.createdAt,
            doctorId: doctor.id
          },
          type: QueryTypes.INSERT,
          transaction
        }
      );
    }

    if (row.status === 'PENDIENTE_FIRMA') {
      await sequelize.query(
        `INSERT INTO document_signature_requests (
            id_document_signature_request, id_business, id_person, id_patient_document,
            document_type, signature_role, channel, status, token_hash, token_fingerprint,
            expires_at, recipient_phone, recipient_email, metadata_json, created_by, created_at, updated_at
          ) VALUES (
            :requestId, :businessId, :personId, :documentId,
            'CONSENTIMIENTO_GENERAL_ATENCION', 'PATIENT', 'whatsapp', 'pending',
            :tokenHash, :tokenFingerprint, :expiresAt, :phone, :email,
            :metadata, :createdBy, :createdAt, :createdAt
          )
          ON DUPLICATE KEY UPDATE
            status = 'pending',
            expires_at = VALUES(expires_at),
            recipient_phone = VALUES(recipient_phone),
            recipient_email = VALUES(recipient_email),
            updated_at = VALUES(updated_at)`,
        {
          replacements: {
            requestId: `${row.id}_REMOTE_REQ`,
            businessId: business.id,
            personId: patient.id,
            documentId: row.id,
            tokenHash: hashToken(`${row.id}:qa-signature-request`),
            tokenFingerprint: hashToken(row.id).slice(0, 12),
            expiresAt: dateTime(addDays(referenceDate, 7), '23:59:59'),
            phone: patient.phone,
            email: patient.email,
            metadata: safeJson({ qa: true }),
            createdBy: doctor.id,
            createdAt: row.createdAt
          },
          type: QueryTypes.INSERT,
          transaction
        }
      );
    }
  }
}

async function expectedSummary(business) {
  const [patients] = await sequelize.query(
    'SELECT COUNT(*) AS total FROM person WHERE id_business = :businessId',
    { replacements: { businessId: business.id }, type: QueryTypes.SELECT }
  );
  const appointments = await sequelize.query(
    `SELECT status, COUNT(*) AS total
       FROM appointment
      WHERE id_business = :businessId
      GROUP BY status
      ORDER BY status`,
    { replacements: { businessId: business.id }, type: QueryTypes.SELECT }
  );
  const users = await sequelize.query(
    `SELECT r.code AS role, l.active, COUNT(*) AS total
       FROM login l
       LEFT JOIN rol r ON r.id_rol = l.id_rol
      WHERE l.id_business = :businessId
      GROUP BY r.code, l.active
      ORDER BY r.code, l.active DESC`,
    { replacements: { businessId: business.id }, type: QueryTypes.SELECT }
  );
  const economics = await sequelize.query(
    `SELECT COUNT(DISTINCT id_person) AS patientsWithCost,
            COUNT(*) AS itemsWithCost,
            COALESCE(SUM(cost), 0) AS estimatedValue
       FROM patient_treatment
      WHERE id_business = :businessId
        AND active = 1
        AND cost IS NOT NULL
        AND cost > 0
        AND status NOT IN ('cancelled', 'deleted')`,
    { replacements: { businessId: business.id }, type: QueryTypes.SELECT }
  );

  return {
    business: business.name,
    plan: business.plan,
    loginPhone: business.mainUser.phone,
    mainUser: business.mainUser.name,
    patients: Number(patients.total || 0),
    appointments,
    users,
    treatmentEconomics: economics[0] || {}
  };
}

async function seedTenant(business, roles, referenceDate, clinical, transaction) {
  await upsertBusiness(business, referenceDate, transaction);

  const users = userDefinitions(business, roles, clinical);
  const passwordHash = await encript(PASSWORD);
  for (const user of users) {
    await upsertLogin(business, user, passwordHash, transaction);
  }
  for (let index = 0; index < users.length; index += 1) {
    await upsertProfessionalProfile(business, users[index], index, transaction);
  }

  await seedBusinessConfig(business, users, referenceDate, transaction);
  const patients = buildPatients(clinical ? CLIN_PREFIX : PROF_PREFIX, business, referenceDate, clinical);
  await seedPatients(business, patients, transaction);
  await seedAppointments(business, patients, referenceDate, clinical ? CLIN_PREFIX : PROF_PREFIX, clinical, transaction);
  await seedTreatmentPlans(business, patients, users, referenceDate, clinical ? CLIN_PREFIX : PROF_PREFIX, clinical, transaction);
  await seedFollowUps(business, patients, users, referenceDate, clinical ? CLIN_PREFIX : PROF_PREFIX, clinical, transaction);
  await seedPrescriptions(business, patients, users, referenceDate, clinical ? CLIN_PREFIX : PROF_PREFIX, clinical, transaction);
  await seedClinicalHistories(business, patients, users, referenceDate, clinical ? CLIN_PREFIX : PROF_PREFIX, clinical, transaction);
  await seedDocuments(business, patients, users, referenceDate, clinical ? CLIN_PREFIX : PROF_PREFIX, clinical, transaction);
}

async function resolveRoles(transaction) {
  const admin = await firstAvailableRole(ROLE_CODES.adminCandidates, transaction);
  const doctor = await roleByCode(ROLE_CODES.doctor, transaction);
  const assistant = await firstAvailableRole(ROLE_CODES.assistantCandidates, transaction);

  if (!admin || !doctor || !assistant) {
    throw new Error('Faltan roles activos requeridos: admin/business_admin, doctor y assistant/reception.');
  }

  return { admin, doctor, assistant };
}

async function run() {
  assertExplicitFlag('ALLOW_QA_DEMO_SEED', 'YES');
  assertWritableDbAllowed();

  const referenceDate = parseReferenceDate();
  console.log('QA demo seed target:', safeDbTarget());
  console.log('Reference date:', isoDate(referenceDate));

  const transaction = await sequelize.transaction();
  try {
    const deleted = await resetQaDemoData(transaction);
    const deletedTotal = deleted.reduce((acc, row) => acc + Number(row.deleted || 0), 0);
    console.log(`Previous QA demo rows deleted in transaction: ${deletedTotal}`);

    const roles = await resolveRoles(transaction);
    await seedTenant(QA_BUSINESSES.professional, roles, referenceDate, false, transaction);
    await seedTenant(QA_BUSINESSES.clinical, roles, referenceDate, true, transaction);

    await transaction.commit();
  } catch (error) {
    await transaction.rollback();
    throw error;
  }

  const summaries = [
    await expectedSummary(QA_BUSINESSES.professional),
    await expectedSummary(QA_BUSINESSES.clinical)
  ];

  console.log('Seed completed.');
  console.log('Demo credentials:');
  console.log(`- ${QA_BUSINESSES.professional.mainUser.name}: telefono ${QA_BUSINESSES.professional.mainUser.phone}, password ${PASSWORD}`);
  console.log(`- ${QA_BUSINESSES.clinical.mainUser.name}: telefono ${QA_BUSINESSES.clinical.mainUser.phone}, password ${PASSWORD}`);
  console.log('Summary:');
  console.log(JSON.stringify(summaries, null, 2));
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeConnection();
  });

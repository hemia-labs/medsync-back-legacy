const ALLOWED_FIELD_TYPES = [
    'text',
    'textarea',
    'number',
    'date',
    'select',
    'multiselect',
    'checkbox',
    'boolean',
    'readonly'
];

const baseClinicalHistoryTemplate = {
    sections: [
        {
            key: 'identification',
            label: 'Ficha de identificación',
            description: 'Datos generales del paciente usados como referencia clínica.',
            enabled: true,
            order: 1,
            system: true,
            locked: true,
            fields: [
                { key: 'full_name', label: 'Nombre completo', type: 'readonly', required: false, source: 'patient.full_name' },
                { key: 'age', label: 'Edad', type: 'readonly', required: false, source: 'patient.age' },
                { key: 'birth_date', label: 'Fecha de nacimiento', type: 'readonly', required: false, source: 'patient.birth_date' },
                { key: 'sex', label: 'Sexo', type: 'readonly', required: false, source: 'patient.sex' },
                { key: 'phone', label: 'Teléfono', type: 'readonly', required: false, source: 'patient.phone' },
                { key: 'email', label: 'Correo', type: 'readonly', required: false, source: 'patient.email' },
                { key: 'address', label: 'Dirección', type: 'readonly', required: false, source: 'patient.address' },
                { key: 'emergency_contact', label: 'Contacto de emergencia', type: 'readonly', required: false, source: 'patient.emergency_contact' }
            ]
        },
        {
            key: 'consultation',
            label: 'Motivo de consulta y padecimiento actual',
            description: 'Motivo principal de atención y descripción clínica inicial.',
            enabled: true,
            order: 2,
            system: true,
            fields: [
                { key: 'reason', label: 'Motivo de consulta', type: 'textarea', required: true },
                { key: 'current_condition', label: 'Padecimiento actual', type: 'textarea', required: true },
                { key: 'evolution_time', label: 'Tiempo de evolución', type: 'text', required: false },
                { key: 'main_symptoms', label: 'Síntomas principales', type: 'textarea', required: false }
            ]
        },
        {
            key: 'family_history',
            label: 'Antecedentes heredofamiliares',
            description: 'Antecedentes familiares relevantes para el riesgo clínico.',
            enabled: true,
            order: 3,
            system: true,
            fields: [
                { key: 'relevant', label: 'Antecedentes heredofamiliares relevantes', type: 'textarea', required: false },
                { key: 'family_diseases', label: 'Enfermedades familiares', type: 'textarea', required: false }
            ]
        },
        {
            key: 'pathological_history',
            label: 'Antecedentes personales patológicos',
            description: 'Padecimientos, cirugías, hospitalizaciones y otros antecedentes médicos.',
            enabled: true,
            order: 4,
            system: true,
            fields: [
                { key: 'current_or_previous_diseases', label: 'Enfermedades previas o actuales', type: 'textarea', required: false },
                { key: 'surgeries', label: 'Cirugías previas', type: 'textarea', required: false },
                { key: 'hospitalizations', label: 'Hospitalizaciones', type: 'textarea', required: false },
                { key: 'trauma', label: 'Traumatismos', type: 'textarea', required: false },
                { key: 'transfusions', label: 'Transfusiones', type: 'textarea', required: false },
                { key: 'other', label: 'Otros antecedentes relevantes', type: 'textarea', required: false }
            ]
        },
        {
            key: 'non_pathological_history',
            label: 'Antecedentes personales no patológicos',
            description: 'Hábitos y entorno general del paciente.',
            enabled: true,
            order: 5,
            system: true,
            fields: [
                { key: 'smoking', label: 'Tabaquismo', type: 'textarea', required: false },
                { key: 'alcohol', label: 'Alcohol', type: 'textarea', required: false },
                { key: 'physical_activity', label: 'Actividad física', type: 'textarea', required: false },
                { key: 'diet', label: 'Alimentación', type: 'textarea', required: false },
                { key: 'housing_environment', label: 'Vivienda / entorno', type: 'textarea', required: false },
                { key: 'hygiene_general_habits', label: 'Higiene / hábitos generales', type: 'textarea', required: false },
                { key: 'other_habits', label: 'Otros hábitos relevantes', type: 'textarea', required: false }
            ]
        },
        {
            key: 'allergies_medications',
            label: 'Alergias y medicamentos actuales',
            description: 'Datos clave para reducir riesgos durante la atención.',
            enabled: true,
            order: 6,
            system: true,
            fields: [
                { key: 'allergies', label: 'Alergias', type: 'textarea', required: true },
                { key: 'current_medications', label: 'Medicamentos actuales', type: 'textarea', required: false },
                { key: 'known_adverse_reactions', label: 'Reacciones adversas conocidas', type: 'textarea', required: false }
            ]
        },
        {
            key: 'systems_review',
            label: 'Interrogatorio por aparatos y sistemas',
            description: 'Revisión clínica por aparatos y sistemas.',
            enabled: true,
            order: 7,
            system: true,
            fields: [
                { key: 'review', label: 'Revisión por aparatos y sistemas', type: 'textarea', required: false }
            ]
        },
        {
            key: 'physical_exam',
            label: 'Exploración física',
            description: 'Hallazgos generales y datos relevantes de exploración.',
            enabled: true,
            order: 8,
            system: true,
            fields: [
                { key: 'general', label: 'Exploración física general', type: 'textarea', required: true },
                { key: 'relevant_findings', label: 'Hallazgos relevantes', type: 'textarea', required: false }
            ]
        },
        {
            key: 'vital_signs',
            label: 'Signos vitales',
            description: 'Signos vitales y mediciones opcionales.',
            enabled: true,
            order: 9,
            system: true,
            fields: [
                { key: 'blood_pressure', label: 'Presión arterial', type: 'text', required: false },
                { key: 'heart_rate', label: 'Frecuencia cardiaca', type: 'number', required: false },
                { key: 'respiratory_rate', label: 'Frecuencia respiratoria', type: 'number', required: false },
                { key: 'temperature', label: 'Temperatura', type: 'number', required: false },
                { key: 'oxygen_saturation', label: 'Saturación de oxígeno', type: 'number', required: false },
                { key: 'weight', label: 'Peso', type: 'number', required: false },
                { key: 'height', label: 'Talla', type: 'number', required: false },
                { key: 'bmi', label: 'IMC', type: 'number', required: false }
            ]
        },
        {
            key: 'studies_results',
            label: 'Estudios y resultados',
            description: 'Estudios previos, resultados actuales y observaciones.',
            enabled: true,
            order: 10,
            system: true,
            fields: [
                { key: 'previous_studies', label: 'Estudios previos relevantes', type: 'textarea', required: false },
                { key: 'current_results', label: 'Resultados actuales', type: 'textarea', required: false },
                { key: 'lab_imaging_observations', label: 'Observaciones de laboratorio/gabinete', type: 'textarea', required: false }
            ]
        },
        {
            key: 'diagnosis',
            label: 'Diagnósticos o problemas clínicos',
            description: 'Diagnóstico inicial y problemas clínicos identificados.',
            enabled: true,
            order: 11,
            system: true,
            fields: [
                { key: 'initial_diagnosis', label: 'Diagnóstico inicial', type: 'textarea', required: true },
                { key: 'clinical_problems', label: 'Problemas clínicos identificados', type: 'textarea', required: false },
                { key: 'diagnostic_code', label: 'Código diagnóstico', type: 'text', required: false }
            ]
        },
        {
            key: 'prognosis',
            label: 'Pronóstico',
            description: 'Pronóstico clínico inicial.',
            enabled: true,
            order: 12,
            system: true,
            fields: [
                { key: 'prognosis', label: 'Pronóstico', type: 'textarea', required: false }
            ]
        },
        {
            key: 'therapeutic_plan',
            label: 'Indicación terapéutica y plan inicial',
            description: 'Indicaciones, tratamiento inicial y recomendaciones generales.',
            enabled: true,
            order: 13,
            system: true,
            fields: [
                { key: 'initial_indications', label: 'Indicaciones iniciales', type: 'textarea', required: false },
                { key: 'initial_plan', label: 'Plan terapéutico inicial', type: 'textarea', required: true },
                { key: 'general_recommendations', label: 'Recomendaciones generales', type: 'textarea', required: false }
            ]
        },
        {
            key: 'observations',
            label: 'Observaciones generales',
            description: 'Notas adicionales para contextualizar la historia clínica.',
            enabled: true,
            order: 14,
            system: true,
            fields: [
                { key: 'general', label: 'Observaciones generales', type: 'textarea', required: false }
            ]
        }
    ]
};

module.exports = {
    ALLOWED_FIELD_TYPES,
    baseClinicalHistoryTemplate
};

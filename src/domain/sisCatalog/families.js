'use strict';
// NC4/L2: familias de catálogo del contrato NC1 v1.1 §5. Las diez SIS tienen status 'contract'.
// Las cinco de nacionalidad y geografía (CR-2) tienen status 'accepted' desde v1.1, pero todavía
// no tienen lector ni fuente descargada: readerAvailable es false y no existe ningún release.
// `source` describe cómo leer el archivo oficial cotejado el 2026-11-13 (nombres de hoja/columna reales).

const FAMILIES = Object.freeze({
    'sis.country': {
        status: 'contract', sourceCatalogName: 'PAÍS', rector: 'DGIS',
        source: { sheet: 0, headerRow: 0, code: 'CATALOG_KEY', label: 'DESCRIPCION', attributes: ['ORDEN'] }
    },
    'sis.federal_entity': {
        status: 'contract', sourceCatalogName: 'ENTIDAD FEDERATIVA', rector: 'DGIS',
        // 00 NO ESPECIFICADO, 88 NO APLICA y 99 SE IGNORA son entradas del catálogo pero no lugares:
        // la identidad no las guarda como dato; el descriptor las emite como excepción de salida.
        sentinelCodes: ['00', '88', '99'],
        source: { sheet: 0, headerRow: 0, code: 'CATALOG_KEY', label: 'ENTIDAD_FEDERATIVA', attributes: ['ABREVIATURA'] }
    },
    'sis.establishments': {
        status: 'contract', sourceCatalogName: 'ESTABLECIMIENTO_DE_SALUD_SIS', rector: 'DGIS',
        // El archivo SIS solo trae unidades con en_operacion=1 (15 358/15 358 en la revisión 2026-10-27).
        // No confundir con el maestro ESTABLECIMIENTO_SALUD (CAT_CLUES del Apéndice A).
        codePattern: /^[A-Z0-9]{11}$/,
        source: {
            sheet: 0, headerRow: 0, code: 'clues', label: 'nombre_unidad',
            attributes: ['en_operacion', 'tipo_unidad', 'tip_abreviacion', 'sub_abreviacion', 'institucion', 'id_entidad_federativa']
        }
    },
    'sis.personnel_type': {
        status: 'contract', sourceCatalogName: 'TIPO PERSONAL – SIS', rector: 'DGIS',
        source: { sheet: 'TIPO_PERSONAL', headerRow: 0, code: 'CATALOG_KEY', label: 'TIPO_PERSONAL', attributes: [] }
    },
    'sis.affiliation': {
        status: 'contract', sourceCatalogName: 'AFILIACION', rector: 'DGIS',
        source: { sheet: 0, headerRow: 0, code: 'CATALOG_KEY', label: 'DESCRIPCIÓN CORTA', attributes: ['DESCRIPCIÓN LARGA'] }
    },
    'sis.diagnosis': {
        status: 'contract', sourceCatalogName: 'DIAGNOSTICO_SIS', rector: 'DGIS',
        codePattern: /^[A-Z0-9]{4}$/,
        source: {
            sheet: 0, headerRow: 0, code: 'CATALOG_KEY', label: 'NOMBRE',
            attributes: ['LETRA', 'LSEX', 'LINF', 'LSUP', 'EPI_CLAVE', 'TIPO_PERSONAL_1VEZ_CE', 'TIPO_PERSONAL_SUBSEC_CE', 'VALIDO_SB']
        }
    },
    'sis.referral_service': { status: 'contract', sourceCatalogName: 'SERVICIO DE ATENCIÓN POR REFERENCIA', rector: 'DGIS', source: null },
    'sis.friendly_service': { status: 'contract', sourceCatalogName: 'DIRECTORIO SERVICIOS AMIGABLES', rector: 'DGIS', source: null },
    'sis.personnel_service_ce': {
        status: 'contract', sourceCatalogName: 'SERVICIOS DE ATENCIÓN POR TIPO DE PERSONAL SIS-CE', rector: 'DGIS',
        source: { sheet: 0, headerRow: 0, code: 'CATALOG_KEY', label: 'DESCRIPCION', attributes: [] },
        relation: { sheet: 'POR_PERSONAL_CONSULTA_EXTERNA', headerRow: 1, rightCode: 'CATALOG_KEY', leftFamily: 'sis.personnel_type' }
    },
    'sis.personnel_service_sb': {
        status: 'contract', sourceCatalogName: 'SERVICIOS DE ATENCIÓN POR TIPO DE PERSONAL SIS-SB', rector: 'DGIS',
        source: { sheet: 0, headerRow: 0, code: 'CATALOG_KEY', label: 'DESCRIPCION', attributes: [] },
        relation: { sheet: 'POR_PERSONAL_SALUD_BUCAL', headerRow: 1, rightCode: 'CATALOG_KEY', leftFamily: 'sis.personnel_type' }
    },
    // Aceptadas en v1.1 (NOM-024 Tabla 1 y Apéndice A). Sin lector ni fuente oficial descargada todavía.
    'renapo.nationality': { status: 'accepted', sourceCatalogName: 'CAT_NACIONALIDAD (Catálogo de Nacionalidades RENAPO)', rector: 'RENAPO', codePattern: /^[A-Z]{3}$/, source: null },
    'inegi.state': { status: 'accepted', sourceCatalogName: 'CAT_ENTIDADES (INEGI)', rector: 'INEGI', codePattern: /^\d{2}$/, source: null },
    'inegi.municipality': { status: 'accepted', sourceCatalogName: 'CAT_MUNICIPIOS (INEGI); código compuesto EE+MMM', rector: 'INEGI', codePattern: /^\d{5}$/, source: null },
    'inegi.locality': { status: 'accepted', sourceCatalogName: 'CAT_LOCALIDADES (INEGI); código compuesto EE+MMM+LLLL', rector: 'INEGI', codePattern: /^\d{9}$/, source: null },
    'sepomex.postal_code': { status: 'accepted', sourceCatalogName: 'CODIGO_POSTAL (Correos de México)', rector: 'Correos de México', codePattern: /^\d{5}$/, source: null }
});

const getFamily = key => (Object.prototype.hasOwnProperty.call(FAMILIES, key) ? FAMILIES[key] : null);
const contractFamilies = () => Object.keys(FAMILIES).filter(key => FAMILIES[key].status === 'contract');
const acceptedFamilies = () => Object.keys(FAMILIES).filter(key => FAMILIES[key].status === 'accepted');
const readerAvailable = key => Boolean(getFamily(key) && getFamily(key).source);

module.exports = { FAMILIES, getFamily, contractFamilies, acceptedFamilies, readerAvailable };

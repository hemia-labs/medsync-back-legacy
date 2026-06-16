module.exports = {
    /**Permite realizar el inicio de sesion al sistema */
    SP_LOGIN : 'CALL SP_LOGIN(:_param,:_pwd)',
    /**Permite obtener datos del usuario con base al numero de telefono */
    SP_LOGIN_BY_TELEPHONE : 'CALL SP_login_by_telephone(:_param)',
    /**Permite obtener datos del usuario con base al id */
    SP_LOGIN_BY_ID_LOGIN : 'CALL SP_login_by_idlogin(:_id_login,:_refresh)',
    /**Permite obtener datos del refresh token */
    SP_LOGIN_REFRESH_TOKEN : 'CALL SP_refresh_token(:_refresh_token)',
    /**Permite cerrar de manera forzada la sessión */
    SP_LOGIN_FORZE_CLOSE : 'CALL SP_forze_session(:_id_user,:_date,:_userClose)',
    /** */
    SP_LOGIN_CLOSE : 'CALL SP_Close_session(:_id_login)',
    /**Permite validar un inicio de sesión */
    SP_TOKEN_VALIDATE : 'CALL SP_token_validate(:_id_login)',
    /**Permite realizar el inicio de sesion al sistema */
    SP_ROL_LIST : 'CALL SP_Rol_Obtener()',
    /**Permite registrar un nuevo usuario al sistema */
    SP_USER_SAVE : 'CALL SP_login_Save(:_id_rol,:_name,:_email,:_telephone,:_password,:_id_business)',
    /**Permite obtener todos los usuarios del sistema */
    SP_USER_LIST : 'CALL SP_login_Obtener(:_id,:_id_business,:_is_super_admin)',
    /**Permite actualizar un usuario especifico del sistema */
    SP_USER_UPDATE : 'CALL SP_login_Update(:_id_login,:_id_rol,:_name,:_email,:_telephone,:_active,:_id_business,:_is_super_admin)',
    /**Permite obtener la informacion de un usuario con base al numero proporcionado */
    SP_USER_GET_BY_PHONE : 'CALL SP_user_get_by_phone(:_phone)',
    /**Permite registrar un otp para envio de mail */
    /**valida el otp para determinar si es valido */
    /**Permite actualizar la contraseña del usuario */
    /**Permite obtener los datos del px conforme al filtro */
    SP_PX_SEARCH : 'CALL Sp_person_search(:_param,:_id_business)',
    /**Permite obtener los datos de los px que deacuerdo al mes de cumpleaños */
    SP_PX_BIRTHDAY : 'CALL SP_px_birthday(:_month,:_id_business)',
    /**Permite obtener los datos de los px que deacuerdo al mes de cumpleaños */
    SP_FAMILY_PATH_GET : 'CALL SP_family_path_get()',
    /**Permite obtener lel expediente de un PX */
    SP_PX_GET_BY_ID : 'CALL SP_px_get_by_id(:_id_person,:_id_business)',
    /**Permite eliminar de manera fisica un PX */
    SP_PX_FORCE_DELETE : 'CALL Sp_px_force_delete(:_id_person,:_id_business)',
    /**Permite eliminar de manera logica un PX */
    SP_PX_DELETE : 'CALL SP_px_delete(:_id_person,:_active,:_id_login,:_id_business)',
    /**Permite Obtener el catalogo de tipos de archivos(recursos) */
    SP_CAT_GET_FILES : 'CALL SP_cat_files_Get()',
    /**Permite registrar un nuevo px */
    SP_PX_SAVE : 'CALL SP_px_Save(:_name,:_surname,:_birthday,:_age,:_ocupation,:_rfc,:_local_telephone,:_telephone,:_id_signature,:_name_signature,:_place_birth,:_residence,:_direction,:_cp,:_reason_consultation,:_current_condition,:_pulse,:_blood_pressure,:_dia,:_oxygenation,:_family_parents,:_family_brothers,:_family_grandparents,:_pathological_personal,:_has_allergy,:_description,:_social_media,:_id_login)',
    /**Permite registrar un nuevo px */
    SP_PX_UPDATE : 'CALL SP_px_Update(:_id_person,:_name,:_surname,:_birthday,:_age,:_ocupation,:_rfc,:_local_telephone,:_telephone,:_id_signature,:_name_signature,:_id_address,:_place_birth,:_residence,:_direction,:_cp,:_id_query,:_reason_consultation,:_current_condition,:_pulse,:_blood_pressure,:_dia,:_oxygenation,:_family_parents,:_family_brothers,:_family_grandparents,:_pathological_personal,:_id_allergy,:_has_allergy,:_description,:_social_media,:_id_login)',
    /**Permite obtener el catalogo de opciones de datos patologicos */
    SP_CAT_PATHOLOGICAL_PERSONAL : 'CALL SP_cat_pathological_personal_get()',
    /**Permite obtener el catalogo de secciones de datos patologicos */
    SP_CAT_SECTIONS_PATHOLOGICAL_PERSONAL : 'CALL SP_type_pathological_personal_get()',
    /**Permite registrar un archvio de imagen */
    SP_FILE_SAVE : 'CALL SP_file_save(:_code_cat_files,:_id_person,:_url,:_id_user)',
    /**Permite obtener las fotos de un px */
    SP_FILE_GET_BY_ID_PERSON : 'CALL SP_file_By_id_person(:_id_person)',
    /**Permite registrar un archvio de foto de perfil */
    SP_PROFILE_PX : 'CALL SP_profile_px(:_id_profile_px,:_id_person,:_url,:_key_img,:_id_login)',
    /**Elimina un archivo de la bd */
    SP_FILE_DELETE : 'CALL SP_files_delete(:_id_person,:_url,:_code)',
    /**Obtiene la lista de tipos de tratamientos */
     SP_CONDITIONS_GET : 'CALL SP_cat_treatment()',
    /**Permite registrar un nuevo registro de seguimiento de un paciente*/
    SP_TRACING_SAVE : 'CALL SP_tracing_Save(:_tracing,:_id_person,:_id_login,:_id_business)',
    /**Permite actualizar el registro de seguimiento de un paciente*/
    SP_TRACING_UPDATE : 'CALL SP_tracing_Update(:_tracing,:_id_person,:_id_login,:_id_business)',
    /**Permite eliminar el registro de seguimiento de un paciente*/
    SP_TRACING_DELETE : 'CALL SP_tracing_Delete(:_id_tracing,:_id_person,:_id_business)',
    /**Permite obtener el registro de seguimiento de un paciente*/
    SP_TRACING_GET : 'CALL SP_tracing_get(:_id_person,:_id_business)',
    /**Permite obtener las proximas citas de los pacientes*/
    SP_TRACING_NEXTQOUE : 'CALL SP_tracing_nextQuote(:_date,:_id_business)',
    /**Permite registrar un nuevo registro de tretamiento de un paciente*/
    SP_TREATMENT_SAVE : 'CALL SP_treatment_Save(:_treatment,:_id_person,:_id_login)',
    /**Permite actualizar el registro de tretamiento de un paciente*/
    SP_TREATMENT_UPDATE : 'CALL SP_treatment_Update(:_treatment,:_id_person,:_id_login)',
    /**Permite eliminar el registro de tretamiento de un paciente*/
    SP_TREATMENT_DELETE : 'CALL SP_treatment_Delete(:_id_treatment,:_id_person)',
    /**Permite obtener el registro de tretamiento de un paciente*/
    SP_TREATMENT_GET : 'CALL SP_treatment_Get(:_id_person)',
    /**Permite obtener el registro de tretamiento de un paciente*/
    SP_CAT_TREATMENT_GET : 'CALL SP_cat_treatment_Get(:_id_person)',
    /**Obtiene la lista de afecciones para el odontograma */
    SP_CAT_CONDITION : 'CALL SP_cat_condition_Get()',
    /**Obtiene la lista de dientes para el odontograma */
    SP_GET_TEETH : 'CALL SP_Teeth_Px_Get(:_id_person, :_code)',
    /**Obtiene la configuración de un diente */
    SP_ODONTOGRAM_GET : 'CALL SP_odontogram_Get(:_id_person,:_id_tooth)',
    /**Actualiza configuración de un diente */
    SP_ODONTOGRAM_UPDATE : 'CALL SP_odontogram_Update(:_id_odontogram,:_id_person,:_id_tooth,:_symbol,:_observation,:_json,:_id_user)',
    /**Guarda configuración de un diente */
    SP_ODONTOGRAM_SAVE : 'CALL SP_odontogram_Save(:_id_person,:_id_tooth,:_symbol,:_observation,:_json,:_id_user)',
    /**Guarda la configuración de datos de firma y consentimiento del Dr */
    SP_SIGNATURE_CONSENT_SAVE : ' CALL SP_signature_consent_Save(:_key_signature,:_url_signature,:_consent,:_state,:_name,:_id_login,:_id_business);',
    /**Actualiza la configuración de datos de firma y consentimiento del Dr */
    SP_SIGNATURE_CONSENT_UPDATE : ' CALL SP_signature_consent_Update(:_id_signature_consent,:_key_signature,:_url_signature,:_consent,:_state,:_name,:_id_login,:_id_business);',
    /**Obtiene la configuración de datos de firma y consentimiento del Dr */
    SP_SIGNATURE_CONSENT_GET : 'CALL SP_signature_consent_get(:_id_business);',
    SP_LOGIN_IMAGE_CONFIGURATION_SAVE : 'CALL SP_login_image_configuration_save(:_image_data,:_mime_type,:_original_name,:_id_login,:_id_business);',
    SP_LOGIN_IMAGE_CONFIGURATION_GET : 'CALL SP_login_image_configuration_get(:_id_business);',
    SP_UI_THEME_LIST : 'CALL SP_ui_theme_list();',
    SP_UI_THEME_GET : 'CALL SP_ui_theme_get(:_id_business);',
    SP_UI_THEME_SAVE : 'CALL SP_ui_theme_save(:_code,:_id_login,:_id_business);',
    SP_CLINICAL_MODULE_CONFIG_GET : 'CALL SP_clinical_module_config_get(:_id_business);',
    SP_CLINICAL_MODULE_CONFIG_SAVE : 'CALL SP_clinical_module_config_save(:_config,:_id_login,:_id_business);',
    SP_APPOINTMENT_CONFIG_GET : 'CALL SP_appointment_config_get(:_id_business);',
    SP_APPOINTMENT_CONFIG_SAVE : 'CALL SP_appointment_config_save(:_config,:_id_login,:_id_business);',
    SP_APPOINTMENT_SAVE : 'CALL SP_appointment_save(:_appointment,:_id_login,:_id_business);',
    SP_APPOINTMENT_LIST : 'CALL SP_appointment_list(:_date_from,:_date_to,:_id_person,:_id_business);',
    SP_APPOINTMENT_DELETE : 'CALL SP_appointment_delete(:_id_appointment,:_id_login,:_id_business);',
    /**Obtiene la configuración de los tipos de odontograma */
    SP_CAT_TYPE_TOOTH_GET : 'CALL SP_Cat_Type_Tooth_Get();',
    /**Obtiene el tratamiento por diente de un px */
    SP_DIAGNOSIS_GET : 'CALL SP_diagnosis_Get(:_id_person);',
    /**Registra el tratamiento por diente de un px */
    SP_DIAGNOSIS_UPDATE : 'CALL SP_diagnosis_Update(:_id_diagnosis,:_id_odontogram,:_id_person,:_treatment,:_amount,:_id_login);',
    /**Obtiene el catalogo de unidades */
    SP_CAT_UNIT_GET : 'CALL SP_cat_unit();',
    /**Realiza la validación de un odontograma */
    SP_ODONTOGRAM_VALIDATE_V1 : 'CALL SP_OdontogramV1_Validate(:_id_person);',
    /**Realiza el registro de un odontograma */
    SP_ODONTOGRAM_SAVE_V1 : 'CALL SP_OdontogramV1_Save(:_id_person, :_type, :_expand, :_id_login);',
    /**Realiza la obtención de un odontograma */
    SP_ODONTOGRAM_GET_V1 : 'CALL SP_OdontogramV1_Get(:_id_person);',
    /**Realiza la obtención de un odontograma */
    SP_ODONTOGRAMDETAIL_SAVE_V1 : 'CALL SP_OdontogramDetailv1_Save(:_id_odontogram_detailv1, :_id_person, :_id_tooth, :_treatment, :_id_login);',
    /**Realiza la obtención deL historial del odontograma */
    SP_ODONTOGRAM_HISTORY_V1 : 'CALL Sp_OdontogramV1_History(:_id_person);',
    /**Realiza el cambio de staus de un odontograma */
    SP_ODONTOGRAM_CHANGE_STATUS_V1 : 'CALL Sp_OdontogramV1_Change_Status(:_id_odontogramv1, :_active, :_id_user);',
    /**Realiza la eliminacion logica de un odontograma */
    SP_ODONTOGRAM_DELETE_V1 : 'CALL Sp_OdontogramV1_delete(:_id_odontogramv1, :_id_user);',
}

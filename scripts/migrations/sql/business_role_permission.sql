CREATE TABLE IF NOT EXISTS `business_role_permission` (
  `id_business` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `id_rol` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `id_cat_permission` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `active` tinyint(1) NOT NULL,
  `updated_by` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id_business`, `id_rol`, `id_cat_permission`),
  KEY `ix_business_role_permission_role` (`id_rol`),
  KEY `ix_business_role_permission_permission` (`id_cat_permission`),
  CONSTRAINT `fk_business_role_permission_business` FOREIGN KEY (`id_business`) REFERENCES `business` (`id_business`),
  CONSTRAINT `fk_business_role_permission_role` FOREIGN KEY (`id_rol`) REFERENCES `rol` (`id_rol`),
  CONSTRAINT `fk_business_role_permission_permission` FOREIGN KEY (`id_cat_permission`) REFERENCES `cat_permission` (`id_cat_permission`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Xihang complete schema, exported from SHOW CREATE TABLE.
-- Contains example navigation only. Local admin/settings are initialized on backend startup.
-- Import into a NEW local database; CREATE IF NOT EXISTS is not an upgrade migration.
SET NAMES utf8mb4;
CREATE DATABASE IF NOT EXISTS `tidesail` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE `tidesail`;

CREATE TABLE IF NOT EXISTS `users` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `username` varchar(120) COLLATE utf8mb4_unicode_ci NOT NULL,
  `password_hash` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `nick` varchar(160) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `unionid` varchar(128) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `openid` varchar(128) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `dingtalk_userid` varchar(128) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `dingtalk_corp_id` varchar(128) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `role` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'member',
  `status` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'active',
  `must_change_password` tinyint(1) NOT NULL DEFAULT '0',
  `password_changed_at` datetime DEFAULT NULL,
  `last_login_at` datetime DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_users_username` (`username`),
  UNIQUE KEY `uk_users_unionid` (`unionid`),
  UNIQUE KEY `uk_users_dingtalk_userid` (`dingtalk_corp_id`,`dingtalk_userid`),
  KEY `idx_users_role` (`role`),
  KEY `idx_users_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `nav_groups` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `name` varchar(120) COLLATE utf8mb4_unicode_ci NOT NULL,
  `description` varchar(500) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `sort_order` int NOT NULL DEFAULT '0',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_nav_groups_name` (`name`),
  KEY `idx_nav_groups_sort` (`sort_order`,`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `nav_sites` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `group_id` bigint unsigned NOT NULL,
  `name` varchar(160) COLLATE utf8mb4_unicode_ci NOT NULL,
  `url` varchar(1000) COLLATE utf8mb4_unicode_ci NOT NULL,
  `icon_url` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT '',
  `description` varchar(500) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `tags` text COLLATE utf8mb4_unicode_ci,
  `visibility` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'all',
  `allowed_roles` text COLLATE utf8mb4_unicode_ci,
  `allowed_user_ids` text COLLATE utf8mb4_unicode_ci,
  `sort_order` int NOT NULL DEFAULT '0',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_nav_sites_group_name` (`group_id`,`name`),
  KEY `idx_nav_sites_group_sort` (`group_id`,`sort_order`),
  KEY `idx_nav_sites_visibility` (`visibility`),
  CONSTRAINT `fk_nav_sites_group` FOREIGN KEY (`group_id`) REFERENCES `nav_groups` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `sso_tickets` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `ticket` char(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `target_url` varchar(1000) COLLATE utf8mb4_unicode_ci NOT NULL,
  `user_nick` varchar(160) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `unionid` varchar(128) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `openid` varchar(128) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `expires_at` datetime NOT NULL,
  `consumed_at` datetime DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_sso_tickets_ticket` (`ticket`),
  KEY `idx_sso_tickets_expires` (`expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `personal_credentials` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `user_id` bigint unsigned NOT NULL,
  `title` varchar(180) COLLATE utf8mb4_unicode_ci NOT NULL,
  `login_username` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `password_cipher` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `password_iv` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `password_tag` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `category` varchar(120) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '默认',
  `tags` text COLLATE utf8mb4_unicode_ci,
  `is_favorite` tinyint(1) NOT NULL DEFAULT '0',
  `url` varchar(1000) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `notes` text COLLATE utf8mb4_unicode_ci,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_personal_credentials_user_favorite` (`user_id`,`is_favorite`,`updated_at`),
  KEY `idx_personal_credentials_user_updated` (`user_id`,`updated_at`),
  CONSTRAINT `fk_personal_credentials_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `system_settings` (
  `setting_key` varchar(80) COLLATE utf8mb4_unicode_ci NOT NULL,
  `setting_value` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `description` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `updated_by` bigint unsigned DEFAULT NULL,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`setting_key`),
  KEY `idx_system_settings_updated_by` (`updated_by`),
  CONSTRAINT `fk_system_settings_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `admin_audit_logs` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `actor_user_id` bigint unsigned DEFAULT NULL,
  `actor_name` varchar(160) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `action` varchar(80) COLLATE utf8mb4_unicode_ci NOT NULL,
  `target_type` varchar(80) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `target_id` varchar(120) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `summary` varchar(600) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `ip` varchar(80) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `user_agent` varchar(500) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_admin_audit_logs_created` (`created_at`),
  KEY `idx_admin_audit_logs_actor` (`actor_user_id`),
  KEY `idx_admin_audit_logs_action` (`action`),
  CONSTRAINT `fk_admin_audit_logs_actor` FOREIGN KEY (`actor_user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `user_preferences` (
  `user_id` bigint unsigned NOT NULL,
  `workspace_theme` text COLLATE utf8mb4_unicode_ci,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`user_id`),
  CONSTRAINT `fk_user_preferences_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `app_sessions` (
  `sid` varchar(128) COLLATE utf8mb4_unicode_ci NOT NULL,
  `session_data` mediumtext COLLATE utf8mb4_unicode_ci NOT NULL,
  `expires_at` datetime NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`sid`),
  KEY `idx_app_sessions_expires` (`expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `cost_entries` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `cost_date` date NOT NULL,
  `project` varchar(160) COLLATE utf8mb4_unicode_ci NOT NULL,
  `category` varchar(120) COLLATE utf8mb4_unicode_ci NOT NULL,
  `description` varchar(1000) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `amount_cents` bigint unsigned NOT NULL,
  `payment_status` varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL,
  `handler` varchar(160) COLLATE utf8mb4_unicode_ci NOT NULL,
  `notes` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `created_by` bigint unsigned NOT NULL,
  `created_by_name` varchar(160) COLLATE utf8mb4_unicode_ci NOT NULL,
  `updated_by` bigint unsigned NOT NULL,
  `updated_by_name` varchar(160) COLLATE utf8mb4_unicode_ci NOT NULL,
  `version` int unsigned NOT NULL DEFAULT '1',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_cost_date` (`cost_date`),
  KEY `idx_cost_project` (`project`),
  KEY `idx_cost_status` (`payment_status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `cost_attachments` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `entry_id` bigint unsigned NOT NULL,
  `filename` varchar(160) COLLATE utf8mb4_unicode_ci NOT NULL,
  `mime` varchar(80) COLLATE utf8mb4_unicode_ci NOT NULL,
  `content` mediumblob NOT NULL,
  `uploaded_by` bigint unsigned NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_cost_attachment_entry` (`entry_id`),
  CONSTRAINT `fk_cost_attachment_entry` FOREIGN KEY (`entry_id`) REFERENCES `cost_entries` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Add example navigation only when there are no groups; preserve existing records.
SET @seed_nav = (SELECT COUNT(*) = 0 FROM nav_groups);
INSERT INTO nav_groups (name, description, sort_order) SELECT '产品与业务', '产品定位、业务后台、需求与文档入口。', 0 WHERE @seed_nav = 1;
SET @seed_group = LAST_INSERT_ID();
INSERT INTO nav_sites (group_id,name,url,description,tags,sort_order) SELECT @seed_group,'产品定位文档','https://example.com/product-positioning','沉淀目标用户、核心价值、差异化定位。','[\"产品\",\"定位\"]',0 WHERE @seed_nav = 1;
INSERT INTO nav_sites (group_id,name,url,description,tags,sort_order) SELECT @seed_group,'需求池','https://example.com/requirements','需求收集、优先级评估和版本排期。','[\"需求\",\"协作\"]',1 WHERE @seed_nav = 1;
INSERT INTO nav_sites (group_id,name,url,description,tags,sort_order) SELECT @seed_group,'运营后台','https://example.com/admin','日常运营、用户查询和业务配置。','[\"后台\"]',2 WHERE @seed_nav = 1;
INSERT INTO nav_groups (name, description, sort_order) SELECT '研发与交付', '代码、发布、监控和接口文档。', 1 WHERE @seed_nav = 1;
SET @seed_group = LAST_INSERT_ID();
INSERT INTO nav_sites (group_id,name,url,description,tags,sort_order) SELECT @seed_group,'代码仓库','https://example.com/repo','团队代码仓库与合并请求。','[\"研发\",\"代码\"]',0 WHERE @seed_nav = 1;
INSERT INTO nav_sites (group_id,name,url,description,tags,sort_order) SELECT @seed_group,'接口文档','https://example.com/api-docs','服务接口、字段说明和联调信息。','[\"API\"]',1 WHERE @seed_nav = 1;
INSERT INTO nav_sites (group_id,name,url,description,tags,sort_order) SELECT @seed_group,'监控告警','https://example.com/monitoring','线上服务状态、日志和告警处理。','[\"稳定性\"]',2 WHERE @seed_nav = 1;

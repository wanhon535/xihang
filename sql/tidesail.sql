-- TideSail / 汐航 MySQL schema and seed data
-- Compatible with MySQL 5.7+ / 8.0+

CREATE DATABASE IF NOT EXISTS `tidesail`
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_unicode_ci;

USE `tidesail`;

CREATE TABLE IF NOT EXISTS `users` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `username` VARCHAR(120) NOT NULL,
  `password_hash` VARCHAR(255) NOT NULL,
  `nick` VARCHAR(160) NOT NULL DEFAULT '',
  `unionid` VARCHAR(128) NULL,
  `openid` VARCHAR(128) NULL,
  `role` VARCHAR(32) NOT NULL DEFAULT 'member',
  `last_login_at` DATETIME NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_users_username` (`username`),
  UNIQUE KEY `uk_users_unionid` (`unionid`),
  KEY `idx_users_role` (`role`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `nav_groups` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(120) NOT NULL,
  `description` VARCHAR(500) NOT NULL DEFAULT '',
  `sort_order` INT NOT NULL DEFAULT 0,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_nav_groups_sort` (`sort_order`, `id`),
  UNIQUE KEY `uk_nav_groups_name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `nav_sites` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `group_id` BIGINT UNSIGNED NOT NULL,
  `name` VARCHAR(160) NOT NULL,
  `url` VARCHAR(1000) NOT NULL,
  `description` VARCHAR(500) NOT NULL DEFAULT '',
  `tags` TEXT NULL,
  `sort_order` INT NOT NULL DEFAULT 0,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_nav_sites_group_sort` (`group_id`, `sort_order`),
  UNIQUE KEY `uk_nav_sites_group_name` (`group_id`, `name`),
  CONSTRAINT `fk_nav_sites_group` FOREIGN KEY (`group_id`) REFERENCES `nav_groups` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `sso_tickets` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `ticket` CHAR(64) NOT NULL,
  `target_url` VARCHAR(1000) NOT NULL,
  `user_nick` VARCHAR(160) NOT NULL DEFAULT '',
  `unionid` VARCHAR(128) NOT NULL DEFAULT '',
  `openid` VARCHAR(128) NOT NULL DEFAULT '',
  `expires_at` DATETIME NOT NULL,
  `consumed_at` DATETIME NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_sso_tickets_ticket` (`ticket`),
  KEY `idx_sso_tickets_expires` (`expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Reset only the built-in demo groups before inserting seed data.
-- This keeps the script idempotent even when existing tables were created before unique keys were added.
DELETE FROM `nav_groups`
WHERE `name` IN ('产品与业务', '研发与交付');

INSERT INTO `nav_groups` (`name`, `description`, `sort_order`)
VALUES
  ('产品与业务', '产品定位、业务后台、需求与文档入口。', 0),
  ('研发与交付', '代码、发布、监控和接口文档。', 1);

INSERT INTO `nav_sites` (`group_id`, `name`, `url`, `description`, `tags`, `sort_order`)
SELECT `id`, '产品定位文档', 'https://example.com/product-positioning', '沉淀目标用户、核心价值、差异化定位。', '["产品","定位"]', 0
FROM `nav_groups`
WHERE `name` = '产品与业务';

INSERT INTO `nav_sites` (`group_id`, `name`, `url`, `description`, `tags`, `sort_order`)
SELECT `id`, '需求池', 'https://example.com/requirements', '需求收集、优先级评估和版本排期。', '["需求","协作"]', 1
FROM `nav_groups`
WHERE `name` = '产品与业务';

INSERT INTO `nav_sites` (`group_id`, `name`, `url`, `description`, `tags`, `sort_order`)
SELECT `id`, '运营后台', 'https://example.com/admin', '日常运营、用户查询和业务配置。', '["后台"]', 2
FROM `nav_groups`
WHERE `name` = '产品与业务';

INSERT INTO `nav_sites` (`group_id`, `name`, `url`, `description`, `tags`, `sort_order`)
SELECT `id`, '代码仓库', 'https://example.com/repo', '团队代码仓库与合并请求。', '["研发","代码"]', 0
FROM `nav_groups`
WHERE `name` = '研发与交付';

INSERT INTO `nav_sites` (`group_id`, `name`, `url`, `description`, `tags`, `sort_order`)
SELECT `id`, '接口文档', 'https://example.com/api-docs', '服务接口、字段说明和联调信息。', '["API"]', 1
FROM `nav_groups`
WHERE `name` = '研发与交付';

INSERT INTO `nav_sites` (`group_id`, `name`, `url`, `description`, `tags`, `sort_order`)
SELECT `id`, '监控告警', 'https://example.com/monitoring', '线上服务状态、日志和告警处理。', '["稳定性"]', 2
FROM `nav_groups`
WHERE `name` = '研发与交付';

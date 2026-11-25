SELECT @@log_bin AS log_bin, @@log_bin_trust_function_creators AS trust,
       (EXISTS (SELECT 1 FROM information_schema.USER_PRIVILEGES
                WHERE GRANTEE = account.grantee AND PRIVILEGE_TYPE = 'TRIGGER')
        OR EXISTS (SELECT 1 FROM information_schema.SCHEMA_PRIVILEGES
                   WHERE GRANTEE = account.grantee AND PRIVILEGE_TYPE = 'TRIGGER'
                     AND BINARY DATABASE() LIKE BINARY TABLE_SCHEMA)) AS can_trigger,
       EXISTS (SELECT 1 FROM information_schema.USER_PRIVILEGES
               WHERE GRANTEE = account.grantee AND PRIVILEGE_TYPE = 'SUPER') AS has_super,
       (EXISTS (SELECT 1 FROM information_schema.TRIGGERS
                WHERE TRIGGER_SCHEMA = DATABASE() AND BINARY DEFINER <> BINARY CURRENT_USER())
        OR EXISTS (SELECT 1 FROM information_schema.VIEWS
                   WHERE TABLE_SCHEMA = DATABASE() AND BINARY DEFINER <> BINARY CURRENT_USER())) AS foreign_definers
FROM (SELECT CONCAT(QUOTE(LEFT(CURRENT_USER(),
                                CHAR_LENGTH(CURRENT_USER()) - CHAR_LENGTH(host) - 1)),
                    '@', QUOTE(host)) AS grantee
      FROM (SELECT SUBSTRING_INDEX(CURRENT_USER(), '@', -1) AS host) AS login) AS account;

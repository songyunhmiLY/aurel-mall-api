-- The pre-seeded root invite code is 000000. Older databases stored ROOT.
UPDATE `users`
SET `invite_code` = '000000'
WHERE `invite_code` = 'ROOT';

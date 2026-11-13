-- 官方职位名：高级经理、营销总监。纠正已经写入的旧显示名。
UPDATE `positions` SET `name` = '高级经理' WHERE `code` = 'senior_manager' AND `name` <> '高级经理';
UPDATE `positions` SET `name` = '营销总监' WHERE `code` = 'director' AND `name` <> '营销总监';

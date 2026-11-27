-- What the inbox calls the fact an extraction rule writes (its `field`): "Site" for `site`,
-- "Support case" for `case`. It is part of the rule, as its field is, so a team's own facts are
-- named where they are defined, not in the inbox's code (src/extract.js `factLabels`). Several
-- rules of one field may each have one: the inbox shows the first of the team's, else the admin
-- team's, else another team's, in the order they run; a field none labels shows as it is named.
-- Clairic's fields come from no rule: their names are next to its fields (src/label.js).
ALTER TABLE extraction_rules ADD COLUMN label TEXT;

-- The admin team's rules of migration 0043, and of rules added since, by what the inbox called
-- their fields until now. A rule a person already labeled keeps its label.
UPDATE extraction_rules SET label = CASE field
    WHEN 'url' THEN 'URL'
    WHEN 'cve' THEN 'CVE'
    WHEN 'ticket' THEN 'Ticket'
    WHEN 'site' THEN 'Site'
    WHEN 'repo' THEN 'Repository'
    WHEN 'admin_api' THEN 'Admin API'
    WHEN 'aemcs_env' THEN 'AEM environment'
    WHEN 'doc' THEN 'Docs'
    WHEN 'tool' THEN 'Tool'
    WHEN 'config_file' THEN 'Config file'
    WHEN 'http_status' THEN 'Status'
    WHEN 'header' THEN 'Header'
    WHEN 'case' THEN 'Support case'
    WHEN 'figma_file' THEN 'Figma file'
  END
  WHERE team = 'admin' AND target = 'fact' AND label IS NULL
    AND field IN ('url', 'cve', 'ticket', 'site', 'repo', 'admin_api', 'aemcs_env', 'doc', 'tool',
      'config_file', 'http_status', 'header', 'case', 'figma_file');

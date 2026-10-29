-- Extraction rules and the tech stack, as configuration of the ops teams (src/extract.js).
-- The admin team's apply to every channel; any other team's to the channels it owns, on top.

-- Regular expressions (or scripts) that find facts in a thread's messages, or detect a
-- technology. Run in `position` order, the admin team's first.
CREATE TABLE extraction_rules (
  id INTEGER PRIMARY KEY,
  team TEXT NOT NULL,                 -- ops team slug; 'admin': every channel
  name TEXT NOT NULL,                 -- what it finds, for people
  kind TEXT NOT NULL DEFAULT 'regex', -- regex | script
  target TEXT NOT NULL DEFAULT 'fact', -- fact (writes `field`) | tech (detects technology `field`)
  field TEXT,                         -- the fact's field (site, ticket, …) or the technology's id
  pattern TEXT NOT NULL DEFAULT '',   -- JavaScript regular expression, always global
  flags TEXT NOT NULL DEFAULT '',     -- i, m, s, u
  value TEXT NOT NULL DEFAULT '',     -- template: $0 the match, $1… its groups; $0 when empty
  transform TEXT,                     -- lower | upper
  exclude TEXT NOT NULL DEFAULT '',   -- values this matches are dropped
  script TEXT NOT NULL DEFAULT '',    -- kind script: an ES module (see src/extract.js)
  position INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  changed_by TEXT,
  changed_at TEXT
);
CREATE INDEX extraction_rules_team ON extraction_rules (team, position);

-- The technologies Clef asks about ("Does this thread show that the customer uses
-- <description>?"). A team's row with the admin team's id replaces it in the team's channels.
CREATE TABLE tech_stack (
  id INTEGER PRIMARY KEY,
  team TEXT NOT NULL,
  tech TEXT NOT NULL,                 -- id, as channel_tech.tech
  name TEXT NOT NULL,                 -- what the inbox shows
  description TEXT NOT NULL,          -- what Clef is asked about
  enabled INTEGER NOT NULL DEFAULT 1,
  changed_by TEXT,
  changed_at TEXT,
  UNIQUE (team, tech)
);

-- What src/facts.js and src/label.js had in code, and what the data asked for since: sites in
-- da.live, admin API and aem.network links, AEM Cloud Service environments, documentation pages,
-- tools, configuration files, status codes, headers, support cases; chat links and attachments
-- are not URLs worth a fact; hosts and error pages that show a technology.
INSERT INTO extraction_rules (team, name, kind, target, field, pattern, flags, value, transform, exclude, position, changed_by, changed_at) VALUES ('admin', 'CVE ids', 'regex', 'fact', 'cve', '\bCVE-\d{4}-\d{4,7}\b', 'i', '', 'upper', '', 10, 'migration 0043', '2026-10-30T00:00:00Z');
INSERT INTO extraction_rules (team, name, kind, target, field, pattern, flags, value, transform, exclude, position, changed_by, changed_at) VALUES ('admin', 'Ticket in a link to a tracker', 'regex', 'fact', 'ticket', '/(?:browse|issues?|tickets?)/([A-Z][A-Z0-9]{1,9}-\d{1,7})\b', '', '$1', NULL, '', 20, 'migration 0043', '2026-10-30T00:00:00Z');
INSERT INTO extraction_rules (team, name, kind, target, field, pattern, flags, value, transform, exclude, position, changed_by, changed_at) VALUES ('admin', 'Ticket the text calls one', 'regex', 'fact', 'ticket', '\b(?:ticket|jira|issue|case)\s*#?:?\s*([A-Z][A-Z0-9]{1,9}-\d{1,7})\b', 'i', '$1', 'upper', '', 30, 'migration 0043', '2026-10-30T00:00:00Z');
INSERT INTO extraction_rules (team, name, kind, target, field, pattern, flags, value, transform, exclude, position, changed_by, changed_at) VALUES ('admin', 'Edge Delivery site in a hostname', 'regex', 'fact', 'site', '\b(?:(?:[a-z0-9]|-(?!-))+--)?((?:[a-z0-9]|-(?!-))+)--((?:[a-z0-9]|-(?!-))+)\.(?:aem\.(?:page|live|network|reviews)|hlx\.(?:page|live))\b', 'i', '$2/$1', 'lower', '', 40, 'migration 0043', '2026-10-30T00:00:00Z');
INSERT INTO extraction_rules (team, name, kind, target, field, pattern, flags, value, transform, exclude, position, changed_by, changed_at) VALUES ('admin', 'Document Authoring site in a da.live path', 'regex', 'fact', 'site', '\bda\.live/(?:(?:edit|sheet|canvas|config|app|source|media|list)#?|#)/([a-z0-9-]+)/([a-z0-9-]+)', 'i', '$1/$2', 'lower', '', 50, 'migration 0043', '2026-10-30T00:00:00Z');
INSERT INTO extraction_rules (team, name, kind, target, field, pattern, flags, value, transform, exclude, position, changed_by, changed_at) VALUES ('admin', 'Edge Delivery site in an admin API path', 'regex', 'fact', 'site', '\badmin\.(?:hlx|aem)\.page/(?:preview|live|code|status|index|sitemap|snapshot|job|log|cache|form|discover)/([a-z0-9-]+)/([a-z0-9-]+)', 'i', '$1/$2', 'lower', '', 60, 'migration 0043', '2026-10-30T00:00:00Z');
INSERT INTO extraction_rules (team, name, kind, target, field, pattern, flags, value, transform, exclude, position, changed_by, changed_at) VALUES ('admin', 'Edge Delivery site in an admin API config path', 'regex', 'fact', 'site', '\badmin\.(?:hlx|aem)\.page/config/([a-z0-9-]+)/sites/([a-z0-9-]+)', 'i', '$1/$2', 'lower', '', 70, 'migration 0043', '2026-10-30T00:00:00Z');
INSERT INTO extraction_rules (team, name, kind, target, field, pattern, flags, value, transform, exclude, position, changed_by, changed_at) VALUES ('admin', 'Edge Delivery admin API operation', 'regex', 'fact', 'admin_api', '\badmin\.(?:hlx|aem)\.page/([a-z]+)/', 'i', '$1', 'lower', '', 80, 'migration 0043', '2026-10-30T00:00:00Z');
INSERT INTO extraction_rules (team, name, kind, target, field, pattern, flags, value, transform, exclude, position, changed_by, changed_at) VALUES ('admin', 'AEM Cloud Service program and environment', 'regex', 'fact', 'aemcs_env', '\b(?:author|publish|preview|delivery)-p(\d+)-e(\d+)\b', 'i', 'p$1-e$2', NULL, '', 90, 'migration 0043', '2026-10-30T00:00:00Z');
INSERT INTO extraction_rules (team, name, kind, target, field, pattern, flags, value, transform, exclude, position, changed_by, changed_at) VALUES ('admin', 'GitHub repository', 'regex', 'fact', 'repo', '\bgithub\.com/([A-Za-z0-9-]+)/([A-Za-z0-9_-]+(?:\.(?!git(?![A-Za-z0-9_-]))[A-Za-z0-9_-]+)*)', '', '$1/$2', 'lower', '^(?:orgs|settings|features|marketplace|login|apps|sponsors)/', 100, 'migration 0043', '2026-10-30T00:00:00Z');
INSERT INTO extraction_rules (team, name, kind, target, field, pattern, flags, value, transform, exclude, position, changed_by, changed_at) VALUES ('admin', 'Edge Delivery documentation page', 'regex', 'fact', 'doc', '\b(?:www\.)?aem\.live/((?:docs|developer)/[a-z0-9-]+(?:/[a-z0-9-]+)*)', 'i', '$1', 'lower', '', 110, 'migration 0043', '2026-10-30T00:00:00Z');
INSERT INTO extraction_rules (team, name, kind, target, field, pattern, flags, value, transform, exclude, position, changed_by, changed_at) VALUES ('admin', 'Edge Delivery tool', 'regex', 'fact', 'tool', '\b(?:tools|labs)\.aem\.live/tools/([a-z0-9-]+)', 'i', '$1', 'lower', '', 120, 'migration 0043', '2026-10-30T00:00:00Z');
INSERT INTO extraction_rules (team, name, kind, target, field, pattern, flags, value, transform, exclude, position, changed_by, changed_at) VALUES ('admin', 'Edge Delivery or Universal Editor configuration file', 'regex', 'fact', 'config_file', '(?<![\w-])(cdn\.yaml|fstab\.yaml|helix-query\.yaml|helix-sitemap\.yaml|query-index\.json|redirects\.(?:json|xlsx)|headers\.(?:json|xlsx)|metadata\.(?:json|xlsx)|robots\.txt|sitemap\.xml|component-models\.json|component-definition\.json|component-filters\.json|paths\.json|placeholders\.json|\.hlxignore)(?![\w-])', 'i', '$1', 'lower', '', 130, 'migration 0043', '2026-10-30T00:00:00Z');
INSERT INTO extraction_rules (team, name, kind, target, field, pattern, flags, value, transform, exclude, position, changed_by, changed_at) VALUES ('admin', 'HTTP status code of a failure', 'regex', 'fact', 'http_status', '\b(?:(?:HTTP(?:/[\d.]+)?|status(?: code)?|error|returns?|returning|returned|got|getting)\W{0,3}([45]\d\d)|([45]\d\d) (?:error|forbidden|not found|unauthori[sz]ed|bad gateway|service unavailable|gateway time-?out|too many requests))\b', 'i', '$1$2', NULL, '', 140, 'migration 0043', '2026-10-30T00:00:00Z');
INSERT INTO extraction_rules (team, name, kind, target, field, pattern, flags, value, transform, exclude, position, changed_by, changed_at) VALUES ('admin', 'Response header that names a request or an error', 'regex', 'fact', 'header', '(?<![\w-])(x-error|x-request-id|cf-ray|x-cache|x-served-by|x-amz-cf-id|x-akamai-[a-z-]+|surrogate-key|x-aem-[a-z-]+)\s*[:=]\s*([^\s,;]{1,120})', 'i', '$1: $2', NULL, '', 150, 'migration 0043', '2026-10-30T00:00:00Z');
INSERT INTO extraction_rules (team, name, kind, target, field, pattern, flags, value, transform, exclude, position, changed_by, changed_at) VALUES ('admin', 'Adobe support case', 'regex', 'fact', 'case', '\bE-\d{6,8}\b', '', '', 'upper', '', 160, 'migration 0043', '2026-10-30T00:00:00Z');
INSERT INTO extraction_rules (team, name, kind, target, field, pattern, flags, value, transform, exclude, position, changed_by, changed_at) VALUES ('admin', 'URL', 'regex', 'fact', 'url', 'https?://[^\s<>()[\]"''`|]+[^\s<>()[\]"''`|.,;:!?]', '', '', NULL, '^https?://(?:files\.slack\.com/|[a-z0-9-]+(?:\.enterprise)?\.slack\.com/(?:archives|files)/|app\.slack\.com/|teams\.microsoft\.com/l/message/|graph\.microsoft\.com/v1\.0/teams/[^/]+/channels/[^/]+/messages/|cdn\.discordapp\.com/attachments/)', 170, 'migration 0043', '2026-10-30T00:00:00Z');
INSERT INTO extraction_rules (team, name, kind, target, field, pattern, flags, value, transform, exclude, position, changed_by, changed_at) VALUES ('admin', 'Edge Delivery hostname', 'regex', 'tech', 'eds', '\b(?:[a-z0-9]|-(?!-))+--(?:[a-z0-9]|-(?!-))+\.(?:aem\.(?:page|live|network|reviews)|hlx\.(?:page|live))\b', 'i', '', NULL, '', 180, 'migration 0043', '2026-10-30T00:00:00Z');
INSERT INTO extraction_rules (team, name, kind, target, field, pattern, flags, value, transform, exclude, position, changed_by, changed_at) VALUES ('admin', 'Document Authoring link', 'regex', 'tech', 'da', '\bda\.live/(?:edit|sheet|canvas|config|app|source|media|list|#)', 'i', '', NULL, '', 190, 'migration 0043', '2026-10-30T00:00:00Z');
INSERT INTO extraction_rules (team, name, kind, target, field, pattern, flags, value, transform, exclude, position, changed_by, changed_at) VALUES ('admin', 'AEM Cloud Service author or publish host', 'regex', 'tech', 'aemcs', '\b(?:author|publish|preview)-p\d+-e\d+\.adobeaemcloud\.(?:com|net)\b', 'i', '', NULL, '', 200, 'migration 0043', '2026-10-30T00:00:00Z');
INSERT INTO extraction_rules (team, name, kind, target, field, pattern, flags, value, transform, exclude, position, changed_by, changed_at) VALUES ('admin', 'AEM Assets delivery host', 'regex', 'tech', 'assets', '\bdelivery-p\d+-e\d+\.adobeaemcloud\.(?:com|net)\b', 'i', '', NULL, '', 210, 'migration 0043', '2026-10-30T00:00:00Z');
INSERT INTO extraction_rules (team, name, kind, target, field, pattern, flags, value, transform, exclude, position, changed_by, changed_at) VALUES ('admin', 'App Builder or I/O Runtime host', 'regex', 'tech', 'appbuilder', '\b[a-z0-9-]+\.(?:adobeioruntime\.net|adobeio-static\.net)\b', 'i', '', NULL, '', 220, 'migration 0043', '2026-10-30T00:00:00Z');
INSERT INTO extraction_rules (team, name, kind, target, field, pattern, flags, value, transform, exclude, position, changed_by, changed_at) VALUES ('admin', 'Akamai error reference', 'regex', 'tech', 'akamai', '\bReference\s?#\d+\.[0-9a-f]+\.\d+\.[0-9a-f]+\b', 'i', '', NULL, '', 230, 'migration 0043', '2026-10-30T00:00:00Z');
INSERT INTO extraction_rules (team, name, kind, target, field, pattern, flags, value, transform, exclude, position, changed_by, changed_at) VALUES ('admin', 'Cloudflare ray id', 'regex', 'tech', 'cloudflare', '(?<![\w-])cf-ray\s*[:=]\s*[0-9a-f]{12,}', 'i', '', NULL, '', 240, 'migration 0043', '2026-10-30T00:00:00Z');
INSERT INTO extraction_rules (team, name, kind, target, field, pattern, flags, value, transform, exclude, position, changed_by, changed_at) VALUES ('admin', 'Fastly cache header', 'regex', 'tech', 'fastly', '(?<![\w-])x-served-by\s*[:=]\s*cache-[a-z0-9-]+', 'i', '', NULL, '', 250, 'migration 0043', '2026-10-30T00:00:00Z');
INSERT INTO extraction_rules (team, name, kind, target, field, pattern, flags, value, transform, exclude, position, changed_by, changed_at) VALUES ('admin', 'CloudFront request id or host', 'regex', 'tech', 'cloudfront', '(?<![\w-])x-amz-cf-(?:id|pop)\s*[:=]|\b[a-z0-9]+\.cloudfront\.net\b', 'i', '', NULL, '', 260, 'migration 0043', '2026-10-30T00:00:00Z');
INSERT INTO extraction_rules (team, name, kind, target, field, pattern, flags, value, transform, exclude, position, changed_by, changed_at) VALUES ('admin', 'Other git host', 'regex', 'tech', 'bitbucket', '\b(?:dev\.azure\.com|bitbucket\.org|gitlab\.com|git\.cloudmanager\.adobe\.com|cm-repo\.adobe\.io)\b', 'i', '', NULL, '', 270, 'migration 0043', '2026-10-30T00:00:00Z');

-- The technologies src/label.js asked about, and those the data asked for since.
INSERT INTO tech_stack (team, tech, name, description, changed_by, changed_at) VALUES ('admin', 'eds', 'Edge Delivery', 'Adobe Edge Delivery Services (aem.live, aem.page, helix, Franklin)', 'migration 0043', '2026-10-30T00:00:00Z');
INSERT INTO tech_stack (team, tech, name, description, changed_by, changed_at) VALUES ('admin', 'da', 'Document Authoring', 'Document Authoring (da.live)', 'migration 0043', '2026-10-30T00:00:00Z');
INSERT INTO tech_stack (team, tech, name, description, changed_by, changed_at) VALUES ('admin', 'ue', 'Universal Editor', 'Universal Editor', 'migration 0043', '2026-10-30T00:00:00Z');
INSERT INTO tech_stack (team, tech, name, description, changed_by, changed_at) VALUES ('admin', 'sharepoint', 'SharePoint', 'SharePoint or OneDrive as the content source', 'migration 0043', '2026-10-30T00:00:00Z');
INSERT INTO tech_stack (team, tech, name, description, changed_by, changed_at) VALUES ('admin', 'gdrive', 'Google Drive', 'Google Drive or Google Docs as the content source', 'migration 0043', '2026-10-30T00:00:00Z');
INSERT INTO tech_stack (team, tech, name, description, changed_by, changed_at) VALUES ('admin', 'aemcs', 'AEM Cloud Service', 'AEM as a Cloud Service (author or publish tier, Cloud Manager)', 'migration 0043', '2026-10-30T00:00:00Z');
INSERT INTO tech_stack (team, tech, name, description, changed_by, changed_at) VALUES ('admin', 'assets', 'Assets', 'AEM Assets or Dynamic Media', 'migration 0043', '2026-10-30T00:00:00Z');
INSERT INTO tech_stack (team, tech, name, description, changed_by, changed_at) VALUES ('admin', 'forms', 'Forms', 'AEM Forms', 'migration 0043', '2026-10-30T00:00:00Z');
INSERT INTO tech_stack (team, tech, name, description, changed_by, changed_at) VALUES ('admin', 'commerce', 'Commerce', 'Adobe Commerce (Magento) or Commerce drop-ins', 'migration 0043', '2026-10-30T00:00:00Z');
INSERT INTO tech_stack (team, tech, name, description, changed_by, changed_at) VALUES ('admin', 'cloudflare', 'Cloudflare', 'Cloudflare as CDN', 'migration 0043', '2026-10-30T00:00:00Z');
INSERT INTO tech_stack (team, tech, name, description, changed_by, changed_at) VALUES ('admin', 'akamai', 'Akamai', 'Akamai as CDN', 'migration 0043', '2026-10-30T00:00:00Z');
INSERT INTO tech_stack (team, tech, name, description, changed_by, changed_at) VALUES ('admin', 'fastly', 'Fastly', 'Fastly as CDN', 'migration 0043', '2026-10-30T00:00:00Z');
INSERT INTO tech_stack (team, tech, name, description, changed_by, changed_at) VALUES ('admin', 'cloudfront', 'CloudFront', 'Amazon CloudFront as CDN', 'migration 0043', '2026-10-30T00:00:00Z');
INSERT INTO tech_stack (team, tech, name, description, changed_by, changed_at) VALUES ('admin', 'github', 'GitHub', 'GitHub for code', 'migration 0043', '2026-10-30T00:00:00Z');
INSERT INTO tech_stack (team, tech, name, description, changed_by, changed_at) VALUES ('admin', 'bitbucket', 'Other git', 'Bitbucket, GitLab, Azure DevOps or Cloud Manager git for code', 'migration 0043', '2026-10-30T00:00:00Z');
INSERT INTO tech_stack (team, tech, name, description, changed_by, changed_at) VALUES ('admin', 'target', 'Target', 'Adobe Target or personalization', 'migration 0043', '2026-10-30T00:00:00Z');
INSERT INTO tech_stack (team, tech, name, description, changed_by, changed_at) VALUES ('admin', 'analytics', 'Analytics', 'Adobe Analytics, Web SDK or Experience Platform data collection', 'migration 0043', '2026-10-30T00:00:00Z');
INSERT INTO tech_stack (team, tech, name, description, changed_by, changed_at) VALUES ('admin', 'xw', 'Experience Workspace', 'Experience Workspace or the Experience Modernization Agent', 'migration 0043', '2026-10-30T00:00:00Z');
INSERT INTO tech_stack (team, tech, name, description, changed_by, changed_at) VALUES ('admin', 'sso', 'Single sign-on', 'single sign-on through its own identity provider (Okta, Microsoft Entra ID, or another SAML or OpenID Connect provider)', 'migration 0043', '2026-10-30T00:00:00Z');
INSERT INTO tech_stack (team, tech, name, description, changed_by, changed_at) VALUES ('admin', 'llmo', 'LLM Optimizer', 'Adobe LLM Optimizer or Brand Visibility (how AI assistants and answer engines see its brand)', 'migration 0043', '2026-10-30T00:00:00Z');
INSERT INTO tech_stack (team, tech, name, description, changed_by, changed_at) VALUES ('admin', 'waf', 'WAF and bot protection', 'a web application firewall, bot protection or rate limiting in front of its site', 'migration 0043', '2026-10-30T00:00:00Z');
INSERT INTO tech_stack (team, tech, name, description, changed_by, changed_at) VALUES ('admin', 'appbuilder', 'App Builder', 'Adobe App Builder or Adobe I/O Runtime', 'migration 0043', '2026-10-30T00:00:00Z');
INSERT INTO tech_stack (team, tech, name, description, changed_by, changed_at) VALUES ('admin', 'aso', 'Sites Optimizer', 'AEM Sites Optimizer', 'migration 0043', '2026-10-30T00:00:00Z');
INSERT INTO tech_stack (team, tech, name, description, changed_by, changed_at) VALUES ('admin', 'rum', 'Operational telemetry', 'real-user monitoring or operational telemetry (RUM) to measure its site', 'migration 0043', '2026-10-30T00:00:00Z');
INSERT INTO tech_stack (team, tech, name, description, changed_by, changed_at) VALUES ('admin', 'byom', 'Bring your own markup', 'bring your own markup (BYOM), json2html or content overlays from another system', 'migration 0043', '2026-10-30T00:00:00Z');
INSERT INTO tech_stack (team, tech, name, description, changed_by, changed_at) VALUES ('admin', 'translation', 'Translation', 'a translation service or connector (such as Lilt, Smartling or GlobalLink)', 'migration 0043', '2026-10-30T00:00:00Z');
INSERT INTO tech_stack (team, tech, name, description, changed_by, changed_at) VALUES ('admin', 'productbus', 'Product Bus', 'the Product Bus for its commerce data', 'migration 0043', '2026-10-30T00:00:00Z');
INSERT INTO tech_stack (team, tech, name, description, changed_by, changed_at) VALUES ('admin', 'monitoring', 'Monitoring', 'a monitoring service such as New Relic, Datadog, Splunk or Dynatrace', 'migration 0043', '2026-10-30T00:00:00Z');
INSERT INTO tech_stack (team, tech, name, description, changed_by, changed_at) VALUES ('admin', 'consent', 'Consent manager', 'a consent manager such as OneTrust or Cookiebot', 'migration 0043', '2026-10-30T00:00:00Z');
INSERT INTO tech_stack (team, tech, name, description, changed_by, changed_at) VALUES ('admin', 'search', 'Site search', 'a site search service such as Algolia or Coveo', 'migration 0043', '2026-10-30T00:00:00Z');
INSERT INTO tech_stack (team, tech, name, description, changed_by, changed_at) VALUES ('admin', 'feeds', 'Product feeds', 'product feeds to Google Merchant Center or other marketplaces', 'migration 0043', '2026-10-30T00:00:00Z');

-- The tech stack grows by what the threads are about that it did not name (the product census:
-- Clairic's product names over every channel thread, matched against the entries; see
-- docs/ARCHITECTURE.md, "Labels and facts"): new entries for the admin team, which every channel
-- is asked about, and the names people use added to the descriptions of others. Products that
-- were Clef's topics before (commerce, assets, Sites Optimizer, the integrations, the inbox) are
-- entries here now. A description someone changed on the Agents page since migration 0043 wrote
-- it is left as it is; one that is already as below too.

INSERT OR IGNORE INTO tech_stack (team, tech, name, description, changed_by, changed_at) VALUES ('admin', 'adobeims', 'Adobe IMS and Admin Console', 'Adobe IMS organizations, Adobe IDs and Admin Console product profiles or user groups for its people''s access, or Adobe Developer Console credentials (OAuth server-to-server) for Adobe APIs', 'migration 0056', '2026-11-05T00:00:00Z');
INSERT OR IGNORE INTO tech_stack (team, tech, name, description, changed_by, changed_at) VALUES ('admin', 'aiagents', 'AI assistants and agents', 'AI assistants or agents such as ChatGPT, Claude, Microsoft Copilot, Gemini or Cursor with its site or content, for example through the AEM MCP server or an AEM connector', 'migration 0056', '2026-11-05T00:00:00Z');
INSERT OR IGNORE INTO tech_stack (team, tech, name, description, changed_by, changed_at) VALUES ('admin', 'aemcontent', 'Content Fragments and AEM APIs', 'Content Fragments, Experience Fragments or AEM''s content APIs (GraphQL, OpenAPI, the Sites or Page Management APIs)', 'migration 0056', '2026-11-05T00:00:00Z');
INSERT OR IGNORE INTO tech_stack (team, tech, name, description, changed_by, changed_at) VALUES ('admin', 'cloud', 'Own cloud services', 'its own services on AWS, Microsoft Azure or Google Cloud (storage such as S3 or Blob Storage, Lambda or Functions, API gateways) behind or next to its site', 'migration 0056', '2026-11-05T00:00:00Z');
INSERT OR IGNORE INTO tech_stack (team, tech, name, description, changed_by, changed_at) VALUES ('admin', 'aemai', 'AEM AI features', 'Adobe''s AI features for AEM: AEM Coworker (CX Coworker), Content AI or semantic search, Experience Context, Prompt Coach or Brand Concierge', 'migration 0056', '2026-11-05T00:00:00Z');
INSERT OR IGNORE INTO tech_stack (team, tech, name, description, changed_by, changed_at) VALUES ('admin', 'dm', 'Dynamic Media', 'Dynamic Media or Dynamic Media with OpenAPI to deliver and transform its images and videos (smart crops, templates, DM URLs)', 'migration 0056', '2026-11-05T00:00:00Z');
INSERT OR IGNORE INTO tech_stack (team, tech, name, description, changed_by, changed_at) VALUES ('admin', 'aco', 'Commerce Optimizer', 'Adobe Commerce Optimizer (ACO) for its catalog, prices and price books', 'migration 0056', '2026-11-05T00:00:00Z');
INSERT OR IGNORE INTO tech_stack (team, tech, name, description, changed_by, changed_at) VALUES ('admin', 'webtools', 'Google site tools', 'Google''s tools for its site: PageSpeed Insights, Lighthouse, CrUX or Search Console', 'migration 0056', '2026-11-05T00:00:00Z');
INSERT OR IGNORE INTO tech_stack (team, tech, name, description, changed_by, changed_at) VALUES ('admin', 'msm', 'MSM and language copies', 'Multi Site Manager in AEM Sites: live copies, blueprints, rollouts or language copies', 'migration 0056', '2026-11-05T00:00:00Z');
INSERT OR IGNORE INTO tech_stack (team, tech, name, description, changed_by, changed_at) VALUES ('admin', 'erp', 'ERP and PIM', 'an ERP, PIM or order management system (such as Oracle EBS, Microsoft Dynamics, NetSuite or Akeneo) for its product or order data', 'migration 0056', '2026-11-05T00:00:00Z');
INSERT OR IGNORE INTO tech_stack (team, tech, name, description, changed_by, changed_at) VALUES ('admin', 'edgefunctions', 'AEM Edge Functions', 'AEM Edge Functions to run its own code at Adobe''s CDN', 'migration 0056', '2026-11-05T00:00:00Z');
INSERT OR IGNORE INTO tech_stack (team, tech, name, description, changed_by, changed_at) VALUES ('admin', 'aem65', 'AEM 6.5 or AMS', 'AEM 6.5 on its own servers or on Adobe Managed Services (AMS), for example as the site it migrates from', 'migration 0056', '2026-11-05T00:00:00Z');
INSERT OR IGNORE INTO tech_stack (team, tech, name, description, changed_by, changed_at) VALUES ('admin', 'scriptsecurity', 'Script security', 'a client-side script security or scanning tool (such as Feroot) or a corporate security proxy (such as Microsoft Defender for Cloud Apps) on its site', 'migration 0056', '2026-11-05T00:00:00Z');
INSERT OR IGNORE INTO tech_stack (team, tech, name, description, changed_by, changed_at) VALUES ('admin', 'crm', 'CRM and marketing', 'Salesforce (CRM, Marketing Cloud or Data Cloud), Adobe Campaign, Marketo or HubSpot', 'migration 0056', '2026-11-05T00:00:00Z');
INSERT OR IGNORE INTO tech_stack (team, tech, name, description, changed_by, changed_at) VALUES ('admin', 'figma', 'Figma', 'Figma for designs that become pages (the Figma integration, Figma-to-content or Figma MCP)', 'migration 0056', '2026-11-05T00:00:00Z');
INSERT OR IGNORE INTO tech_stack (team, tech, name, description, changed_by, changed_at) VALUES ('admin', 'workfront', 'Workfront', 'Adobe Workfront for its content or asset workflows', 'migration 0056', '2026-11-05T00:00:00Z');
INSERT OR IGNORE INTO tech_stack (team, tech, name, description, changed_by, changed_at) VALUES ('admin', 'embeds', 'Video and embeds', 'a video or embedded-content service such as YouTube, Brightcove, Vev, Datawrapper or Tally', 'migration 0056', '2026-11-05T00:00:00Z');
INSERT OR IGNORE INTO tech_stack (team, tech, name, description, changed_by, changed_at) VALUES ('admin', 'reviews', 'Ratings and reviews', 'a ratings and reviews service such as Bazaarvoice, PowerReviews or Yotpo', 'migration 0056', '2026-11-05T00:00:00Z');
INSERT OR IGNORE INTO tech_stack (team, tech, name, description, changed_by, changed_at) VALUES ('admin', 'opspile', 'Enterprise Support inbox', 'the Enterprise Support inbox (opspile) or its bots (Adobe Support Monitoring, the admin bot)', 'migration 0056', '2026-11-05T00:00:00Z');

UPDATE tech_stack SET description = 'Adobe Analytics, Adobe Experience Platform Tags (Launch) or Web SDK, the Adobe Client Data Layer, or a tag manager or analytics tool such as Google Tag Manager, Google Analytics or Tealium', changed_by = 'migration 0056', changed_at = '2026-11-05T00:00:00Z'
  WHERE team = 'admin' AND tech = 'analytics' AND (description = 'Adobe Analytics, Web SDK or Experience Platform data collection');
UPDATE tech_stack SET description = 'Adobe Commerce (Magento, on PaaS or as a Cloud Service (ACCS)), Catalog Service or Live Search, or the Commerce drop-ins and storefront', changed_by = 'migration 0056', changed_at = '2026-11-05T00:00:00Z'
  WHERE team = 'admin' AND tech = 'commerce' AND (description = 'Adobe Commerce (Magento) or Commerce drop-ins');
UPDATE tech_stack SET description = 'AEM Assets (the DAM, Asset Selector or Asset Picker, Content Hub or Brand Portal)', changed_by = 'migration 0056', changed_at = '2026-11-05T00:00:00Z'
  WHERE team = 'admin' AND tech = 'assets' AND (description = 'AEM Assets or Dynamic Media');
UPDATE tech_stack SET description = 'AEM Sites Optimizer (ASO), including Preflight', changed_by = 'migration 0056', changed_at = '2026-11-05T00:00:00Z'
  WHERE team = 'admin' AND tech = 'aso' AND (description = 'AEM Sites Optimizer');
UPDATE tech_stack SET description = 'Adobe LLM Optimizer or Brand Visibility (ABV, Paid Brand Visibility): how AI assistants, answer engines and AI Overviews see its brand (GEO)', changed_by = 'migration 0056', changed_at = '2026-11-05T00:00:00Z'
  WHERE team = 'admin' AND tech = 'llmo' AND (description = 'Adobe LLM Optimizer or Brand Visibility (how AI assistants and answer engines see its brand)');
UPDATE tech_stack SET description = 'real-user monitoring or operational telemetry (RUM or OpTel) to measure its site', changed_by = 'migration 0056', changed_at = '2026-11-05T00:00:00Z'
  WHERE team = 'admin' AND tech = 'rum' AND (description = 'real-user monitoring or operational telemetry (RUM) to measure its site');
UPDATE tech_stack SET description = 'product feeds to Google Merchant Center, Meta, Pinterest, affiliate networks such as CJ, or other marketplaces', changed_by = 'migration 0056', changed_at = '2026-11-05T00:00:00Z'
  WHERE team = 'admin' AND tech = 'feeds' AND (description = 'product feeds to Google Merchant Center or other marketplaces');
UPDATE tech_stack SET description = 'a translation service or connector (such as Lilt, Smartling, GlobalLink, Lionbridge, WorldServer or DeepL), or Document Authoring''s Translate app', changed_by = 'migration 0056', changed_at = '2026-11-05T00:00:00Z'
  WHERE team = 'admin' AND tech = 'translation' AND (description = 'a translation service or connector (such as Lilt, Smartling or GlobalLink)');
UPDATE tech_stack SET description = 'a web application firewall, bot protection or rate limiting in front of its site (such as Akamai or Cloudflare WAF, Imperva or Azure WAF)', changed_by = 'migration 0056', changed_at = '2026-11-05T00:00:00Z'
  WHERE team = 'admin' AND tech = 'waf' AND (description = 'a web application firewall, bot protection or rate limiting in front of its site');
UPDATE tech_stack SET description = 'a site search service such as Algolia, Coveo, Azure AI Search or Solr', changed_by = 'migration 0056', changed_at = '2026-11-05T00:00:00Z'
  WHERE team = 'admin' AND tech = 'search' AND (description = 'a site search service such as Algolia or Coveo');
UPDATE tech_stack SET description = 'SharePoint or OneDrive as the content source (Word and Excel documents)', changed_by = 'migration 0056', changed_at = '2026-11-05T00:00:00Z'
  WHERE team = 'admin' AND tech = 'sharepoint' AND (description = 'SharePoint or OneDrive as the content source');
UPDATE tech_stack SET description = 'Bitbucket, GitLab or Azure DevOps for code through BYO Git, or private package feeds such as Azure Artifacts', changed_by = 'migration 0056', changed_at = '2026-11-05T00:00:00Z'
  WHERE team = 'admin' AND tech = 'bitbucket' AND (description = 'Bitbucket, GitLab, Azure DevOps or Cloud Manager git for code');
UPDATE tech_stack SET description = 'Cloudflare as CDN or Cloudflare Workers in front of its site', changed_by = 'migration 0056', changed_at = '2026-11-05T00:00:00Z'
  WHERE team = 'admin' AND tech = 'cloudflare' AND (description = 'Cloudflare as CDN');
UPDATE tech_stack SET description = 'Akamai as CDN (Property Manager, EdgeWorkers)', changed_by = 'migration 0056', changed_at = '2026-11-05T00:00:00Z'
  WHERE team = 'admin' AND tech = 'akamai' AND (description = 'Akamai as CDN');
UPDATE tech_stack SET description = 'AEM as a Cloud Service author or publish tier (adobeaemcloud.com, Cloud Manager programs), not Edge Delivery that people call AEM', changed_by = 'migration 0056', changed_at = '2026-11-05T00:00:00Z'
  WHERE team = 'admin' AND tech = 'aemcs' AND (description = 'AEM as a Cloud Service (author or publish tier, Cloud Manager)');
UPDATE tech_stack SET description = 'Experience Workspace (EW or XW), Adobe''s authoring workspace for its site', changed_by = 'migration 0056', changed_at = '2026-11-05T00:00:00Z'
  WHERE team = 'admin' AND tech = 'xw' AND (description = 'Experience Workspace or the Experience Modernization Agent' OR description = 'Experience Workspace (EW or XW), an authoring UI for its site, like Document Authoring');
UPDATE tech_stack SET description = 'a monitoring service such as New Relic, Datadog, Splunk or Dynatrace, or log forwarding to one', changed_by = 'migration 0056', changed_at = '2026-11-05T00:00:00Z'
  WHERE team = 'admin' AND tech = 'monitoring' AND (description = 'a monitoring service such as New Relic, Datadog, Splunk or Dynatrace');

-- The tech stack, checked against what the threads are about (the product census: Clairic's
-- product names over every channel thread, matched against the entries; docs/ARCHITECTURE.md,
-- "Labels and facts") and against Adobe's product list (business.adobe.com/products).
--
-- Every entry is now part of a **product** (`product`): the Adobe product it belongs to, by the
-- name on that list (Experience Manager Sites has Edge Delivery, Document Authoring, Universal
-- Editor, … as its entries), or a category for the others' (CDN, Code hosting, …). Clef is still
-- asked about each entry; the product groups them, on the Topics page and the Agents page. The
-- admin team's new entries are what the threads named and no entry covered, and Adobe products
-- they named that had none (CX Enterprise Coworker, Brand Concierge, Journey Optimizer, …); the
-- names people use go into the descriptions of others. A name or description someone changed on
-- the Agents page since migration 0043 wrote it is left as it is.
ALTER TABLE tech_stack ADD COLUMN product TEXT;  -- the product or category it is part of; NULL: none

INSERT OR IGNORE INTO tech_stack (team, tech, name, description, product, changed_by, changed_at) VALUES ('admin', 'aem65', 'AEM 6.5 or AMS', 'AEM 6.5 on its own servers or on Adobe Managed Services (AMS), for example as the site it migrates from', 'Experience Manager Sites', 'migration 0056', '2026-11-05T00:00:00Z');
INSERT OR IGNORE INTO tech_stack (team, tech, name, description, product, changed_by, changed_at) VALUES ('admin', 'aemcontent', 'Content Fragments and AEM APIs', 'Content Fragments, Experience Fragments or AEM''s content APIs (GraphQL, OpenAPI, the Sites or Page Management APIs)', 'Experience Manager Sites', 'migration 0056', '2026-11-05T00:00:00Z');
INSERT OR IGNORE INTO tech_stack (team, tech, name, description, product, changed_by, changed_at) VALUES ('admin', 'msm', 'MSM and language copies', 'Multi Site Manager in AEM Sites: live copies, blueprints, rollouts or language copies', 'Experience Manager Sites', 'migration 0056', '2026-11-05T00:00:00Z');
INSERT OR IGNORE INTO tech_stack (team, tech, name, description, product, changed_by, changed_at) VALUES ('admin', 'edgefunctions', 'AEM Edge Functions', 'AEM Edge Functions to run its own code at Adobe''s CDN', 'Experience Manager Sites', 'migration 0056', '2026-11-05T00:00:00Z');
INSERT OR IGNORE INTO tech_stack (team, tech, name, description, product, changed_by, changed_at) VALUES ('admin', 'contentai', 'Content AI search', 'AEM Content AI: semantic or AI search over its site content', 'Experience Manager Sites', 'migration 0056', '2026-11-05T00:00:00Z');
INSERT OR IGNORE INTO tech_stack (team, tech, name, description, product, changed_by, changed_at) VALUES ('admin', 'dm', 'Dynamic Media', 'Dynamic Media or Dynamic Media with OpenAPI to deliver and transform its images and videos (smart crops, templates, DM URLs)', 'Experience Manager Assets', 'migration 0056', '2026-11-05T00:00:00Z');
INSERT OR IGNORE INTO tech_stack (team, tech, name, description, product, changed_by, changed_at) VALUES ('admin', 'aco', 'Commerce Optimizer', 'Adobe Commerce Optimizer (ACO) for its catalog, prices and price books', 'Commerce Optimizer', 'migration 0056', '2026-11-05T00:00:00Z');
INSERT OR IGNORE INTO tech_stack (team, tech, name, description, product, changed_by, changed_at) VALUES ('admin', 'coworker', 'CX Enterprise Coworker', 'Adobe CX Enterprise Coworker (CX Coworker), its AI agents or connectors', 'CX Enterprise Coworker', 'migration 0056', '2026-11-05T00:00:00Z');
INSERT OR IGNORE INTO tech_stack (team, tech, name, description, product, changed_by, changed_at) VALUES ('admin', 'brandconcierge', 'Brand Concierge', 'Adobe Brand Concierge, a conversational AI assistant on its site', 'Brand Concierge', 'migration 0056', '2026-11-05T00:00:00Z');
INSERT OR IGNORE INTO tech_stack (team, tech, name, description, product, changed_by, changed_at) VALUES ('admin', 'rtcdp', 'Real-Time CDP', 'Adobe Experience Platform or Real-Time CDP for its customer profiles and audiences', 'Real-Time CDP', 'migration 0056', '2026-11-05T00:00:00Z');
INSERT OR IGNORE INTO tech_stack (team, tech, name, description, product, changed_by, changed_at) VALUES ('admin', 'ajo', 'Journey Optimizer', 'Adobe Journey Optimizer (AJO) for customer journeys, messages or push notifications', 'Journey Optimizer', 'migration 0056', '2026-11-05T00:00:00Z');
INSERT OR IGNORE INTO tech_stack (team, tech, name, description, product, changed_by, changed_at) VALUES ('admin', 'campaign', 'Campaign', 'Adobe Campaign for email or cross-channel campaigns', 'Campaign', 'migration 0056', '2026-11-05T00:00:00Z');
INSERT OR IGNORE INTO tech_stack (team, tech, name, description, product, changed_by, changed_at) VALUES ('admin', 'workfront', 'Workfront', 'Adobe Workfront for its content or asset workflows', 'Workfront', 'migration 0056', '2026-11-05T00:00:00Z');
INSERT OR IGNORE INTO tech_stack (team, tech, name, description, product, changed_by, changed_at) VALUES ('admin', 'genstudio', 'GenStudio and Firefly', 'Adobe GenStudio, Firefly or Express to create content for its site', 'GenStudio', 'migration 0056', '2026-11-05T00:00:00Z');
INSERT OR IGNORE INTO tech_stack (team, tech, name, description, product, changed_by, changed_at) VALUES ('admin', 'semrush', 'Semrush', 'Semrush for SEO or AI search data about its site', 'Semrush', 'migration 0056', '2026-11-05T00:00:00Z');
INSERT OR IGNORE INTO tech_stack (team, tech, name, description, product, changed_by, changed_at) VALUES ('admin', 'adobeims', 'Adobe IMS and Admin Console', 'Adobe IMS organizations, Adobe IDs and Admin Console product profiles or user groups for its people''s access, or Adobe Developer Console credentials (OAuth server-to-server) for Adobe APIs', 'Adobe Developer platform', 'migration 0056', '2026-11-05T00:00:00Z');
INSERT OR IGNORE INTO tech_stack (team, tech, name, description, product, changed_by, changed_at) VALUES ('admin', 'opspile', 'Enterprise Support inbox', 'the Enterprise Support inbox (opspile) or its bots (Adobe Support Monitoring, the admin bot)', 'Adobe Enterprise Support', 'migration 0056', '2026-11-05T00:00:00Z');
INSERT OR IGNORE INTO tech_stack (team, tech, name, description, product, changed_by, changed_at) VALUES ('admin', 'tagmanager', 'Tag manager', 'a tag manager or analytics tool other than Adobe''s, such as Google Tag Manager, Google Analytics or Tealium', 'Tags and analytics', 'migration 0056', '2026-11-05T00:00:00Z');
INSERT OR IGNORE INTO tech_stack (team, tech, name, description, product, changed_by, changed_at) VALUES ('admin', 'aiagents', 'AI assistants and agents', 'AI assistants or agents such as ChatGPT, Claude, Microsoft Copilot, Gemini or Cursor with its site or content, for example through the AEM MCP server or an AEM connector', 'AI assistants', 'migration 0056', '2026-11-05T00:00:00Z');
INSERT OR IGNORE INTO tech_stack (team, tech, name, description, product, changed_by, changed_at) VALUES ('admin', 'cloud', 'Own cloud services', 'its own services on AWS, Microsoft Azure or Google Cloud (storage such as S3 or Blob Storage, Lambda or Functions, API gateways) behind or next to its site', 'Cloud platforms', 'migration 0056', '2026-11-05T00:00:00Z');
INSERT OR IGNORE INTO tech_stack (team, tech, name, description, product, changed_by, changed_at) VALUES ('admin', 'webtools', 'Google site tools', 'Google''s tools for its site: PageSpeed Insights, Lighthouse, CrUX or Search Console', 'Site tools', 'migration 0056', '2026-11-05T00:00:00Z');
INSERT OR IGNORE INTO tech_stack (team, tech, name, description, product, changed_by, changed_at) VALUES ('admin', 'erp', 'ERP and PIM', 'an ERP, PIM or order management system (such as Oracle EBS, Microsoft Dynamics, NetSuite or Akeneo) for its product or order data', 'ERP and PIM', 'migration 0056', '2026-11-05T00:00:00Z');
INSERT OR IGNORE INTO tech_stack (team, tech, name, description, product, changed_by, changed_at) VALUES ('admin', 'crm', 'CRM', 'a CRM or marketing platform other than Adobe''s, such as Salesforce (CRM, Marketing Cloud or Data Cloud) or HubSpot', 'CRM', 'migration 0056', '2026-11-05T00:00:00Z');
INSERT OR IGNORE INTO tech_stack (team, tech, name, description, product, changed_by, changed_at) VALUES ('admin', 'scriptsecurity', 'Script security', 'a client-side script security or scanning tool (such as Feroot) or a corporate security proxy (such as Microsoft Defender for Cloud Apps) on its site', 'Site security', 'migration 0056', '2026-11-05T00:00:00Z');
INSERT OR IGNORE INTO tech_stack (team, tech, name, description, product, changed_by, changed_at) VALUES ('admin', 'figma', 'Figma', 'Figma for designs that become pages (the Figma integration, Figma-to-content or Figma MCP)', 'Design tools', 'migration 0056', '2026-11-05T00:00:00Z');
INSERT OR IGNORE INTO tech_stack (team, tech, name, description, product, changed_by, changed_at) VALUES ('admin', 'embeds', 'Video and embeds', 'a video or embedded-content service such as YouTube, Brightcove, Vev, Datawrapper or Tally', 'Video and embeds', 'migration 0056', '2026-11-05T00:00:00Z');
INSERT OR IGNORE INTO tech_stack (team, tech, name, description, product, changed_by, changed_at) VALUES ('admin', 'reviews', 'Ratings and reviews', 'a ratings and reviews service such as Bazaarvoice, PowerReviews or Yotpo', 'Ratings and reviews', 'migration 0056', '2026-11-05T00:00:00Z');

UPDATE tech_stack SET product = 'Experience Manager Sites' WHERE team = 'admin' AND tech = 'aemcs';
UPDATE tech_stack SET product = 'CDN' WHERE team = 'admin' AND tech = 'akamai';
UPDATE tech_stack SET product = 'Adobe Analytics suite' WHERE team = 'admin' AND tech = 'analytics';
UPDATE tech_stack SET product = 'Adobe Developer platform' WHERE team = 'admin' AND tech = 'appbuilder';
UPDATE tech_stack SET product = 'Experience Manager Sites Optimizer' WHERE team = 'admin' AND tech = 'aso';
UPDATE tech_stack SET product = 'Experience Manager Assets' WHERE team = 'admin' AND tech = 'assets';
UPDATE tech_stack SET product = 'Code hosting' WHERE team = 'admin' AND tech = 'bitbucket';
UPDATE tech_stack SET product = 'Experience Manager Sites' WHERE team = 'admin' AND tech = 'byom';
UPDATE tech_stack SET product = 'CDN' WHERE team = 'admin' AND tech = 'cloudflare';
UPDATE tech_stack SET product = 'CDN' WHERE team = 'admin' AND tech = 'cloudfront';
UPDATE tech_stack SET product = 'Commerce' WHERE team = 'admin' AND tech = 'commerce';
UPDATE tech_stack SET product = 'Consent' WHERE team = 'admin' AND tech = 'consent';
UPDATE tech_stack SET product = 'Experience Manager Sites' WHERE team = 'admin' AND tech = 'da';
UPDATE tech_stack SET product = 'Experience Manager Sites' WHERE team = 'admin' AND tech = 'eds';
UPDATE tech_stack SET product = 'Experience Manager Sites' WHERE team = 'admin' AND tech = 'ema';
UPDATE tech_stack SET product = 'CDN' WHERE team = 'admin' AND tech = 'fastly';
UPDATE tech_stack SET product = 'Product feeds and marketplaces' WHERE team = 'admin' AND tech = 'feeds';
UPDATE tech_stack SET product = 'Experience Manager Forms' WHERE team = 'admin' AND tech = 'forms';
UPDATE tech_stack SET product = 'Content sources' WHERE team = 'admin' AND tech = 'gdrive';
UPDATE tech_stack SET product = 'Code hosting' WHERE team = 'admin' AND tech = 'github';
UPDATE tech_stack SET product = 'Brand Visibility' WHERE team = 'admin' AND tech = 'llmo';
UPDATE tech_stack SET product = 'Monitoring' WHERE team = 'admin' AND tech = 'monitoring';
UPDATE tech_stack SET product = 'Experience Manager Sites' WHERE team = 'admin' AND tech = 'productbus';
UPDATE tech_stack SET product = 'Experience Manager Sites' WHERE team = 'admin' AND tech = 'rum';
UPDATE tech_stack SET product = 'Site search' WHERE team = 'admin' AND tech = 'search';
UPDATE tech_stack SET product = 'Content sources' WHERE team = 'admin' AND tech = 'sharepoint';
UPDATE tech_stack SET product = 'Identity providers' WHERE team = 'admin' AND tech = 'sso';
UPDATE tech_stack SET product = 'Target' WHERE team = 'admin' AND tech = 'target';
UPDATE tech_stack SET product = 'Translation' WHERE team = 'admin' AND tech = 'translation';
UPDATE tech_stack SET product = 'Experience Manager Sites' WHERE team = 'admin' AND tech = 'ue';
UPDATE tech_stack SET product = 'Site security' WHERE team = 'admin' AND tech = 'waf';
UPDATE tech_stack SET product = 'Experience Manager Sites' WHERE team = 'admin' AND tech = 'xw';

UPDATE tech_stack SET description = 'Adobe Analytics, Customer Journey Analytics, Adobe Experience Platform Tags (Launch), Web SDK or the Adobe Client Data Layer', changed_by = 'migration 0056', changed_at = '2026-11-05T00:00:00Z'
  WHERE team = 'admin' AND tech = 'analytics' AND (description = 'Adobe Analytics, Web SDK or Experience Platform data collection');
UPDATE tech_stack SET description = 'Adobe Commerce (Magento, on PaaS or as a Cloud Service (ACCS)), Catalog Service or Live Search, or the Commerce drop-ins and storefront', changed_by = 'migration 0056', changed_at = '2026-11-05T00:00:00Z'
  WHERE team = 'admin' AND tech = 'commerce' AND (description = 'Adobe Commerce (Magento) or Commerce drop-ins');
UPDATE tech_stack SET description = 'AEM Assets (the DAM, Asset Selector or Asset Picker, Content Hub or Brand Portal)', changed_by = 'migration 0056', changed_at = '2026-11-05T00:00:00Z'
  WHERE team = 'admin' AND tech = 'assets' AND (description = 'AEM Assets or Dynamic Media');
UPDATE tech_stack SET description = 'AEM Sites Optimizer (ASO), including Preflight', changed_by = 'migration 0056', changed_at = '2026-11-05T00:00:00Z'
  WHERE team = 'admin' AND tech = 'aso' AND (description = 'AEM Sites Optimizer');
UPDATE tech_stack SET description = 'Adobe Brand Visibility or LLM Optimizer (ABV, Paid Brand Visibility): how AI assistants, answer engines and AI Overviews see its brand (GEO)', changed_by = 'migration 0056', changed_at = '2026-11-05T00:00:00Z'
  WHERE team = 'admin' AND tech = 'llmo' AND (description = 'Adobe LLM Optimizer or Brand Visibility (how AI assistants and answer engines see its brand)');
UPDATE tech_stack SET name = 'Brand Visibility' WHERE team = 'admin' AND tech = 'llmo' AND name = 'LLM Optimizer';
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

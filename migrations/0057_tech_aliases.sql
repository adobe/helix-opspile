-- The names a tech stack entry also goes by, as people write them in threads ("AEMaaCS", "IMS
-- Org", "EdgeWorkers"): for matching the product names Clairic finds against the tech stack
-- (src/products.js), so a product the stack has does not show as a gap on the Topics page. Clef
-- is not asked about them; the description stays what it is asked. Comma-separated, editable on
-- the Agents page. These are the admin team's, from the product census.
ALTER TABLE tech_stack ADD COLUMN aliases TEXT;

UPDATE tech_stack SET aliases = 'EDS, Edge Delivery, Franklin, Helix, aem.live, aem.page, aem.network, hlx.page, hlx.live, Sidekick, AEM Sidekick, Admin API, Media Bus, MediaBus, Code Sync, CodeSync, Config Service, Configuration Service, BYO CDN, BYOCDN, Adobe Managed CDN, Managed CDN, Block Library, Sidekick Library, query index' WHERE team = 'admin' AND tech = 'eds' AND aliases IS NULL;
UPDATE tech_stack SET aliases = 'AEMaaCS, AEM CS, AEMCS, AEM Cloud Service, AEM as a Cloud Service, Cloud Manager, adobeaemcloud.com, AEM Author, AEM Publish, Closed User Groups, CUG' WHERE team = 'admin' AND tech = 'aemcs' AND aliases IS NULL;
UPDATE tech_stack SET aliases = 'DA, da.live, DA Media Library, Media Library' WHERE team = 'admin' AND tech = 'da' AND aliases IS NULL;
UPDATE tech_stack SET aliases = 'UE, XWalk, Crosswalk, Universal Editor' WHERE team = 'admin' AND tech = 'ue' AND aliases IS NULL;
UPDATE tech_stack SET aliases = 'EW, XW, Exp Workspace' WHERE team = 'admin' AND tech = 'xw' AND aliases IS NULL;
UPDATE tech_stack SET aliases = 'EdgeWorkers, EdgeWorker, Edge Workers, Edge Worker, SureRoute, Property Manager, Akamai CDN' WHERE team = 'admin' AND tech = 'akamai' AND aliases IS NULL;
UPDATE tech_stack SET aliases = 'Fastly CDN, Compute@Edge' WHERE team = 'admin' AND tech = 'fastly' AND aliases IS NULL;
UPDATE tech_stack SET aliases = 'Cloudflare Workers, Cloudflare CDN' WHERE team = 'admin' AND tech = 'cloudflare' AND aliases IS NULL;
UPDATE tech_stack SET aliases = 'CloudFront, Amazon CloudFront' WHERE team = 'admin' AND tech = 'cloudfront' AND aliases IS NULL;
UPDATE tech_stack SET aliases = 'EMA, AEM Coder, AEMCoder, Experience Modernization Agent, Modernization Agent' WHERE team = 'admin' AND tech = 'ema' AND aliases IS NULL;
UPDATE tech_stack SET aliases = 'IMS, Adobe IMS, IMS Org, IMS Organization, Adobe ID, AdobeOrg, Admin Console, Adobe Admin Console, Developer Console, Adobe Developer Console' WHERE team = 'admin' AND tech = 'adobeims' AND aliases IS NULL;
UPDATE tech_stack SET aliases = 'Content Fragments, Content Fragment, CF Editor, CF Picker, Content Fragment Picker, Experience Fragments, Experience Fragment, AEM Sites API, Sites API, Page Management API, Content API' WHERE team = 'admin' AND tech = 'aemcontent' AND aliases IS NULL;
UPDATE tech_stack SET aliases = 'Okta, Entra, Entra ID, Microsoft Entra ID, Azure AD, Ping Identity, Auth0, PingFederate' WHERE team = 'admin' AND tech = 'sso' AND aliases IS NULL;
UPDATE tech_stack SET aliases = 'Magento, ACCS, Adobe Commerce, Adobe Commerce as a Cloud Service, Commerce drop-ins, drop-ins, Live Search, Catalog Service' WHERE team = 'admin' AND tech = 'commerce' AND aliases IS NULL;
UPDATE tech_stack SET aliases = 'ACO, Adobe Commerce Optimizer' WHERE team = 'admin' AND tech = 'aco' AND aliases IS NULL;
UPDATE tech_stack SET aliases = 'Product Bus, Helix Commerce' WHERE team = 'admin' AND tech = 'productbus' AND aliases IS NULL;
UPDATE tech_stack SET aliases = 'DM, Dynamic Media, DynamicMedia, DM OpenAPI, Dynamic Media OpenAPI, Scene7' WHERE team = 'admin' AND tech = 'dm' AND aliases IS NULL;
UPDATE tech_stack SET aliases = 'AEM Assets, DAM, Asset Selector, Asset Picker, Content Hub, Brand Portal' WHERE team = 'admin' AND tech = 'assets' AND aliases IS NULL;
UPDATE tech_stack SET aliases = 'ChatGPT, OpenAI, Claude, Claude Desktop, Anthropic, Copilot, Microsoft Copilot, Gemini, Grok, Cursor, AEM MCP, MCP, MCP server' WHERE team = 'admin' AND tech = 'aiagents' AND aliases IS NULL;
UPDATE tech_stack SET aliases = 'AWS, Amazon Web Services, S3, Lambda, AWS Lambda, API Gateway, Azure, Azure Storage, Azure Blob Storage, Azure Functions, Google Cloud, GCP' WHERE team = 'admin' AND tech = 'cloud' AND aliases IS NULL;
UPDATE tech_stack SET aliases = 'GTM, Google Tag Manager, Google Analytics, GA4, Tealium' WHERE team = 'admin' AND tech = 'tagmanager' AND aliases IS NULL;
UPDATE tech_stack SET aliases = 'Adobe Analytics, CJA, Customer Journey Analytics, Launch, Adobe Launch, Adobe Tags, Web SDK, alloy, ACDL, Adobe Client Data Layer' WHERE team = 'admin' AND tech = 'analytics' AND aliases IS NULL;
UPDATE tech_stack SET aliases = 'AEP, Adobe Experience Platform, Experience Platform, RTCDP, RT-CDP, Real-Time CDP' WHERE team = 'admin' AND tech = 'rtcdp' AND aliases IS NULL;
UPDATE tech_stack SET aliases = 'AJO, Adobe Journey Optimizer' WHERE team = 'admin' AND tech = 'ajo' AND aliases IS NULL;
UPDATE tech_stack SET aliases = 'Adobe Campaign' WHERE team = 'admin' AND tech = 'campaign' AND aliases IS NULL;
UPDATE tech_stack SET aliases = 'Adobe Target' WHERE team = 'admin' AND tech = 'target' AND aliases IS NULL;
UPDATE tech_stack SET aliases = 'Bazaarvoice, Bazaar Voice, PowerReviews, Yotpo' WHERE team = 'admin' AND tech = 'reviews' AND aliases IS NULL;
UPDATE tech_stack SET aliases = 'Merchant Center, Google Merchant Center, GMC, Google Shopping' WHERE team = 'admin' AND tech = 'feeds' AND aliases IS NULL;
UPDATE tech_stack SET aliases = 'Sumo Logic, Sumologic, Datadog, New Relic, Splunk, Dynatrace, OpenTelemetry, OTel, log forwarding' WHERE team = 'admin' AND tech = 'monitoring' AND aliases IS NULL;
UPDATE tech_stack SET aliases = 'OneTrust, One Trust, Cookiebot, TrustArc, Usercentrics' WHERE team = 'admin' AND tech = 'consent' AND aliases IS NULL;
UPDATE tech_stack SET aliases = 'ASO, Sites Optimizer, AEM Sites Optimizer, Spacecat, Preflight' WHERE team = 'admin' AND tech = 'aso' AND aliases IS NULL;
UPDATE tech_stack SET aliases = 'LLMO, LLM Optimizer, ABV, Brand Visibility, Paid Brand Visibility' WHERE team = 'admin' AND tech = 'llmo' AND aliases IS NULL;
UPDATE tech_stack SET aliases = 'RUM, OpTel, Operational Telemetry' WHERE team = 'admin' AND tech = 'rum' AND aliases IS NULL;
UPDATE tech_stack SET aliases = 'GH, GHE, GitHub Enterprise, GitHub Actions, Dependabot, github.com' WHERE team = 'admin' AND tech = 'github' AND aliases IS NULL;
UPDATE tech_stack SET aliases = 'BYO Git, BYOGit, Bring Your Own Git, GitLab, Azure DevOps, ADO, Bitbucket' WHERE team = 'admin' AND tech = 'bitbucket' AND aliases IS NULL;
UPDATE tech_stack SET aliases = 'sharepoint.com, OneDrive, SharePoint Online' WHERE team = 'admin' AND tech = 'sharepoint' AND aliases IS NULL;
UPDATE tech_stack SET aliases = 'Google Docs, Google Sheets, Google Drive, docs.google.com, drive.google.com' WHERE team = 'admin' AND tech = 'gdrive' AND aliases IS NULL;
UPDATE tech_stack SET aliases = 'App Builder, I/O Runtime, Adobe I/O, Adobe I/O Runtime, adobeio, aio' WHERE team = 'admin' AND tech = 'appbuilder' AND aliases IS NULL;
UPDATE tech_stack SET aliases = 'AEM 6.5, AMS, Adobe Managed Services, AEM On Prem, AEM on-premise' WHERE team = 'admin' AND tech = 'aem65' AND aliases IS NULL;
UPDATE tech_stack SET aliases = 'MSM, Multi Site Manager, Live Copy, Live Copies, Blueprint, Language Copy, Language Copies' WHERE team = 'admin' AND tech = 'msm' AND aliases IS NULL;
UPDATE tech_stack SET aliases = 'Edge Functions, Edge Function, AEM Edge Functions, Edge Compute' WHERE team = 'admin' AND tech = 'edgefunctions' AND aliases IS NULL;
UPDATE tech_stack SET aliases = 'Oracle EBS, EBS, Dynamics 365, Microsoft Dynamics, NetSuite, SAP, Akeneo, Salsify, inRiver' WHERE team = 'admin' AND tech = 'erp' AND aliases IS NULL;
UPDATE tech_stack SET aliases = 'Enterprise Support inbox, Adobe Support Monitoring, opspile' WHERE team = 'admin' AND tech = 'opspile' AND aliases IS NULL;
UPDATE tech_stack SET aliases = 'CX Coworker, Coworker, CX Enterprise Coworker, AEM Coworker' WHERE team = 'admin' AND tech = 'coworker' AND aliases IS NULL;
UPDATE tech_stack SET aliases = 'Brand Concierge, Adobe Brand Concierge' WHERE team = 'admin' AND tech = 'brandconcierge' AND aliases IS NULL;
UPDATE tech_stack SET aliases = 'Content AI, AEM Content AI, semantic search' WHERE team = 'admin' AND tech = 'contentai' AND aliases IS NULL;
UPDATE tech_stack SET aliases = 'Workfront, Adobe Workfront' WHERE team = 'admin' AND tech = 'workfront' AND aliases IS NULL;
UPDATE tech_stack SET aliases = 'Figma, Figma MCP' WHERE team = 'admin' AND tech = 'figma' AND aliases IS NULL;
UPDATE tech_stack SET aliases = 'Imperva, Cloudflare WAF, Azure WAF, bot protection' WHERE team = 'admin' AND tech = 'waf' AND aliases IS NULL;
UPDATE tech_stack SET aliases = 'Algolia, Coveo, Solr, Azure AI Search, Bloomreach, Constructor' WHERE team = 'admin' AND tech = 'search' AND aliases IS NULL;
UPDATE tech_stack SET aliases = 'Lilt, Smartling, GlobalLink, Lionbridge, WorldServer, DeepL' WHERE team = 'admin' AND tech = 'translation' AND aliases IS NULL;
UPDATE tech_stack SET aliases = 'YouTube, Vimeo, Brightcove, Vev, Datawrapper, Tally' WHERE team = 'admin' AND tech = 'embeds' AND aliases IS NULL;
UPDATE tech_stack SET aliases = 'Salesforce, HubSpot, Salesforce Marketing Cloud, Marketing Cloud, Data Cloud' WHERE team = 'admin' AND tech = 'crm' AND aliases IS NULL;
UPDATE tech_stack SET aliases = 'Feroot, Microsoft Defender, Defender for Cloud Apps' WHERE team = 'admin' AND tech = 'scriptsecurity' AND aliases IS NULL;
UPDATE tech_stack SET aliases = 'GenStudio, Firefly, Adobe Express, Adobe Firefly' WHERE team = 'admin' AND tech = 'genstudio' AND aliases IS NULL;
UPDATE tech_stack SET aliases = 'PageSpeed Insights, PSI, Lighthouse, CrUX, Search Console, Google Search Console, Bing Webmaster' WHERE team = 'admin' AND tech = 'webtools' AND aliases IS NULL;
UPDATE tech_stack SET aliases = 'Semrush' WHERE team = 'admin' AND tech = 'semrush' AND aliases IS NULL;
UPDATE tech_stack SET aliases = 'AEM Forms, Adaptive Forms' WHERE team = 'admin' AND tech = 'forms' AND aliases IS NULL;
UPDATE tech_stack SET aliases = 'BYOM, json2html, content overlay' WHERE team = 'admin' AND tech = 'byom' AND aliases IS NULL;

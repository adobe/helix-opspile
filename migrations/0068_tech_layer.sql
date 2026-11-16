-- Where in a customer's stack each technology is (src/stack.js LAYERS): edge, site, content, code,
-- commerce, martech, identity or other. The stack drawings of the knowledge bases (stack.md) are
-- drawn in the same layers, and the list by customer names the likeliest technology of each layer,
-- in that order, under the customer (ui/inbox.js). NULL: none yet (the list leaves it out). These
-- are the admin team's; a team's own entry of the same id without one takes the admin team's.
ALTER TABLE tech_stack ADD COLUMN layer TEXT;

UPDATE tech_stack SET layer = 'edge' WHERE team = 'admin' AND layer IS NULL AND tech IN ('akamai', 'cloudflare', 'fastly', 'cloudfront', 'waf', 'edgefunctions', 'scriptsecurity');
UPDATE tech_stack SET layer = 'site' WHERE team = 'admin' AND layer IS NULL AND tech IN ('eds', 'aem65', 'aemcs', 'byom', 'forms', 'embeds', 'brandconcierge');
UPDATE tech_stack SET layer = 'content' WHERE team = 'admin' AND layer IS NULL AND tech IN ('da', 'sharepoint', 'gdrive', 'ue', 'xw', 'sidekick', 'msm', 'translation', 'assets', 'dm', 'aemcontent', 'figma', 'genstudio', 'workfront', 'ema');
UPDATE tech_stack SET layer = 'code' WHERE team = 'admin' AND layer IS NULL AND tech IN ('github', 'bitbucket', 'appbuilder');
UPDATE tech_stack SET layer = 'commerce' WHERE team = 'admin' AND layer IS NULL AND tech IN ('commerce', 'aco', 'productbus', 'erp', 'feeds', 'search', 'contentai', 'reviews', 'crm', 'cloud');
UPDATE tech_stack SET layer = 'martech' WHERE team = 'admin' AND layer IS NULL AND tech IN ('analytics', 'target', 'rtcdp', 'ajo', 'campaign', 'tagmanager', 'consent', 'rum', 'monitoring', 'llmo', 'aso', 'semrush', 'webtools');
UPDATE tech_stack SET layer = 'identity' WHERE team = 'admin' AND layer IS NULL AND tech IN ('sso', 'adobeims');
UPDATE tech_stack SET layer = 'other' WHERE team = 'admin' AND layer IS NULL AND tech IN ('opspile', 'aiagents', 'coworker');

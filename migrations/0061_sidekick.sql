-- The AEM Sidekick as an entry of its own, and Document Authoring told apart from it. Both are
-- Edge Delivery features of Experience Manager Sites, and threads name both (Clairic's product
-- names: the Sidekick in 13 threads, DA or da.live in 81, both in 4),
-- but the Sidekick was an alias of Edge Delivery (migration 0057): Clef was never asked about
-- it, the Topics page drew it as Edge Delivery, and a thread about the Sidekick showed nothing of
-- its own, so the inbox named it after the channel's likeliest technology, which a da.live link
-- in another thread had made Document Authoring. Document Authoring also goes by its first name,
-- Dark Alley. An alias or description someone changed on the Agents page since is left as it is.
INSERT OR IGNORE INTO tech_stack (team, tech, name, description, aliases, product, changed_by, changed_at) VALUES ('admin', 'sidekick', 'AEM Sidekick', 'the AEM Sidekick, the browser extension to preview, publish or sign in to its site from the page or the document', 'Sidekick, AEM Sidekick, Helix Sidekick, Franklin Sidekick, Sidekick extension, Sidekick Library', 'Experience Manager Sites', 'migration 0061', '2026-11-06T00:00:00Z');

UPDATE tech_stack SET aliases = 'EDS, Edge Delivery, Franklin, Helix, aem.live, aem.page, aem.network, hlx.page, hlx.live, Admin API, Media Bus, MediaBus, Code Sync, CodeSync, Config Service, Configuration Service, BYO CDN, BYOCDN, Adobe Managed CDN, Managed CDN, Block Library, query index', changed_by = 'migration 0061', changed_at = '2026-11-06T00:00:00Z'
  WHERE team = 'admin' AND tech = 'eds' AND aliases = 'EDS, Edge Delivery, Franklin, Helix, aem.live, aem.page, aem.network, hlx.page, hlx.live, Sidekick, AEM Sidekick, Admin API, Media Bus, MediaBus, Code Sync, CodeSync, Config Service, Configuration Service, BYO CDN, BYOCDN, Adobe Managed CDN, Managed CDN, Block Library, Sidekick Library, query index';

UPDATE tech_stack SET aliases = 'DA, da.live, Dark Alley, Adobe Document Authoring, DA Media Library, Media Library', changed_by = 'migration 0061', changed_at = '2026-11-06T00:00:00Z'
  WHERE team = 'admin' AND tech = 'da' AND aliases = 'DA, da.live, DA Media Library, Media Library';

UPDATE tech_stack SET description = 'Document Authoring (DA or da.live, also called Dark Alley), the editor at da.live its authors write the pages of its site in', changed_by = 'migration 0061', changed_at = '2026-11-06T00:00:00Z'
  WHERE team = 'admin' AND tech = 'da' AND description = 'Document Authoring (da.live)';

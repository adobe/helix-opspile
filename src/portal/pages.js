/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

/*
 * The portal Worker's page (src/portal/worker.js), built as this module loads: if ui/portal.html
 * names a script or stylesheet that `PORTAL_SCRIPTS` lacks, building it throws and the Worker
 * does not start. It is a module of its own, without `cloudflare:workers`, so that
 * test/ui-pages.test.js builds it from this very map.
 */

import portalHtml from '../../ui/portal.html';
import portalJs from '../../ui/portal.js' with { type: 'text' };
import appJs from '../../ui/app.js' with { type: 'text' };
import writingJs from '../../ui/writing.js' with { type: 'text' };
import richtextJs from '../../ui/richtext.js' with { type: 'text' };
import spectrumFontsCss from '../../ui/spectrum-fonts.css' with { type: 'text' };
import spectrumCss from '../../ui/spectrum.css' with { type: 'text' };
import spectrumPortalCss from '../../ui/spectrum-portal.css' with { type: 'text' };
import { portalPage } from './page.js';

/** ui/*.js and ui/*.css ui/portal.html names, by file name (`PORTAL_FILES`). */
export const PORTAL_SCRIPTS = {
  'portal.js': portalJs,
  'app.js': appJs,
  'writing.js': writingJs,
  'richtext.js': richtextJs,
  'spectrum-fonts.css': spectrumFontsCss,
  'spectrum.css': spectrumCss,
  'spectrum-portal.css': spectrumPortalCss,
};

export const PORTAL_PAGE = portalPage(portalHtml, PORTAL_SCRIPTS);

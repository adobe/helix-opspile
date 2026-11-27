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
 * The inbox Worker's pages (src/index.js), built as this module loads: if a page of ui/ names a
 * script or stylesheet that `SCRIPTS` lacks, building it throws and the Worker does not start.
 * It is a module of its own so that test/ui-pages.test.js builds them from this very map.
 */

import inboxHtml from '../ui/inbox.html';
import adminHtml from '../ui/admin.html';
import cogsHtml from '../ui/cogs.html';
import topicsHtml from '../ui/topics.html';
// The pages' scripts, as text (src/page.js inlines them).
import inboxJs from '../ui/inbox.js' with { type: 'text' };
import adminJs from '../ui/admin.js' with { type: 'text' };
import agentJs from '../ui/agent.js' with { type: 'text' };
import cogsJs from '../ui/cogs.js' with { type: 'text' };
import topicsJs from '../ui/topics.js' with { type: 'text' };
import appJs from '../ui/app.js' with { type: 'text' };
import headerJs from '../ui/header.js' with { type: 'text' };
import rankJs from '../ui/rank.js' with { type: 'text' };
import tableJs from '../ui/table.js' with { type: 'text' };
import writingJs from '../ui/writing.js' with { type: 'text' };
import stackJs from '../ui/stack.js' with { type: 'text' };
import notifyHelpJs from '../ui/notifyhelp.js' with { type: 'text' };
import tourJs from '../ui/tour.js' with { type: 'text' };
import followJs from '../ui/follow.js' with { type: 'text' };
import followSuggestJs from '../ui/followsuggest.js' with { type: 'text' };
import topicGraphJs from '../ui/topicgraph.js' with { type: 'text' };
import topicSpaceJs from '../ui/topicspace.js' with { type: 'text' };
import topicViewJs from '../ui/topicview.js' with { type: 'text' };
import trendsJs from '../ui/trends.js' with { type: 'text' };
import trendViewJs from '../ui/trendview.js' with { type: 'text' };
import overviewJs from '../ui/overview.js' with { type: 'text' };
import teamJs from '../ui/team.js' with { type: 'text' };
import customerJs from '../ui/customer.js' with { type: 'text' };
import kbchatJs from '../ui/kbchat.js' with { type: 'text' };
import personJs from '../ui/person.js' with { type: 'text' };
import sideNavJs from '../ui/sidenav.js' with { type: 'text' };
import reviewJs from '../ui/review.js' with { type: 'text' };
// Spectrum 2's look of every page (README, "Spectrum 2").
import spectrumFontsCss from '../ui/spectrum-fonts.css' with { type: 'text' };
import spectrumCss from '../ui/spectrum.css' with { type: 'text' };
import spectrumInboxCss from '../ui/spectrum-inbox.css' with { type: 'text' };
import spectrumAdminCss from '../ui/spectrum-admin.css' with { type: 'text' };
import spectrumAgentCss from '../ui/spectrum-agent.css' with { type: 'text' };
import spectrumKbchatCss from '../ui/spectrum-kbchat.css' with { type: 'text' };
import spectrumOverviewCss from '../ui/spectrum-overview.css' with { type: 'text' };
import spectrumCogsCss from '../ui/spectrum-cogs.css' with { type: 'text' };
import spectrumTopicsCss from '../ui/spectrum-topics.css' with { type: 'text' };
import { inboxPage, page } from './page.js';

/** ui/*.js and ui/*.css by file name, as src/page.js takes them. */
export const SCRIPTS = {
  'inbox.js': inboxJs,
  'admin.js': adminJs,
  'agent.js': agentJs,
  'cogs.js': cogsJs,
  'topics.js': topicsJs,
  'app.js': appJs,
  'header.js': headerJs,
  'rank.js': rankJs,
  'table.js': tableJs,
  'writing.js': writingJs,
  'stack.js': stackJs,
  'notifyhelp.js': notifyHelpJs,
  'tour.js': tourJs,
  'follow.js': followJs,
  'followsuggest.js': followSuggestJs,
  'topicgraph.js': topicGraphJs,
  'topicspace.js': topicSpaceJs,
  'topicview.js': topicViewJs,
  'trends.js': trendsJs,
  'trendview.js': trendViewJs,
  'overview.js': overviewJs,
  'team.js': teamJs,
  'customer.js': customerJs,
  'kbchat.js': kbchatJs,
  'person.js': personJs,
  'sidenav.js': sideNavJs,
  'review.js': reviewJs,
  'spectrum-fonts.css': spectrumFontsCss,
  'spectrum.css': spectrumCss,
  'spectrum-inbox.css': spectrumInboxCss,
  'spectrum-admin.css': spectrumAdminCss,
  'spectrum-agent.css': spectrumAgentCss,
  'spectrum-kbchat.css': spectrumKbchatCss,
  'spectrum-overview.css': spectrumOverviewCss,
  'spectrum-cogs.css': spectrumCogsCss,
  'spectrum-topics.css': spectrumTopicsCss,
};
export const INBOX_PAGE = inboxPage(inboxHtml, SCRIPTS);
export const ADMIN_PAGE = page(adminHtml, SCRIPTS);
export const COGS_PAGE = page(cogsHtml, SCRIPTS);
export const TOPICS_PAGE = page(topicsHtml, SCRIPTS);

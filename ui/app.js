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

// Installable app (see src/pwa.js): the service worker only answers page loads made offline.
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
// iOS opens its on-screen keyboard over the page and moves the page up, header and all, to show
// the text field: it scrolls the page and pans what is shown of it (interactive-widget it
// ignores). While the keyboard is open the page is as tall as what is left above it and follows
// that, so the header stays on screen; html.keyboard drops the home indicator's inset, which the
// keyboard covers.
if (window.visualViewport && matchMedia('(hover: none) and (pointer: coarse)').matches) {
  const vv = window.visualViewport;
  const root = document.documentElement;
  const fit = () => {
    const open = vv.height < root.clientHeight - 100;
    root.classList.toggle('keyboard', open);
    root.style.setProperty('--app-height', open ? `${Math.round(vv.height)}px` : '');
    root.style.setProperty('--app-top', open ? `${Math.round(vv.pageTop)}px` : '');
  };
  vv.addEventListener('resize', fit);
  vv.addEventListener('scroll', fit);
}

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

import { underlying } from './d1batch.js';

/*
 * What an isolate keeps for a while, loaded from D1: kept by the D1 binding under the request's
 * wrappers (`underlying`), so every request of the isolate finds it.
 *
 * Only what has been loaded is shared between requests, never a load on its way: in Workers, a
 * promise belongs to the request that made it, and one that ended (answered, or cancelled) takes
 * its I/O with it, so a request awaiting another's load could wait forever ("A promise was
 * resolved or rejected from a different request context"). So a request that finds nothing
 * loaded loads it itself, and requests that come together each do, once; the queries asked for
 * together within one request (its `env.DB`) share one load.
 */
export function isolateCache(ms) {
  let kept = null; // { db, at, value }: loaded
  let loading = null; // { db, owner, promise }: on its way, in the request `owner`
  let forgotten = 0; // a load from before `forget()` is not kept
  return {
    /** The value, kept for `ms`; else `load(env)`, in this request. `fresh`: load anew. */
    get(env, load, { fresh = false } = {}) {
      const db = underlying(env.DB);
      if (!fresh && kept && kept.db === db && Date.now() - kept.at < ms) {
        return Promise.resolve(kept.value);
      }
      if (!fresh && loading && loading.db === db && loading.owner === env.DB) {
        return loading.promise;
      }
      const at = Date.now();
      const since = forgotten;
      const mine = { db, owner: env.DB };
      mine.promise = Promise.resolve().then(() => load(env)).then((value) => {
        if (since === forgotten && (!kept || kept.db !== db || kept.at <= at)) {
          kept = { db, at, value };
        }
        return value;
      }).finally(() => {
        if (loading === mine) {
          loading = null;
        }
      });
      loading = mine;
      return mine.promise;
    },
    /** Forgets what was kept and what is on its way. */
    forget() {
      kept = null;
      loading = null;
      forgotten += 1;
    },
  };
}

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

const RUNS = new Set(['first', 'all', 'run', 'raw']);

function timedStatement(stmt, timing, originals) {
  const proxy = new Proxy(stmt, {
    get(target, prop) {
      const v = Reflect.get(target, prop);
      if (typeof v !== 'function') {
        return v;
      }
      if (prop === 'bind') {
        return (...args) => timedStatement(v.apply(target, args), timing, originals);
      }
      if (RUNS.has(prop)) {
        return (...args) => timing.time('d1', () => v.apply(target, args));
      }
      return v.bind(target);
    },
  });
  originals.set(proxy, stmt);
  return proxy;
}

function timedDatabase(db, timing) {
  const originals = new WeakMap();
  return new Proxy(db, {
    get(target, prop) {
      const v = Reflect.get(target, prop);
      if (typeof v !== 'function') {
        return v;
      }
      if (prop === 'prepare') {
        return (...args) => timedStatement(v.apply(target, args), timing, originals);
      }
      if (prop === 'batch') {
        // One round trip, so one call; D1 wants its own statements back.
        return (stmts, ...rest) => timing.time('d1', () => v.call(
          target,
          stmts.map((s) => originals.get(s) || s),
          ...rest,
        ));
      }
      if (prop === 'exec') {
        return (...args) => timing.time('d1', () => v.apply(target, args));
      }
      return v.bind(target);
    },
  });
}

/** An R2 object whose body reads count as R2 time too. */
function timedObject(obj, timing) {
  if (!obj || typeof obj.text !== 'function') {
    return obj;
  }
  return new Proxy(obj, {
    get(target, prop) {
      const v = Reflect.get(target, prop);
      if (typeof v === 'function' && (prop === 'text' || prop === 'json' || prop === 'arrayBuffer')) {
        return (...args) => timing.time('r2', () => v.apply(target, args));
      }
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

function timedBucket(bucket, timing) {
  return new Proxy(bucket, {
    get(target, prop) {
      const v = Reflect.get(target, prop);
      if (typeof v !== 'function') {
        return v;
      }
      if (prop === 'get') {
        return async (...args) => timedObject(
          await timing.time('r2', () => v.apply(target, args)),
          timing,
        );
      }
      if (prop === 'list' || prop === 'head' || prop === 'put' || prop === 'delete') {
        return (...args) => timing.time('r2', () => v.apply(target, args));
      }
      return v.bind(target);
    },
  });
}

/**
 * Where a request's time goes, as a `Server-Timing` header: how long D1 and R2 were busy
 * (the time at least one call was in flight, so parallel calls are not counted twice), how
 * many calls each took and in how many rounds (calls in flight together are one round; each
 * round waited for the one before), and the total. Durations and counts only: no keys, ids
 * or content.
 *
 * In a Worker, clocks only move on I/O, so CPU time does not show up here; I/O does.
 */
export class Timing {
  constructor(now = () => performance.now()) {
    this.now = now;
    this.start = now();
    this.stores = {};
    this.marks = [];
  }

  /** `fn()` as one call to `store` (`d1`, `r2`). */
  async time(store, fn) {
    const s = this.stores[store] || (this.stores[store] = {
      busy: 0, calls: 0, rounds: 0, active: 0, since: 0,
    });
    s.calls += 1;
    if (s.active === 0) {
      s.since = this.now();
      s.rounds += 1;
    }
    s.active += 1;
    try {
      return await fn();
    } finally {
      s.active -= 1;
      if (s.active === 0) {
        s.busy += this.now() - s.since;
      }
    }
  }

  /** A named step that ended now (`auth`: who is asking), measured from the start. */
  mark(name) {
    this.marks.push([name, this.now() - this.start]);
  }

  /** `env` with D1 (`DB`) and the pile-2 bucket (`CHANNELS`) timed; everything else as is. */
  wrap(env) {
    if (!env || env.timing === this) {
      return env;
    }
    return {
      ...env,
      timing: this,
      ...(env.DB ? { DB: timedDatabase(env.DB, this) } : {}),
      ...(env.CHANNELS ? { CHANNELS: timedBucket(env.CHANNELS, this) } : {}),
    };
  }

  header() {
    const ms = (v) => Math.round(v * 10) / 10;
    const parts = this.marks.map(([name, d]) => `${name};dur=${ms(d)}`);
    for (const [name, s] of Object.entries(this.stores)) {
      const busy = s.busy + (s.active ? this.now() - s.since : 0);
      const calls = `${s.calls} ${s.calls === 1 ? 'call' : 'calls'}`;
      const rounds = `${s.rounds} ${s.rounds === 1 ? 'round' : 'rounds'}`;
      parts.push(`${name};dur=${ms(busy)};desc="${calls} in ${rounds}"`);
    }
    parts.push(`total;dur=${ms(this.now() - this.start)}`);
    return parts.join(', ');
  }
}

/** Adds the `Server-Timing` header to a response (a new one if its headers are immutable). */
export function withTiming(response, timing) {
  if (!response || !timing) {
    return response;
  }
  // A WebSocket upgrade (status 101) is passed on untouched.
  if (response.status === 101 || response.webSocket) {
    return response;
  }
  try {
    response.headers.set('server-timing', timing.header());
    return response;
  } catch {
    const copy = new Response(response.body, response);
    copy.headers.set('server-timing', timing.header());
    return copy;
  }
}

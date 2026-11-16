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

/**
 * TCP out of an agent's computer on the SLICC kernel (src/agent/kernel.js): the kernel's
 * uplink (`network.uplink`), over the Worker's own sockets (`connect` from
 * `cloudflare:sockets`, passed in by src/agent/agent.js, so this is tested in Node).
 *
 * Everything else a program sends leaves through the kernel's proxy and the SecretGateway
 * (src/agent/gateway.js), as HTTP. This is for what HTTP cannot show: a site's own TLS, its
 * certificate chain as the site sends it (`openssl s_client`). So it dials only UPLINK_PORTS,
 * and a program reaches any other port of an outside address as an unreachable network. The
 * gateway does not see these bytes, and so cannot put a secret into them: a program holds
 * only a secret's placeholder, never its value, and a TLS stream carries the placeholder.
 *
 * Names resolve over DNS over HTTPS (`fetch`, the gateway's, to cloudflare-dns.com), as dig
 * asks. The kernel itself keeps loopback, link-local and other reserved addresses from the
 * uplink, and Cloudflare refuses sockets into private networks and its own addresses.
 */

export const UPLINK_PORTS = [443];
export const DOH_JSON = 'https://cloudflare-dns.com/dns-query';

const errno = (code, message) => Object.assign(new Error(message || code), { code });

/** The errno a failed `connect` means, by Cloudflare's message (the kernel takes these). */
export function errnoOf(e) {
  const message = String((e && e.message) || e);
  if (/refused/i.test(message)) {
    return 'ECONNREFUSED';
  }
  if (/timed? ?out/i.test(message)) {
    return 'ETIMEDOUT';
  }
  if (/reset/i.test(message)) {
    return 'ECONNRESET';
  }
  return 'EHOSTUNREACH';
}

/** `host:port`, as the kernel reads an address (IPv6 in brackets). */
const named = (host, port) => `${host.includes(':') ? `[${host}]` : host}:${port}`;
const isAddress = (text) => /^\[?[^\]]*\]?:\d{1,5}$/.test(String(text || ''));

/**
 * The uplink: `connect(address, options)` opens a socket (`cloudflare:sockets`), `fetch(url,
 * init)` asks DNS over HTTPS. IPv4 only: a Worker's sockets take an IPv6 address no better
 * than the kernel's routes do yet.
 */
export function socketUplink({ connect, fetch, ports = UPLINK_PORTS }) {
  return {
    traits: { tcp: true, udp: false, ipv6: false },
    routes: { prefixes: [], exit: true },

    async resolve(name, family, signal) {
      if (family === 6) {
        return [];
      }
      const url = `${DOH_JSON}?name=${encodeURIComponent(name)}&type=A`;
      const res = await fetch(url, { headers: { accept: 'application/dns-json' }, signal });
      if (!res.ok) {
        return [];
      }
      const body = await res.json().catch(() => ({}));
      const answers = (body.Answer || []).filter((a) => a.type === 1
        && /^\d{1,3}(\.\d{1,3}){3}$/.test(a.data));
      return answers.length
        ? {
          addresses: answers.map((a) => a.data),
          ttl: Math.min(...answers.map((a) => Number(a.TTL) || 60)),
        }
        : [];
    },

    async dial({ host, port, signal }) {
      if (!ports.includes(port)) {
        throw errno('ENETUNREACH', `only port ${ports.join(', ')} leaves this computer`);
      }
      let socket;
      try {
        socket = connect({ hostname: host, port }, { secureTransport: 'off', allowHalfOpen: true });
      } catch (e) {
        throw errno(errnoOf(e), e.message);
      }
      const abort = () => socket.close().catch(() => {});
      if (signal) {
        signal.addEventListener('abort', abort, { once: true });
      }
      let info;
      try {
        info = await socket.opened;
      } catch (e) {
        throw errno(errnoOf(e), e.message);
      } finally {
        if (signal) {
          signal.removeEventListener('abort', abort);
        }
      }
      const reader = socket.readable.getReader();
      const writer = socket.writable.getWriter();
      return {
        localAddr: isAddress(info && info.localAddress) ? info.localAddress : named('0.0.0.0', 0),
        remoteAddr: isAddress(info && info.remoteAddress) ? info.remoteAddress : named(host, port),
        async read() {
          try {
            const { value, done } = await reader.read();
            return done ? null : value;
          } catch (e) {
            throw errno(errnoOf(e), e.message);
          }
        },
        async write(bytes) {
          try {
            await writer.write(bytes);
          } catch (e) {
            throw errno(errnoOf(e), e.message);
          }
          return bytes.length;
        },
        closeWrite() {
          writer.close().catch(() => {});
        },
        close() {
          socket.close().catch(() => {});
        },
      };
    },
  };
}

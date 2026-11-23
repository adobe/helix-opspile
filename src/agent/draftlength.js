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
 * How long a draft is next to the replies Adobe staff write themselves, for update_draft
 * (src/agent/tools.js): a person sends the draft as their own, so it should read like one of
 * theirs. Staff replies' lengths are log-normal, so they are compared by the logarithm of their
 * characters: within one standard deviation a draft is saved as usual, beyond one it is saved
 * with a warning, and beyond two it is not saved. post_message, which no person reads first, is
 * stricter on length: a post longer than one standard deviation is refused (a longer reply goes
 * into the draft), and a short one is fine (an acknowledgement, a status).
 *
 * MU and SIGMA are the mean and standard deviation of ln(characters) of 679 messages Adobe staff
 * wrote in production threads (Markdown as stored, no bots or system messages; November 2026).
 * Their median is 140 characters; the agents' drafts then had a median of about 950.
 */
export const MU = 4.955;
export const SIGMA = 1.219;

/** The characters a draft of `z` standard deviations from the mean has, rounded. */
const charsAt = (z) => Math.round(Math.exp(MU + z * SIGMA));

/** Lengths of a typical staff reply (one standard deviation) and of the limits (two). */
export const TYPICAL = [charsAt(-1), charsAt(1)];
export const LIMITS = [charsAt(-2), charsAt(2)];

/**
 * Where `text` stands: `{ chars, z, verdict }`, with `verdict` `ok` (within one standard
 * deviation of staff replies: TYPICAL), `warn` (within two: LIMITS) or `fail` (beyond two).
 * The bounds are in whole characters, so that what the agent is told is what is checked.
 */
export function draftLength(text) {
  const chars = String(text || '').trim().length;
  const z = (Math.log(Math.max(chars, 1)) - MU) / SIGMA;
  let verdict = 'ok';
  if (chars < LIMITS[0] || chars > LIMITS[1]) {
    verdict = 'fail';
  } else if (chars < TYPICAL[0] || chars > TYPICAL[1]) {
    verdict = 'warn';
  }
  return { chars, z: Math.round(z * 100) / 100, verdict };
}

/**
 * What the agent is told of a draft's length, or '' when it is typical: for `warn`, a sentence to
 * add to the save's answer; for `fail`, why nothing was saved.
 */
export function lengthNote({ chars, z, verdict }) {
  if (verdict === 'ok') {
    return '';
  }
  const longer = z > 0;
  const typical = `the replies Adobe staff write (most are ${TYPICAL[0]} to ${TYPICAL[1]})`;
  if (verdict === 'warn') {
    return longer
      ? `The draft is ${chars} characters, longer than ${typical}. Shorten it if you can: the answer and what the customer has to do, without the background the sources already hold.`
      : `The draft is ${chars} characters, shorter than ${typical}. Check that it says enough to stand on its own.`;
  }
  return longer
    ? `The draft is ${chars} characters, far longer than ${typical}, and over the ${LIMITS[1]} a draft may have. Nothing was saved. Shorten it to the answer and what the customer has to do, leave the background to the sources and the knowledge bases, and save it again.`
    : `The draft is ${chars} characters, far shorter than ${typical}, and under the ${LIMITS[0]} a draft needs. Nothing was saved. Write a reply that stands on its own, or save no draft when nothing needs saying.`;
}

/**
 * Why post_message refuses `text`, or '' when it may be posted: longer than a typical staff reply
 * (TYPICAL), it goes into the draft instead, where a person reads it first. Short is fine.
 */
export function postLengthNote(text) {
  const chars = String(text || '').trim().length;
  if (chars <= TYPICAL[1]) {
    return '';
  }
  return `The reply is ${chars} characters, longer than you may post yourself: ${TYPICAL[1]}, as most replies Adobe staff write are ${TYPICAL[0]} to ${TYPICAL[1]}. Nothing was posted. Post a shorter reply, or put this one into the draft (update_draft) for a person to review.`;
}

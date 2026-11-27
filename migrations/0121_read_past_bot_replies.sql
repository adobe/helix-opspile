-- Read state from before bots' replies counted (src/threads.js unreadInYours, ANSWERS_ME).
--
-- Until then the inbox read a channel's thread up to its last person's message (`last_at`), and a
-- bot's reply after it was nobody's to read. Now a bot's answer to you makes the thread unread
-- for you until you have read up to it (`any_at`), so every old thread where the admins' bot
-- answered your `@admin-bot add` came back unread, months later, after it had been read. A
-- watermark that had read everything people said is moved past the bots' replies that followed.
UPDATE watermarks SET
  read_at = (SELECT t.any_at FROM threads t WHERE t.thread = watermarks.thread),
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE EXISTS (SELECT 1 FROM threads t WHERE t.thread = watermarks.thread
  AND t.kind != 'alert' AND t.last_at IS NOT NULL AND t.any_at > t.last_at
  AND watermarks.read_at >= t.last_at AND watermarks.read_at < t.any_at);

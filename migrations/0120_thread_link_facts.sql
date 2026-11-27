-- Threads possibly about the same issue, found by the facts they share too (src/threadlinks.js,
-- src/factweights.js): `facts`, how much the facts both threads name say together (each value
-- weighed by its field and how rare it is in the inbox, tf-idf; 0 to 1, null where they share
-- none that weighs), and `shared`, those facts as JSON (`[{ field, value, w }]`, the heaviest
-- first), the values as this thread's facts have them. A pair of two customers' threads is a
-- candidate only by its facts; one a partner of both explains (its sandbox, its tooling) is none.
ALTER TABLE thread_links ADD COLUMN facts REAL;
ALTER TABLE thread_links ADD COLUMN shared TEXT;

-- A lease on re-filing a channel (src/refile.js): one `refile` job at a time moves a channel's
-- thread folders. Two at once, classifying it differently (a rule deleted, then another made a
-- minute later), each wrote its own team into the rows while the other moved the files, so rows
-- pointed at folders whose files were elsewhere and threads showed no messages. A job takes the
-- lease (`refile_by`, its own token, until `refile_until`) before it reads the rules, and gives
-- it back when it is done; one that finds it taken waits and runs again. A job that dies keeps it
-- until `refile_until`, no longer than a queue consumer can run.
ALTER TABLE channels ADD COLUMN refile_by TEXT;
ALTER TABLE channels ADD COLUMN refile_until TEXT;

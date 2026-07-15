// Patches gramJS (telegram) client/updates.js so an unrecognized TL
// constructor (TypeNotFoundError) does not force a full reconnect every time
// it happens. Telegram periodically ships update types gramJS doesn't know
// about yet; without this patch each occurrence calls client._sender.reconnect(),
// destabilizing the persistent session (repeated TIMEOUT errors in the logs)
// and risking interference with exports running on the same account.
//
// Matches on the error's `invalidConstructorId` property (unique to
// TypeNotFoundError) instead of a message substring. The previous patch
// checked err.message for "was not found!" / "TypeNotFoundError", but
// TypeNotFoundError's actual message text
// ("Could not find a matching Constructor ID for the TLObject...") never
// contains either string, so the old patch silently never matched.
const fs = require("fs");
const path = "/app/node_modules/telegram/client/updates.js";
const MARKER = "invalidConstructorId !== undefined";

let contents;
try {
  contents = fs.readFileSync(path, "utf8");
} catch (e) {
  console.warn("gramJS patch: could not read " + path + " — " + e.message);
  process.exit(0);
}

if (contents.includes(MARKER)) {
  console.log("gramJS patch already up to date");
  process.exit(0);
}

const patchedBlock = `        catch (err) {
            // PATCH: ignore TypeNotFoundError (unknown TL constructors) — keep connection alive
            if (err && err.invalidConstructorId !== undefined) {
                lastPongAt = Date.now();
                continue;
            }
            // eslint-disable-next-line no-console`;

// Matches the old (broken) patch attempt, so it gets replaced in place.
const oldBrokenPatch = / {8}catch \(err\) \{\n {12}\/\/ PATCH: ignore TypeNotFoundError[\s\S]*?continue;\n {12}\}\n {12}\/\/ eslint-disable-next-line no-console/;
// Matches the pristine, never-patched file.
const pristineBlock = `        catch (err) {
            // eslint-disable-next-line no-console`;

if (oldBrokenPatch.test(contents)) {
  contents = contents.replace(oldBrokenPatch, patchedBlock);
  fs.writeFileSync(path, contents);
  console.log("gramJS patch upgraded (now matches invalidConstructorId)");
} else if (contents.includes(pristineBlock)) {
  contents = contents.replace(pristineBlock, patchedBlock);
  fs.writeFileSync(path, contents);
  console.log("gramJS patched (matches invalidConstructorId)");
} else {
  console.warn("gramJS patch: expected catch block not found, skipped");
}

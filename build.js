// Fetches the Dragon Lounge public calendar and writes events.json.
// Runs on a schedule in CI so the website always has fresh dates.
import { writeFileSync } from "node:fs";
import { fetchLiveEvents } from "./calendar.js";

const events = await fetchLiveEvents();
writeFileSync(
  "events.json",
  JSON.stringify({ events, updatedAt: new Date().toISOString() }, null, 1) + "\n",
);
console.log(`wrote ${events.length} upcoming events`);
for (const e of events) console.log(`  ${e.start.slice(0, 10)}  ${e.title}`);

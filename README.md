# hash telemetry

The ingest and the public page behind [hash.doomods.com](https://hash.doomods.com).

> 🛟 **Need help or found a bug?** Get support at [support.doodesch.de/hash](https://support.doodesch.de/hash).

[hash](https://www.nexusmods.com/schedule1/mods/2408) turns `# give me five OG Kush` into `give ogkush 5`
using a 45 MB model that ships with the mod and runs offline. That model was trained on requests another model
was asked to invent, and it is judged against 79 hand-written cases - too few to tell apart three training runs
that scored 14, 16 and 18 of them. Real requests fix the measurement and the training data at once.

## What arrives here

hash writes every `# ` request to `UserData/Hash/queries.jsonl` on the player's own machine, always. It uploads
that file only while `NeedleShareUsage` is on, and clears it only after this service confirms it has the records.

One record:

```json
{"query":"bring mich nach hause","commands":["teleport mayor"],"confidence":null,"proven":false,
 "constrained":false,"error":"","outcome":"corrected","actual":"teleport #home"}
```

`outcome` is what closed the record: `accepted`, `rejected` (the console returned an error), `corrected` (the
player typed a command themselves straight afterwards - it is in `actual`), or `retried` (it failed and they
asked again). A `rejected` or `corrected` line usually carries the right answer beside the wrong one, which is
worth more than ten unlabelled queries.

No account, no session, no id, no IP kept, and no timestamp finer than the day a record is filed under.

## What the page shows

Counts, the outcome split, the command words hash produced, and the correction pairs - `settime -> setweather`
and the like. **Command words only.** What a player typed stays in the records and is never rendered.

## API

| | |
|---|---|
| `POST /api/telemetry` | `{mod, version, game, records[]}`, at most `MAX_RECORDS` (5000) per upload |
| `GET /api/stats` | the aggregates the page reads |
| `GET /health` | liveness |

An unwritable volume answers 500 and an oversized batch answers 413 rather than dropping the payload: the mod
clears the player's copy when this answers 200, and there is only the one copy.

## Running it

```sh
npm install
DATA_DIR=./data npm start
```

`DATA_DIR` holds `records/<mod>-<version>-<day>.jsonl` and `counters.json`. The counters are an index, not the
source: delete them and they rebuild from the next upload, or regenerate them from the records.

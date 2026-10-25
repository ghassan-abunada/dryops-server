---
version: 1
slug: "wipdash-js"
primary_target: "wipDash.js"
related_targets: ["wipPdf.js"]
---

# Surface brief: WIP manager dashboard (`/wip/master/<token>`, dryops-server wipDash.js)

Scope: the manager's page over several locations (and the owner's all-locations page), desktop first, opened Monday morning; the admin portal (`/wip/admin/<token>`) inherits its table grammar. Visitor mode: Operate.
Audience: a manager overseeing several locations. Job: see each location's week and fix what is missing. Task per location: read In Progress (jobs, estimated $), Collecting next week (jobs, $), bank balance (edit it in the row), AR; open the form, share, run the notes review, download the PDF.
Content: per-location numbers from the owner forms and JobNimbus; whether the owner has sent; the review state. Constraints (user-pinned): each location is viewed separately, no totals across locations, only those four numbers on the main view. Last week's collected and invoiced, forecast accuracy and estimate accuracy stay available but out of the way.
Memorable moment: a bank balance typed straight into the row and saved, no form.
Unresolved: none.

## Direction contract

THESIS: One table, one row per location, four numbers and the bank field, and nothing else above the fold. It refuses the KPI-tile-strip-plus-analysis-panels dashboard the category ships.

OWN-WORLD: DryOps Dispatch Board on desktop: the single dark web bar, a light 48px page row with the manager's name and labelled actions, slate ground, a white hairline table with 11px uppercase column labels, 15px tabular figures, status strips on the location cell, an Ocean Blue primary. Rows with something missing carry an amber cell, never a red banner.

STORY: The manager opens the link, reads down the Location column, sees at a glance which rows have an amber cell (no bank balance, nothing sent, a job without a value), types the balance into the row, opens a form or shares a report from the row's actions, and leaves. Last week and accuracy live behind one collapsed "Last week and accuracy" section at the end.

FIRST VIEWPORT: Page row: "WIP · Sam Rivera", "3 locations · week of Oct 26", actions Review all AR notes · PDF · Share all. Then the table: Location (logo chip, name, owner, sent Sun 7:40 PM) · In Progress (3 jobs · $20,000, amber sub-line "1 needs a number") · Collecting next week (2 jobs · $1,235) · Bank balance (editable field with "entered 10/23 by Sam") · AR ($8,435) · actions (Open form, Share, Review notes, PDF). No totals row. The review progress bar appears under the table when a review runs. The admin portal keeps the same table language for managers and locations.

FORM: User-pinned per-location table; the roll (seed:37370a80887be459) dealt the forecast ledger, needs-you-first and the week timeline, and the user's brief overrode the hand with this structure. Signature interaction: the bank field saves on blur and the amber cell turns quiet in place; rows that changed since the last visit (owner sent, review ran) hold a faint tint until opened (kept from the gate-board challenger). Motion grammar: 150ms colour transitions only.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

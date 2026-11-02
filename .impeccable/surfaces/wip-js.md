---
version: 1
slug: "wip-js"
primary_target: "wip.js"
related_targets: []
---

# Surface brief: WIP owner form (`/wip/<token>`, dryops-server wip.js)

Scope: the weekly owner form, phone, filled Saturday or Sunday in about two minutes. Visitor mode: Operate.
Audience: a location owner, often one-handed, sometimes gloved. Job: give the franchisor the week's numbers. Task: (1) type what each In Progress job is worth, (2) verify what the Saturday review says will arrive this week and add out-of-pocket jobs that will pay, (3) type today's bank balance, then send the text.
Content: the location's In Progress jobs (JobNimbus), the review's Collecting proposals with their reasons, AR from JobNimbus, the bank balance, the report text. Constraints: plain words (brand commitment), DryOps world fixed (DESIGN.md), autosave, no login (token link), the text goes to the franchisor by SMS.
Memorable moment: finishing. The form ends on the exact text that will be sent and a "Sent" state, not on a blank page.
Unresolved: none. Report text format is redesigned in this build (user chose to redesign it).

## Direction contract

THESIS: The form asks exactly the two things it needs, one per screen, then shows the text and sends. It refuses the category default of one long scrolling form with totals on top and sections to hunt through.

OWN-WORLD: DryOps Dispatch Board: Charcoal Navy header band with the location logo, slate ground, white hairline cards with a 4px status strip (blue In Progress, green Collecting, amber needs-a-number), Ocean Blue as the only action colour, heavy system type at small sizes, 11px uppercase labels, 44px fields and buttons, bottom action bar in the thumb zone. No sage green, no gradients, no shadows beyond the sheet scrim.

STORY: The owner opens the link Sunday night, sees "Step 1 of 3 · Job values", types a number into each amber card until none are amber, taps Next, confirms or changes what the review says is coming in, flips "paying this week" on an out-of-pocket job, taps Next, types the bank balance, reads the exact text, taps Send, and sees "Sent 7:40 PM".

FIRST VIEWPORT: Navy header: logo chip, location name, a three-segment progress strip, "Step 1 of 3 · Job values" with the next steps named. Below: the headline "What is each job worth?", one line of help, then one card per In Progress job: name, status, an OOP tag where insurance_type is not Insurance, one 44px decimal field, and on OOP jobs a "Paying this week? put it under Collecting" switch. Cards with no value are amber. Bottom bar: running In Progress total on the left, Ocean Blue "Next" on the right.

FORM: Two steps and send, dealt structure (my ranked candidate 1, dealt third); seed:b519e335cfb0b8b4. Signature interaction: cards turn from amber to blue as numbers land, the step strip fills, and Collecting rows the review changed stay lit until answered (raise from the gate-board challenger). Motion grammar: 150ms colour transitions, sheet slides; nothing else moves.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

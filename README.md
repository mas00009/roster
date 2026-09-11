# Roster

A shared team roster, open to anyone with the link. Static page on GitHub Pages
(`docs/`), data in a public Apps Script web app (`Code.js`), talked to over a
GET JSON API.

- Live: https://mas00009.github.io/roster/
- Shift codes: `PM` 5pm–10pm (full evening cover), `PE` 5pm–8pm (fallback),
  `AM`, `OFF`. Approved leave is derived from the leave list, never stored as a shift.
- Rules checked on the page: max 6 working days in a row; no AM the day after a
  PM; every day needs someone on PM (or at least PE).
- Manager PIN gates shift edits, staff/settings changes and leave approvals.
  Anyone can request leave or submit feedback.

## Deploying

Page: commit to `main`, Pages serves `/docs`. Local test: `python3 -m http.server`
in `docs/` and open `index.html?mock=1` (in-browser mock store).

Store: `clasp push -f`, `clasp create-version "<note>"`, then
`clasp update-deployment -V <n> AKfycbxwzBWM6CodJqxwuUXnrs4X879Dpj1uo9jqFdLYV1mXZ4I0570c6NP4KBnNhiwjT9Ro`.
Never `create-deployment` again: it mints a new URL and the page has this one baked in.

## Feedback loop

`?api=listFeedback` returns change requests from the Feedback tab. A scheduled
agent works off items with status `new`, ships them, then calls
`updateFeedback(agentKey, id, 'done', reply)`. The agent key is in `.agent-key`
(not committed).

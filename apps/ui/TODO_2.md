# UI review (independent pass), 2026-10-28

Branch `ui-review`. Fixture mode on Linux, agent-browser at 1440 and 1100 px, light and dark, live replay (`?t=0`).
Out of scope: `packages/shared`, `apps/ui/src/api/**`, connection code in `apps/ui/src/state/**`.

## Findings

| # | Sev | Finding | Status |
|---|-----|---------|--------|
| 1 | High | Esc in any text field (rename, shell, filters, sampling inputs) also stops the running agent || Fixed |
| 2 | High | Memory bars in model picker and Models view contradict the label: "over budget" bar sits far left of the budget tick (other loaded models not drawn) || Fixed |
| 3 | High | Session header stats truncate mid-word ("2 fail…") at 1100 px and on eval sessions at 1440 || Fixed |
| 4 | High | Context meter shows History 0 for sessions without `context` on the summary (eval cells); window shown as 16.4K next to 16K in the header || Fixed |
| 5 | High | Timeline model-bar labels are white on the light prefill/stripe segments: unreadable || Fixed |
| 6 | Med | Timeline zoom buttons sit on top of the live edge and the end markers || Fixed |
| 7 | Med | "Latest" jump button floats over transcript text in the middle || Fixed |
| 8 | Med | Long tool commands cut to one line in the block header; full command only in a tooltip || Fixed |
| 9 | Med | Chat sessions draw empty Tools/Files/Network lanes; header shows "0 tools" || Fixed |
| 10 | Med | Sidebar env row: no keyboard activation; clicking an expanded env to inspect it collapses it || Fixed |
| 11 | Med | "Show eval forks" icon looks like an unchecked checkbox and never changes || Fixed |
| 12 | Med | Cmd+K: group headers repeat when matches interleave; arrow keys don't scroll; hints run together || Fixed |
| 13 | Med | Shell tab on a stopped env: no way to start it there || Fixed |
| 14 | Med | Dim text below contrast: fg-3 3.1-3.7:1, fg-4 1.9-2.6:1 || Fixed |
| 15 | Med | Home and Models table rows not reachable by keyboard || Fixed |
| 16 | Med | Eval cell fixture transcripts claim success without changing anything; durations don't match the matrix || Fixed |
| 17 | Low | Composer fit hint wording ("Loading goes over budget") || Fixed |
| 18 | Low | Change badge unreadable on the selected tree row || Fixed |
| 19 | Low | Eval case result detail truncated with no tooltip || Fixed |
| 20 | Low | Harness menu and Env tab carry explanatory filler ("for comparison", "100% = 1 core") || Fixed |
| 21 | Low | Fixture shell treats `;` as part of a file name || Fixed |
| 22 | Low | Header "tok" total is ambiguous (sum of prompt + output over all calls) || Fixed |

| 23 | Med | Models table at 1100 px pushes Memory, State and Load/Unload off screen | Fixed |
| 24 | Med | Eval matrix at 1100 px cuts off the third model column | Fixed |
| 25 | Med | Stopped or max-turns runs had no Continue (builder notes promised one) | Fixed |
| 26 | Med | Streamed tool-call args shown as one escaped JSON line (`\n` everywhere) | Fixed |
| 27 | Low | Raw JSON: collapsed messages say only "3 keys" | Fixed |
| 28 | Low | Network row: full URL, IP, bytes only in tooltips | Fixed |
| 29 | Low | Files step label lacked the tool name and step count | Fixed |
| 30 | Low | New env facts said "gathered 2h ago" (fixture copied the source's timestamp) | Fixed |

## Notes

- Vite sometimes serves a CSS file empty when it is rewritten mid-read; `touch` the file and reload.
- Running `pnpm` here rewrites `pnpm-lock.yaml` (packageManagerDependencies); revert before committing.
- Left alone: Enter inserts a newline and Cmd+Enter sends (dev-tool convention, labeled on the button); timeline bars are mouse-only (every bar has a transcript row with the same actions); New environment has no seed-files input (contract supports it; feature, not polish).

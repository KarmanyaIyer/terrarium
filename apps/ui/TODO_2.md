# UI review (independent pass), 2026-10-28

Branch `ui-review`. Fixture mode on Linux, agent-browser at 1440 and 1100 px, light and dark, live replay (`?t=0`).
Out of scope: `packages/shared`, `apps/ui/src/api/**`, connection code in `apps/ui/src/state/**`.

## Findings

| # | Sev | Finding | Status |
|---|-----|---------|--------|
| 1 | High | Esc in any text field (rename, shell, filters, sampling inputs) also stops the running agent | |
| 2 | High | Memory bars in model picker and Models view contradict the label: "over budget" bar sits far left of the budget tick (other loaded models not drawn) | |
| 3 | High | Session header stats truncate mid-word ("2 fail…") at 1100 px and on eval sessions at 1440 | |
| 4 | High | Context meter shows History 0 for sessions without `context` on the summary (eval cells); window shown as 16.4K next to 16K in the header | |
| 5 | High | Timeline model-bar labels are white on the light prefill/stripe segments: unreadable | |
| 6 | Med | Timeline zoom buttons sit on top of the live edge and the end markers | |
| 7 | Med | "Latest" jump button floats over transcript text in the middle | |
| 8 | Med | Long tool commands cut to one line in the block header; full command only in a tooltip | |
| 9 | Med | Chat sessions draw empty Tools/Files/Network lanes; header shows "0 tools" | |
| 10 | Med | Sidebar env row: no keyboard activation; clicking an expanded env to inspect it collapses it | |
| 11 | Med | "Show eval forks" icon looks like an unchecked checkbox and never changes | |
| 12 | Med | Cmd+K: group headers repeat when matches interleave; arrow keys don't scroll; hints run together | |
| 13 | Med | Shell tab on a stopped env: no way to start it there | |
| 14 | Med | Dim text below contrast: fg-3 3.1-3.7:1, fg-4 1.9-2.6:1 | |
| 15 | Med | Home and Models table rows not reachable by keyboard | |
| 16 | Med | Eval cell fixture transcripts claim success without changing anything; durations don't match the matrix | |
| 17 | Low | Composer fit hint wording ("Loading goes over budget") | |
| 18 | Low | Change badge unreadable on the selected tree row | |
| 19 | Low | Eval case result detail truncated with no tooltip | |
| 20 | Low | Harness menu and Env tab carry explanatory filler ("for comparison", "100% = 1 core") | |
| 21 | Low | Fixture shell treats `;` as part of a file name | |
| 22 | Low | Header "tok" total is ambiguous (sum of prompt + output over all calls) | |

## Notes

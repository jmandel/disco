# Swag Labs — variability ledger

| # | step | observed | n | suspected variation | resolving experiment |
|---|---|---|---|---|---|
| 1 | login | `standard_user` reaches inventory | 1 | `locked_out_user` is blocked; `problem_user`/`performance_glitch_user` behave differently | run `login` as each alternate user; capture the error / timing / broken UI |
| 2 | inventory | 6 items, DOM-only | 1 | sort dropdown reorders; `problem_user` shows broken images | drive the sort; `diffTrace` standard vs problem user |
| 3 | checkout | total `$32.39` for 1 backpack | 1 | tax/total math across item sets | add multiple items; check the summary math |
| 4 | wire | only analytics XHR (401) | 1 | none expected — the app has no data API | (confirmed; note only) |

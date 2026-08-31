// The action kinds — ONE row each: does it need a target selector? which in-page task event marks its
// dispatch (attribution's "task" tier, GUIDANCE §4.4)? The dispatch itself is the switch in act.ts; adding
// a kind = a row here + a case there + a sugar method in client.ts. The CLI validates against this table.
export const KINDS = {
  click:       { target: true,  task: "click" },
  rightclick:  { target: true,  task: "contextmenu" },
  dblclick:    { target: true,  task: "click" },
  middleclick: { target: true,  task: "auxclick" },
  hover:       { target: true,  task: "click" },      // no task marker for hover; falls through like before
  type:        { target: true,  task: "input" },      // appends real key events (debounced inputs count keystrokes)
  fill:        { target: true,  task: "input" },      // select-all + type: REPLACES the value ("" clears) — no evaluate() hacks
  press:       { target: false, task: "keydown" },
  scroll:      { target: false, task: "wheel" },
  select:      { target: true,  task: "change" },
  navigate:    { target: false, task: "click" },
  drag:        { target: true,  task: "mouseup" },
} as const;
export type ActKind = keyof typeof KINDS;
export const KIND_NAMES = Object.keys(KINDS) as ActKind[];

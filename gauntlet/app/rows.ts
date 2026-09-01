/**
 * #8 Virtualized list. /api/rows returns all 10,000 rows, but only the
 * visible window (+ overscan) exists in the DOM at any moment. Rows are
 * absolutely positioned inside a tall inner div; the DOM is rebuilt on
 * every scroll event, so node identity is not stable either.
 */
export type Row = { id: number; name: string; group: string };

export const ROW_H = 24;
export const VIEW_H = 400;
export const OVERSCAN = 5;

export function mountVirtualList(host: HTMLElement, rows: Row[]): void {
  host.replaceChildren();
  host.style.height = `${VIEW_H}px`;
  host.scrollTop = 0;

  const inner = document.createElement("div");
  inner.id = "rows-inner";
  inner.style.height = `${rows.length * ROW_H}px`;
  host.appendChild(inner);

  const render = () => {
    const first = Math.max(0, Math.floor(host.scrollTop / ROW_H) - OVERSCAN);
    const last = Math.min(rows.length - 1, Math.ceil((host.scrollTop + VIEW_H) / ROW_H) + OVERSCAN);
    const frag = document.createDocumentFragment();
    for (let i = first; i <= last; i++) {
      const row = rows[i]!;
      const d = document.createElement("div");
      d.className = "row";
      d.dataset.id = String(row.id);
      d.dataset.group = row.group;
      d.style.top = `${i * ROW_H}px`;
      d.textContent = row.name;
      frag.appendChild(d);
    }
    inner.replaceChildren(frag);
  };

  host.addEventListener("scroll", render);
  render();
}

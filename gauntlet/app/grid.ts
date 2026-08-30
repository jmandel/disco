/**
 * #16 Canvas grid. Cells come from /api/grid on load. Clicking a cell redraws
 * with that cell highlighted and the text "selected r,c" painted INSIDE the
 * canvas. No DOM mutation, no network on click — pixels are the only
 * observable signal. window.__gridSelected exists solely for tests.
 */
export type Cell = { r: number; c: number; label: string };
export type GridData = { rows: number; cols: number; cells: Cell[] };

declare global {
  interface Window { __gridSelected: { r: number; c: number } | null }
}

export function mountGrid(canvas: HTMLCanvasElement, data: GridData): void {
  const ctx = canvas.getContext("2d")!;
  const cw = canvas.width / data.cols;
  const ch = canvas.height / data.rows;
  let selected: Cell | null = null;
  window.__gridSelected = null;

  const draw = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = "11px monospace";
    ctx.textBaseline = "top";
    for (const cell of data.cells) {
      const x = cell.c * cw, y = cell.r * ch;
      const isSel = selected !== null && selected.r === cell.r && selected.c === cell.c;
      ctx.fillStyle = isSel ? "#ffd54f" : (cell.r + cell.c) % 2 ? "#f2f2f2" : "#ffffff";
      ctx.fillRect(x, y, cw, ch);
      ctx.strokeStyle = "#333";
      ctx.strokeRect(x + 0.5, y + 0.5, cw - 1, ch - 1);
      ctx.fillStyle = "#333";
      ctx.fillText(cell.label, x + 4, y + 4);
      if (isSel) {
        ctx.fillStyle = "#900";
        ctx.fillText(`selected ${cell.r},${cell.c}`, x + 2, y + ch - 14);
      }
    }
  };

  canvas.addEventListener("click", (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (canvas.width / rect.width);
    const y = (e.clientY - rect.top) * (canvas.height / rect.height);
    const c = Math.floor(x / cw), r = Math.floor(y / ch);
    selected = data.cells.find((cell) => cell.r === r && cell.c === c) ?? null;
    window.__gridSelected = selected ? { r: selected.r, c: selected.c } : null;
    draw();
  });

  draw();
}

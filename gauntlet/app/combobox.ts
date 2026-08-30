/**
 * #17 Keyboard-only combobox. Typing fetches /api/meds?q= and renders a
 * listbox of options that IGNORE the mouse (CSS pointer-events:none plus a
 * mousedown preventDefault). Selection is ArrowDown/ArrowUp + Enter only;
 * Escape closes the list.
 */
export function mountCombobox(
  input: HTMLInputElement,
  list: HTMLUListElement,
  out: HTMLElement,
  fetchMeds: (q: string) => Promise<string[]>,
): void {
  let items: string[] = [];
  let active = -1;
  let seq = 0; // drop out-of-order responses

  const close = () => {
    items = [];
    active = -1;
    list.replaceChildren();
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  };

  const render = () => {
    list.replaceChildren(
      ...items.map((name, i) => {
        const li = document.createElement("li");
        li.id = `med-opt-${i}`;
        li.setAttribute("role", "option");
        li.setAttribute("aria-selected", String(i === active));
        li.textContent = name;
        return li;
      }),
    );
    list.hidden = items.length === 0;
    input.setAttribute("aria-expanded", String(items.length > 0));
    if (active >= 0) input.setAttribute("aria-activedescendant", `med-opt-${active}`);
    else input.removeAttribute("aria-activedescendant");
  };

  input.addEventListener("input", async () => {
    const q = input.value;
    if (!q) { close(); return; }
    const my = ++seq;
    const hits = await fetchMeds(q);
    if (my !== seq) return;
    items = hits;
    active = -1;
    render();
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!items.length) return;
      e.preventDefault();
      active = e.key === "ArrowDown" ? (active + 1) % items.length : (active - 1 + items.length) % items.length;
      render();
    } else if (e.key === "Enter") {
      if (active < 0) return;
      e.preventDefault();
      const name = items[active]!;
      input.value = name; // programmatic: fires no `input` event, so no re-fetch
      out.textContent = `Selected: ${name}`;
      close();
    } else if (e.key === "Escape") {
      close();
    }
  });

  // Belt and braces: even if pointer-events were re-enabled, the mouse does nothing.
  list.addEventListener("mousedown", (e) => e.preventDefault());
  list.addEventListener("click", (e) => e.preventDefault());
}

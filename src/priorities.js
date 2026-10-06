import { PRIORITIES, DEFAULT_PRIORITY_ORDER, validatePriorityOrder, movePriority } from "./objective.js";

/** Keyed, accessible reordering; the application/controller remains the source of truth. */
export class Priorities {
  constructor(container, { getOrder, onChange, resetButton, announcement }) {
    this.container = container;
    this.document = container.ownerDocument;
    this.getOrder = getOrder;
    this.onChange = onChange;
    this.resetButton = resetButton;
    this.announcement = announcement;
    this.rows = new Map();
    this.order = [];
    this.dragged = null;
    for (const priority of PRIORITIES) {
      const row = this.element("li", "priority-item");
      row.dataset.priority = priority.id; row.draggable = true;
      row.title = "Drag to reorder, or use the arrow buttons";
      const rank = this.element("span", "priority-rank"); rank.setAttribute("aria-hidden", "true");
      const number = this.element("span"), grip = this.element("span", "priority-grip", "⠿");
      rank.append(number, grip);
      const copy = this.element("div", "priority-copy");
      copy.append(this.element("strong", "", priority.label), this.element("p", "", priority.prompt));
      const controls = this.element("div", "priority-controls");
      const buttons = ["up", "down"].map(direction => {
        const button = this.element("button", "", direction === "up" ? "↑" : "↓");
        button.type = "button"; button.dataset.move = direction;
        button.title = `Move ${priority.label.toLowerCase()} ${direction}`;
        button.setAttribute("aria-label", button.title);
        button.setAttribute("aria-keyshortcuts", direction === "up" ? "Alt+ArrowUp" : "Alt+ArrowDown");
        controls.append(button); return button;
      });
      row.append(rank, copy, controls);
      this.rows.set(priority.id, { row, number, up: buttons[0], down: buttons[1] });
    }
    container.addEventListener("click", event => {
      const button = event.target.closest("button[data-move]"), row = this.rowFor(event);
      if (!row || !button || button.disabled) return;
      this.move(row.dataset.priority, this.getOrder().indexOf(row.dataset.priority) + (button.dataset.move === "up" ? -1 : 1));
    });
    container.addEventListener("keydown", event => {
      const row = this.rowFor(event);
      if (!row || !event.altKey || event.ctrlKey || event.metaKey || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const index = this.getOrder().indexOf(row.dataset.priority) + (event.key === "ArrowUp" ? -1 : 1);
      if (index >= 0 && index < this.order.length) this.move(row.dataset.priority, index);
    });
    container.addEventListener("dragstart", event => {
      const row = this.rowFor(event);
      if (!row || !event.dataTransfer) return;
      this.dragged = row.dataset.priority;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", this.dragged);
      row.classList.add("dragging");
    });
    container.addEventListener("dragover", event => {
      const row = this.rowFor(event);
      if (!this.dragged || !row) return; // Ignore drops from outside this list.
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      for (const entry of this.rows.values()) entry.row.classList.toggle("drop-target", entry.row === row && row.dataset.priority !== this.dragged);
    });
    container.addEventListener("drop", event => {
      const row = this.rowFor(event), id = this.dragged;
      if (!id || !row) return;
      event.preventDefault(); event.stopPropagation();
      this.endDrag();
      this.move(id, this.getOrder().indexOf(row.dataset.priority));
    });
    container.addEventListener("dragend", () => this.endDrag());
    resetButton.addEventListener("click", () => this.change(DEFAULT_PRIORITY_ORDER, "Default priority order restored."));
    this.render();
  }
  element(tag, className = "", text) {
    const node = this.document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  rowFor(event) {
    const row = event.target.closest(".priority-item");
    return row && this.container.contains(row) ? row : null;
  }
  endDrag() {
    this.dragged = null;
    for (const entry of this.rows.values()) entry.row.classList.remove("dragging", "drop-target");
  }
  move(id, index) {
    const next = movePriority(this.getOrder(), id, index);
    this.change(next, `${PRIORITIES.find(priority => priority.id === id).label} is now priority ${index + 1} of ${next.length}.`);
  }
  change(order, message) {
    const next = validatePriorityOrder(order);
    if (next.every((id, index) => id === this.getOrder()[index])) return;
    const resetFocused = this.document.activeElement === this.resetButton;
    this.onChange(next);
    this.render();
    if (!next.every((id, index) => id === this.getOrder()[index])) return;
    this.announcement.textContent = `${message} Game stopped; Start or Step uses the new order.`;
    if (resetFocused) this.rows.get(next[0]).down.focus({ preventScroll: true });
  }
  render() {
    const order = validatePriorityOrder(this.getOrder());
    if (order.every((id, index) => id === this.order[index])) return;
    const active = this.document.activeElement, focusedRow = active?.closest(".priority-item");
    order.forEach((id, index) => {
      const entry = this.rows.get(id);
      entry.number.textContent = String(index + 1);
      entry.up.disabled = index === 0; entry.down.disabled = index === order.length - 1;
      if (this.container.children[index] !== entry.row) this.container.insertBefore(entry.row, this.container.children[index] || null);
    });
    this.order = order;
    this.resetButton.disabled = order.every((id, index) => id === DEFAULT_PRIORITY_ORDER[index]);
    if (focusedRow && this.container.contains(focusedRow)) {
      // Moving a focused DOM node or disabling a boundary arrow must not lose keyboard focus.
      const target = active.disabled ? focusedRow.querySelector("button:not(:disabled)") : active;
      target?.focus({ preventScroll: true });
    }
  }
}

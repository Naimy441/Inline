const LIMIT = 40;

export function createUndoStack<T>(limit = LIMIT) {
  const undo: T[] = [];
  const redo: T[] = [];
  return {
    push(entry: T) {
      undo.push(entry);
      while (undo.length > limit) undo.shift();
      redo.length = 0;
    },
    undo(current: T): T | undefined {
      const prev = undo.pop();
      if (!prev) return undefined;
      redo.push(current);
      return prev;
    },
    redo(current: T): T | undefined {
      const next = redo.pop();
      if (!next) return undefined;
      undo.push(current);
      return next;
    },
    get canUndo() {
      return undo.length > 0;
    },
    get canRedo() {
      return redo.length > 0;
    },
  };
}

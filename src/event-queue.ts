export interface TimedEvent {
  time: number;
  phase: number;
  serial: number;
  run: () => void;
}
/** Stable binary heap: O(log events), with causal same-time insertions processed before departures. */
export class EventQueue {
  private heap: TimedEvent[] = [];
  private serial = 0;
  get size() {
    return this.heap.length;
  }
  peek() {
    return this.heap[0];
  }
  private before(a: TimedEvent, b: TimedEvent) {
    return (
      a.time < b.time ||
      (a.time === b.time &&
        (a.phase < b.phase || (a.phase === b.phase && a.serial < b.serial)))
    );
  }
  push(time: number, phase: number, run: () => void) {
    const v = { time, phase, serial: this.serial++, run };
    let i = this.heap.length;
    this.heap.push(v);
    while (i) {
      const p = (i - 1) >> 1;
      if (!this.before(v, this.heap[p])) break;
      this.heap[i] = this.heap[p];
      i = p;
    }
    this.heap[i] = v;
  }
  pop() {
    const root = this.heap[0],
      last = this.heap.pop();
    if (this.heap.length && last) {
      let i = 0;
      while (true) {
        let child = 2 * i + 1;
        if (child >= this.heap.length) break;
        if (
          child + 1 < this.heap.length &&
          this.before(this.heap[child + 1], this.heap[child])
        )
          child++;
        if (!this.before(this.heap[child], last)) break;
        this.heap[i] = this.heap[child];
        i = child;
      }
      this.heap[i] = last;
    }
    return root;
  }
}

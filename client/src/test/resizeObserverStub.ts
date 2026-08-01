/** jsdom ships no ResizeObserver, and the chat pickers and MessageList both measure with one, so
 *  without this they cannot render in a test at all. Instances are recorded so a test can fire the
 *  callback and simulate content that lays out after mount. */

class ResizeObserverStub implements ResizeObserver {
  static instances: ResizeObserverStub[] = [];

  readonly callback: ResizeObserverCallback;

  private targets = new Set<Element>();

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    ResizeObserverStub.instances.push(this);
  }

  observe(target: Element): void {
    this.targets.add(target);
  }

  unobserve(target: Element): void {
    this.targets.delete(target);
  }

  disconnect(): void {
    this.targets.clear();
  }

  static reset(): void {
    ResizeObserverStub.instances = [];
  }

  /** Run the callback of every observer that is actually watching something, as the browser would
   *  after a layout change. Constructing an observer and never calling observe() must stay inert —
   *  otherwise a test passes against code that forgot to attach it. */
  static flush(): void {
    for (const instance of ResizeObserverStub.instances) {
      if (instance.targets.size > 0) instance.callback([], instance);
    }
  }
}

export { ResizeObserverStub };

import { type Versioned, mergeByVersion } from '@digsite/shared/sheet/merge';

/** Holds at most one merged scene while remote assets are loading. */
export class RemoteSceneBuffer {
  private elements: unknown[] | null = null;

  enqueue(elements: unknown[]): void {
    this.elements = this.elements
      ? mergeByVersion(this.elements as Versioned[], elements as Versioned[])
      : elements;
  }

  take(): unknown[] | null {
    const elements = this.elements;
    this.elements = null;
    return elements;
  }

  hasPending(): boolean {
    return this.elements !== null;
  }
}

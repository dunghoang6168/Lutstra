import { describe, expect, it } from 'vitest';
import { CoverSwap } from '../src/app/shared/components/cover-art/cover-swap';

/** A decoder whose results resolve when the test says so. */
function manualDecode() {
  const pending = new Map<string, () => void>();
  const decode = (src: string) => new Promise<void>((resolve) => pending.set(src, resolve));
  return { decode, finish: (src: string) => pending.get(src)!() };
}

const srcs = (swap: CoverSwap) => swap.layers().map((layer) => layer.src);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('CoverSwap', () => {
  it('shows the first cover at once, without a fade', async () => {
    const swap = new CoverSwap(() => new Promise(() => undefined));
    await swap.show('a.jpg');
    expect(swap.layers()).toEqual([{ id: 1, src: 'a.jpg', fade: false }]);
  });

  it('keeps the old cover until the new one decodes, then fades it in on top', async () => {
    const { decode, finish } = manualDecode();
    const swap = new CoverSwap(decode);
    await swap.show('a.jpg');
    const next = swap.show('b.jpg');
    await flush();
    expect(srcs(swap)).toEqual(['a.jpg']);
    finish('b.jpg');
    await next;
    expect(srcs(swap)).toEqual(['a.jpg', 'b.jpg']);
    expect(swap.layers()[1].fade).toBe(true);
    swap.settle(swap.layers()[1].id);
    expect(srcs(swap)).toEqual(['b.jpg']);
  });

  it('does nothing for the same cover', async () => {
    const swap = new CoverSwap(() => Promise.resolve());
    await swap.show('a.jpg');
    await swap.show('a.jpg');
    expect(srcs(swap)).toEqual(['a.jpg']);
  });

  it('keeps only the latest cover when tracks change quickly', async () => {
    const { decode, finish } = manualDecode();
    const swap = new CoverSwap(decode);
    await swap.show('a.jpg');
    const b = swap.show('b.jpg');
    const c = swap.show('c.jpg');
    finish('c.jpg');
    finish('b.jpg');
    await Promise.all([b, c]);
    expect(srcs(swap)).toEqual(['a.jpg', 'c.jpg']);
  });

  it('drops a pending cover when the shown one comes back', async () => {
    const { decode, finish } = manualDecode();
    const swap = new CoverSwap(decode);
    await swap.show('a.jpg');
    const b = swap.show('b.jpg');
    await swap.show('a.jpg');
    finish('b.jpg');
    await b;
    expect(srcs(swap)).toEqual(['a.jpg']);
  });

  it('never stacks more than two layers', async () => {
    const swap = new CoverSwap(() => Promise.resolve());
    await swap.show('a.jpg');
    await swap.show('b.jpg');
    await swap.show(null);
    expect(srcs(swap)).toEqual(['b.jpg', null]);
  });

  it('swaps in a cover that fails to decode', async () => {
    const swap = new CoverSwap(() => Promise.reject(new Error('EncodingError')));
    await swap.show('a.jpg');
    await swap.show('broken.jpg');
    expect(srcs(swap)).toEqual(['a.jpg', 'broken.jpg']);
  });
});

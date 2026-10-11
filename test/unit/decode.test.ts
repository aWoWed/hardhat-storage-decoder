import { describe, expect, it } from 'vitest';
import { IndexOutOfBoundsError, UnsupportedTypeError } from '../../src/core/query/errors.js';
import { decode, resolveObligations, resolveReadPlan } from '../../src/core/slots/decode.js';
import type { BoundsObligation } from '../../src/core/slots/deriveSlot.js';
import { hexToBytes, utf8ToBytes } from '../../src/core/util/bytes.js';
import { MockStorage, arrayBase, packWord, word } from './helpers.js';

describe('decode of packed value types', () => {
  const packed = packWord(
    { offset: 0, size: 16, value: 123n }, // uint128 a
    { offset: 16, size: 8, value: 456n }, // uint64  b
    { offset: 24, size: 4, value: 789n }, // uint32  c
    { offset: 28, size: 1, value: 1n }, // bool    d
    { offset: 29, size: 1, value: 42n } // uint8   e
  );

  it('extracts each field from its own byte window', () => {
    expect(decode([packed], 0, 16, { family: 'uint', bits: 128, bytes: 16 })).toBe(123n);
    expect(decode([packed], 16, 8, { family: 'uint', bits: 64, bytes: 8 })).toBe(456n);
    expect(decode([packed], 24, 4, { family: 'uint', bits: 32, bytes: 4 })).toBe(789n);
    expect(decode([packed], 28, 1, { family: 'bool' })).toBe(true);
    expect(decode([packed], 29, 1, { family: 'uint', bits: 8, bytes: 1 })).toBe(42n);
  });

  it('interprets signed integers as two\'s complement within their own width', () => {
    const negative = packWord({ offset: 0, size: 16, value: hexToBytes('0x' + 'ff'.repeat(16)) });
    expect(decode([negative], 0, 16, { family: 'int', bits: 128, bytes: 16 })).toBe(-1n);
    // The same bytes read as unsigned are a huge positive number, not -1.
    expect(decode([negative], 0, 16, { family: 'uint', bits: 128, bytes: 16 })).toBe(
      2n ** 128n - 1n
    );
  });

  it('checksums addresses', () => {
    const slot = packWord({
      offset: 0,
      size: 20,
      value: hexToBytes('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed'),
    });
    expect(decode([slot], 0, 20, { family: 'address' })).toBe(
      '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'
    );
  });

  it('returns bytesN as hex of exactly its own window', () => {
    const slot = packWord({ offset: 16, size: 4, value: hexToBytes('0xdeadbeef') });
    expect(decode([slot], 16, 4, { family: 'bytesN', size: 4 })).toBe('0xdeadbeef');
  });

  it('refuses to decode an unresolved user-defined value type', () => {
    expect(() =>
      decode([word(1)], 0, 32, {
        family: 'unresolvedUserDefinedValueType',
        name: 'Id',
        numberOfBytes: 32,
      })
    ).toThrow(UnsupportedTypeError);
  });
});

describe('resolveReadPlan for string/bytes', () => {
  it('collapses a short value into the header slot, reading its HIGH-order bytes', async () => {
    const storage = new MockStorage().setString(7n, 'hello');
    const resolved = await resolveReadPlan(
      { kind: 'multi', headerSlot: 7n, dataBaseSlot: arrayBase(7n) },
      storage.reader()
    );

    expect(resolved.dynamic).toEqual({ length: 5, short: true });
    expect(resolved.slotValues).toHaveLength(1);
    // Exactly one read: no data slots were touched.
    expect(storage.reads.map((r) => r.slot)).toEqual([7n]);
    expect(decode(resolved.slotValues, 0, 32, { family: 'string' }, resolved.dynamic)).toBe(
      'hello'
    );
  });

  it('decodes a 31-byte value inline and a 32-byte value out of line', async () => {
    const plan = (slot: bigint) =>
      ({ kind: 'multi', headerSlot: slot, dataBaseSlot: arrayBase(slot) }) as const;

    const boundary = new MockStorage().setString(1n, 'x'.repeat(31)).setString(2n, 'y'.repeat(32));

    const short = await resolveReadPlan(plan(1n), boundary.reader());
    expect(short.dynamic).toEqual({ length: 31, short: true });
    expect(decode(short.slotValues, 0, 32, { family: 'string' }, short.dynamic)).toBe(
      'x'.repeat(31)
    );

    const long = await resolveReadPlan(plan(2n), boundary.reader());
    expect(long.dynamic).toEqual({ length: 32, short: false });
    expect(decode(long.slotValues, 0, 32, { family: 'string' }, long.dynamic)).toBe('y'.repeat(32));
  });

  it('reads ceil(length / 32) data slots for a long value', async () => {
    const text = 'The quick brown fox jumps over the lazy dog, repeatedly and at length.';
    expect(text.length).toBeGreaterThan(64);
    const storage = new MockStorage().setString(9n, text);

    const resolved = await resolveReadPlan(
      { kind: 'multi', headerSlot: 9n, dataBaseSlot: arrayBase(9n) },
      storage.reader()
    );

    expect(resolved.dynamic).toEqual({ length: text.length, short: false });
    expect(resolved.slotValues).toHaveLength(Math.ceil(text.length / 32));
    // The header slot is what a caller sees as `slot`/`rawSlotValue`.
    expect(resolved.slot).toBe(9n);
    expect(decode(resolved.slotValues, 0, 32, { family: 'string' }, resolved.dynamic)).toBe(text);
  });

  it('returns bytes as hex, truncated to the encoded length', async () => {
    const blob = hexToBytes(`0x${'ab'.repeat(40)}`);
    const storage = new MockStorage().setDynamicBytes(3n, blob);
    const resolved = await resolveReadPlan(
      { kind: 'multi', headerSlot: 3n, dataBaseSlot: arrayBase(3n) },
      storage.reader()
    );
    expect(decode(resolved.slotValues, 0, 32, { family: 'bytes' }, resolved.dynamic)).toBe(
      `0x${'ab'.repeat(40)}`
    );
  });

  it('decodes an empty value', async () => {
    const storage = new MockStorage();
    const resolved = await resolveReadPlan(
      { kind: 'multi', headerSlot: 4n, dataBaseSlot: arrayBase(4n) },
      storage.reader()
    );
    expect(resolved.dynamic).toEqual({ length: 0, short: true });
    expect(decode(resolved.slotValues, 0, 32, { family: 'string' }, resolved.dynamic)).toBe('');
  });

  it('refuses an absurd encoded length instead of trying to read it', async () => {
    const storage = new MockStorage().set(5n, hexToBytes(`0x${'ff'.repeat(32)}`));
    await expect(
      resolveReadPlan(
        { kind: 'multi', headerSlot: 5n, dataBaseSlot: arrayBase(5n) },
        storage.reader()
      )
    ).rejects.toThrow(RangeError);
  });

  it.each([0n, 5n, 31n])(
    'refuses a long-form header that declares %s byte(s), which solc stores inline',
    async (length) => {
      // Long form is `2 * length + 1`; a value under 32 bytes is always stored in short form.
      const storage = new MockStorage().set(6n, word(2n * length + 1n));
      const resolving = resolveReadPlan(
        { kind: 'multi', headerSlot: 6n, dataBaseSlot: arrayBase(6n) },
        storage.reader()
      );
      await expect(resolving).rejects.toThrow(RangeError);
      await expect(resolving).rejects.toThrow(/not a valid long string\/bytes header/);
    }
  );

  it('passes a single-slot plan straight through', async () => {
    const storage = new MockStorage().set(11n, word(0xabcn));
    const resolved = await resolveReadPlan({ kind: 'single', slot: 11n }, storage.reader());
    expect(resolved.slot).toBe(11n);
    expect(resolved.dynamic).toBeUndefined();
    expect(decode(resolved.slotValues, 0, 32, { family: 'uint', bits: 256, bytes: 32 })).toBe(
      0xabcn
    );
  });
});

describe('resolveObligations', () => {
  const obligation = (
    lengthSlot: bigint,
    index: bigint,
    segmentIndex: number
  ): BoundsObligation => ({
    lengthSlot,
    index,
    segmentIndex,
    typeLabel: 'uint256[]',
    variableName: 'arr',
  });

  it('passes when the index is within the stored length', async () => {
    const storage = new MockStorage().set(0n, word(4));
    await expect(
      resolveObligations([obligation(0n, 3n, 0)], storage.reader())
    ).resolves.toBeUndefined();
  });

  it('throws IndexOutOfBoundsError naming the real length', async () => {
    const storage = new MockStorage().set(0n, word(4));
    await expect(resolveObligations([obligation(0n, 4n, 0)], storage.reader())).rejects.toThrow(
      IndexOutOfBoundsError
    );
    await expect(resolveObligations([obligation(0n, 9n, 0)], storage.reader())).rejects.toThrow(
      /length 4/
    );
  });

  it('treats an unwritten array as empty rather than reading a plausible zero', async () => {
    const storage = new MockStorage();
    await expect(resolveObligations([obligation(0n, 0n, 0)], storage.reader())).rejects.toThrow(
      IndexOutOfBoundsError
    );
  });

  it('reports the OUTERMOST failure and never evaluates the inner one', async () => {
    // arr[999][3] where the outer array has length 2: the inner obligation was derived from
    // an index that does not exist, so evaluating it would be meaningless.
    const storage = new MockStorage().set(0n, word(2)).set(50n, word(99));
    const obligations = [obligation(0n, 999n, 0), obligation(50n, 3n, 1)];

    await expect(resolveObligations(obligations, storage.reader())).rejects.toThrow(
      /Index 999 is out of bounds/
    );
    expect(storage.reads.map((r) => r.slot)).toEqual([0n]);
  });
});

describe('a short-form header that cannot be one', () => {
  it.each([32, 33, 127])('refuses an inline length of %s byte(s)', async (length) => {
    // Short form keeps 2 * length in the low byte; nothing above 31 bytes fits inline.
    const header = new Uint8Array(32);
    header[31] = length * 2;
    const storage = new MockStorage().set(6n, header);
    const resolving = resolveReadPlan(
      { kind: 'multi', headerSlot: 6n, dataBaseSlot: arrayBase(6n) },
      storage.reader()
    );
    await expect(resolving).rejects.toThrow(RangeError);
    await expect(resolving).rejects.toThrow('is not a valid short string/bytes header');
    // Only the header was read.
    expect(storage.reads.map((r) => r.slot)).toEqual([6n]);
  });
});

describe('a string that starts with a byte-order mark', () => {
  it('keeps U+FEFF: the stored bytes EF BB BF are part of the value', () => {
    const stored = hexToBytes('0xefbbbf41');
    const header = new Uint8Array(32);
    header.set(stored, 0);
    header[31] = stored.length * 2;
    const text = decode([header], 0, 32, { family: 'string' }, { length: 4, short: true });
    expect(text).toBe('\ufeffA');
    expect(text).toHaveLength(2);
    expect(utf8ToBytes(text as string)).toEqual(stored);
  });

  it('keeps it in a long value, and only strips nothing elsewhere', async () => {
    const original = `\ufeff${'x'.repeat(40)}\ufeff`;
    const storage = new MockStorage().setString(9n, original);
    const resolved = await resolveReadPlan(
      { kind: 'multi', headerSlot: 9n, dataBaseSlot: arrayBase(9n) },
      storage.reader()
    );
    expect(decode(resolved.slotValues, 0, 32, { family: 'string' }, resolved.dynamic)).toBe(
      original
    );
  });
});

describe('decode input validation', () => {
  it('requires the resolved length for string/bytes', () => {
    expect(() => decode([word(0)], 0, 32, { family: 'string' })).toThrow(/requires the length/);
    expect(() => decode([word(0)], 0, 32, { family: 'bytes' })).toThrow(TypeError);
    expect(() => decode([word(0)], 0, 32, { family: 'bytes' })).toThrow(
      'decoding a string/bytes value requires the length resolved by resolveReadPlan'
    );
  });

  it('requires a slot value for string/bytes even when the length is known', () => {
    for (const family of ['string', 'bytes'] as const) {
      expect(() => decode([], 0, 32, { family }, { length: 0, short: true })).toThrow(TypeError);
      expect(() => decode([], 0, 32, { family }, { length: 0, short: true })).toThrow(
        'decoding a string/bytes value requires at least one slot value'
      );
    }
  });

  it('refuses an address kind paired with a width other than 20 bytes', () => {
    expect(() => decode([word(1)], 0, 32, { family: 'address' })).toThrow(TypeError);
  });

  it('requires at least one slot value', () => {
    expect(() => decode([], 0, 32, { family: 'uint', bits: 256, bytes: 32 })).toThrow(
      /at least one slot value/
    );
  });

  it('decodes a short value from the high-order bytes, not the low ones', () => {
    // 'hi' stored short: bytes 0..1 hold the data, byte 31 holds 2*length.
    const header = new Uint8Array(32);
    header.set(utf8ToBytes('hi'), 0);
    header[31] = 4;
    expect(decode([header], 0, 32, { family: 'string' }, { length: 2, short: true })).toBe('hi');
  });
});

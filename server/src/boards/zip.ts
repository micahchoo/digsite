// A zip written as it goes, entries STORED (not deflated): originals are
// already compressed, so deflating them costs time for nothing. Each entry
// is handed over whole, so its CRC-32 and size go in its local header and
// no data descriptor is needed. No zip64: callers keep an archive under
// 4 GB and 65,535 entries (GET /boards/:id/images/download caps it far
// below).
const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const UTF8 = 1 << 11;

type Written = { name: Buffer; crc: number; size: number; offset: number };

export class ZipWriter {
  private offset = 0;
  private readonly entries: Written[] = [];

  constructor(private readonly write: (chunk: Uint8Array) => void) {}

  add(name: string, bytes: Uint8Array): void {
    const encoded = Buffer.from(name, 'utf8');
    const crc = Bun.hash.crc32(bytes) >>> 0;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(LOCAL, 0);
    header.writeUInt16LE(20, 4); // version needed
    header.writeUInt16LE(UTF8, 6);
    header.writeUInt16LE(0, 8); // stored
    header.writeUInt32LE(0, 10); // time, date: none
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(bytes.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(encoded.length, 26);
    header.writeUInt16LE(0, 28);
    this.write(header);
    this.write(encoded);
    this.write(bytes);
    this.entries.push({
      name: encoded,
      crc,
      size: bytes.length,
      offset: this.offset,
    });
    this.offset += header.length + encoded.length + bytes.length;
  }

  finish(): void {
    const start = this.offset;
    for (const e of this.entries) {
      const central = Buffer.alloc(46);
      central.writeUInt32LE(CENTRAL, 0);
      central.writeUInt16LE(20, 4); // made by
      central.writeUInt16LE(20, 6); // needed
      central.writeUInt16LE(UTF8, 8);
      central.writeUInt16LE(0, 10);
      central.writeUInt32LE(0, 12);
      central.writeUInt32LE(e.crc, 16);
      central.writeUInt32LE(e.size, 20);
      central.writeUInt32LE(e.size, 24);
      central.writeUInt16LE(e.name.length, 28);
      central.writeUInt32LE(e.offset, 42);
      this.write(central);
      this.write(e.name);
      this.offset += central.length + e.name.length;
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(END, 0);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(this.offset - start, 12);
    end.writeUInt32LE(start, 16);
    this.write(end);
  }
}

/** File names unique within one archive: a second "a.png" is "a (2).png",
 * or the next number no other entry has already taken. */
export function uniqueNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((name) => {
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    let candidate = name;
    for (let n = 2; used.has(candidate); n++)
      candidate = `${stem} (${n})${ext}`;
    used.add(candidate);
    return candidate;
  });
}

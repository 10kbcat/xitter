// Reads entries out of a zip file on disk without loading the whole file:
// the central directory first, then each entry's bytes when asked for. Stored
// and deflated entries, and zip64 for archives past 4 GB (X archives get big).

import { inflateRawSync } from "node:zlib";

export type ZipEntry = { name: string; method: number; size: number; compressed: number; offset: number; encrypted: boolean };

const u16 = (b: Buffer, at: number) => b.readUInt16LE(at);
const u32 = (b: Buffer, at: number) => b.readUInt32LE(at);
const u64 = (b: Buffer, at: number) => Number(b.readBigUInt64LE(at));

export class ZipError extends Error {}

export class Zip {
	private constructor(
		private readonly path: string,
		readonly entries: ZipEntry[],
	) {}

	static async open(path: string): Promise<Zip> {
		const file = Bun.file(path);
		const length = file.size;
		const read = async (from: number, to: number) => Buffer.from(await file.slice(from, to).arrayBuffer());
		// the end record sits in the last 22 bytes, plus a comment of up to 64 KB
		const tailStart = Math.max(0, length - 22 - 0xffff);
		const tail = await read(tailStart, length);
		let end = -1;
		for (let i = tail.length - 22; i >= 0; i--)
			if (u32(tail, i) === 0x06054b50) {
				end = i;
				break;
			}
		if (end < 0) throw new ZipError("That isn't a zip file.");
		let count = u16(tail, end + 10);
		let dirSize = u32(tail, end + 12);
		let dirOffset = u32(tail, end + 16);
		if (count === 0xffff || dirSize === 0xffffffff || dirOffset === 0xffffffff) {
			const locator = end - 20;
			if (locator < 0 || u32(tail, locator) !== 0x07064b50) throw new ZipError("The zip file is damaged.");
			const at = u64(tail, locator + 8);
			const z64 = await read(at, at + 56);
			if (u32(z64, 0) !== 0x06064b50) throw new ZipError("The zip file is damaged.");
			count = u64(z64, 32);
			dirSize = u64(z64, 40);
			dirOffset = u64(z64, 48);
		}
		if (dirOffset + dirSize > length || count > 2_000_000) throw new ZipError("The zip file is damaged.");
		const dir = await read(dirOffset, dirOffset + dirSize);
		const entries: ZipEntry[] = [];
		for (let at = 0, n = 0; n < count && at + 46 <= dir.length; n++) {
			if (u32(dir, at) !== 0x02014b50) throw new ZipError("The zip file is damaged.");
			const flags = u16(dir, at + 8);
			const nameLength = u16(dir, at + 28);
			const extraLength = u16(dir, at + 30);
			const commentLength = u16(dir, at + 32);
			let compressed = u32(dir, at + 20);
			let size = u32(dir, at + 24);
			let offset = u32(dir, at + 42);
			const name = dir.toString(flags & 0x800 ? "utf8" : "latin1", at + 46, at + 46 + nameLength);
			// zip64: the fields that overflowed come in this order in extra block 0x0001
			for (let x = at + 46 + nameLength, stop = x + extraLength; x + 4 <= stop; ) {
				const id = u16(dir, x);
				const len = u16(dir, x + 2);
				if (id === 0x0001) {
					let p = x + 4;
					if (size === 0xffffffff) {
						size = u64(dir, p);
						p += 8;
					}
					if (compressed === 0xffffffff) {
						compressed = u64(dir, p);
						p += 8;
					}
					if (offset === 0xffffffff) offset = u64(dir, p);
				}
				x += 4 + len;
			}
			entries.push({ name, method: u16(dir, at + 10), size, compressed, offset, encrypted: !!(flags & 1) });
			at += 46 + nameLength + extraLength + commentLength;
		}
		return new Zip(path, entries);
	}

	// the entry's contents; refuses anything larger than `max` bytes
	async read(entry: ZipEntry, max: number): Promise<Buffer> {
		if (entry.encrypted) throw new ZipError(`${entry.name} is encrypted.`);
		if (entry.size > max) throw new ZipError(`${entry.name} is too large.`);
		const file = Bun.file(this.path);
		const header = Buffer.from(await file.slice(entry.offset, entry.offset + 30).arrayBuffer());
		if (header.length < 30 || u32(header, 0) !== 0x04034b50) throw new ZipError("The zip file is damaged.");
		const start = entry.offset + 30 + u16(header, 26) + u16(header, 28);
		const raw = Buffer.from(await file.slice(start, start + entry.compressed).arrayBuffer());
		if (entry.method === 0) return raw;
		if (entry.method === 8) {
			try {
				return inflateRawSync(raw, { maxOutputLength: Math.max(max, 1) });
			} catch {
				// damaged, or unpacks to more than its size says (a zip bomb)
				throw new ZipError(`${entry.name} couldn't be unpacked.`);
			}
		}
		throw new ZipError(`${entry.name} uses a compression this server can't read.`);
	}
}

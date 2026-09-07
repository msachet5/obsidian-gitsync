import { TFile, Vault } from 'obsidian';
import { UltiSyncSettings } from '../types';
import { isIgnoredPath, matchesExtensions, normalizePath } from './PathFilter';

export interface FileSnapshot {
	path: string;
	hash: string;
	bytes: ArrayBuffer;
}

function toHex(buffer: ArrayBuffer): string {
	return Array.from(new Uint8Array(buffer))
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

export async function sha256(data: ArrayBuffer): Promise<string> {
	return toHex(await crypto.subtle.digest('SHA-256', data));
}

/**
 * The sha GitHub will give this content, computed locally. Git hashes
 * `blob <length>\0` followed by the bytes, so the value can be compared
 * against a tree entry without downloading the blob.
 */
export async function gitBlobSha(data: ArrayBuffer): Promise<string> {
	const content = new Uint8Array(data);
	const header = new TextEncoder().encode(`blob ${content.length}\0`);
	const payload = new Uint8Array(header.length + content.length);
	payload.set(header, 0);
	payload.set(content, header.length);
	return toHex(await crypto.subtle.digest('SHA-1', payload));
}

export function bytesToBase64(data: ArrayBuffer): string {
	const bytes = new Uint8Array(data);
	const chunkSize = 32768;
	let binary = '';
	// Chunked because String.fromCharCode is applied to the whole array at once
	// and a large file would otherwise blow the argument limit.
	for (let i = 0; i < bytes.length; i += chunkSize) {
		const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
		binary += String.fromCharCode(...chunk);
	}
	return btoa(binary);
}

export function base64ToArrayBuffer(value: string): ArrayBuffer {
	const binary = atob(value.replace(/\n/g, ''));
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes.buffer;
}

export class VaultScanner {
	constructor(
		private vault: Vault,
		private settings: UltiSyncSettings,
	) {}

	getEligibleFiles(extensions: string[]): TFile[] {
		return this.vault.getFiles().filter((file) => {
			const path = normalizePath(file.path);
			return (
				matchesExtensions(path, extensions) &&
				!isIgnoredPath(path, this.settings.ignoredPaths)
			);
		});
	}

	async readSnapshot(file: TFile): Promise<FileSnapshot> {
		const bytes = await this.vault.readBinary(file);
		return {
			path: normalizePath(file.path),
			hash: await sha256(bytes),
			bytes,
		};
	}

	async getLocalHash(file: TFile): Promise<string> {
		return sha256(await this.vault.readBinary(file));
	}

	async findFile(path: string): Promise<TFile | null> {
		const abstract = this.vault.getAbstractFileByPath(normalizePath(path));
		return abstract instanceof TFile ? abstract : null;
	}
}

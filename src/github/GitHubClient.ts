import { requestUrl } from 'obsidian';
import { EMPTY_TREE_SHA } from '../types';

export interface GitReference {
	ref: string;
	url: string;
	object: { sha: string; type: string; url: string };
}

export interface GitCommit {
	sha: string;
	message: string;
	tree: { sha: string; url: string };
	parents: { sha: string }[];
}

export interface GitTreeEntry {
	path: string;
	mode: string;
	type: string;
	sha: string;
	size?: number;
	url?: string;
}

export interface GitTree {
	sha: string;
	url: string;
	tree: GitTreeEntry[];
	truncated: boolean;
}

export interface GitBlob {
	sha: string;
	content: string;
	encoding: string;
	size: number;
}

/** A tree entry being written. A null sha deletes the path from the base tree. */
export interface NewTreeEntry {
	path: string;
	mode: string;
	type: string;
	sha: string | null;
}

/** The remote tree at one commit, keyed by path. Blobs only. */
export interface RemoteSnapshot {
	commitSha: string;
	treeSha: string;
	entries: Map<string, GitTreeEntry>;
}

export type CompareStatus = 'ahead' | 'behind' | 'identical' | 'diverged';

export interface CompareResult {
	status: CompareStatus;
	commits: { sha: string; message: string }[];
}

interface ConditionalResponse<T> {
	status: number;
	body: T | undefined;
	etag: string | undefined;
}

export class GitHubApiError extends Error {
	readonly status: number;
	readonly raw: unknown;

	constructor(status: number, message: string, raw?: unknown) {
		super(message);
		this.name = 'GitHubApiError';
		this.status = status;
		this.raw = raw;
	}
}

/**
 * True when the branch simply is not there yet: either the repository has no
 * commits at all (409) or this branch has never been created (404). Both mean
 * the same thing to the plugin, which is that there is nothing to compare
 * against and the first push has to create the history.
 */
export function isMissingBranch(error: unknown): boolean {
	return error instanceof GitHubApiError && (error.status === 404 || error.status === 409);
}

/** ETag per owner/repo/branch, so an unchanged branch read costs no rate limit. */
const branchRefCache = new Map<string, { etag: string; ref: GitReference }>();

/** The last commit this installation placed on a branch, to spot stale reads. */
const lastPushedHead = new Map<string, string>();

function readEtag(headers: Record<string, string> | undefined): string | undefined {
	if (!headers) return undefined;
	for (const [name, value] of Object.entries(headers)) {
		if (name.toLowerCase() === 'etag') return value;
	}
	return undefined;
}

function parseBody(text: string | undefined): unknown {
	if (!text) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

/** GitHub puts the useful part of an error in a `message` field. */
function messageOf(parsed: unknown, fallback: string): string {
	if (typeof parsed === 'object' && parsed !== null && 'message' in parsed) {
		const { message } = parsed;
		if (typeof message === 'string') return message;
	}
	return fallback;
}

export class GitHubClient {
	private readonly baseUrl = 'https://api.github.com';
	private readonly apiVersion = '2026-03-10';

	constructor(
		private owner: string,
		private repo: string,
		private token: string,
		private branch: string,
	) {}

	private ensureConfigured(): void {
		if (!this.owner || !this.repo || !this.token) {
			throw new GitHubApiError(400, 'GitHub owner, repository and token are required.');
		}
	}

	private headers(): Record<string, string> {
		return {
			Accept: 'application/vnd.github+json',
			Authorization: `Bearer ${this.token}`,
			'X-GitHub-Api-Version': this.apiVersion,
			'User-Agent': 'gitsync',
		};
	}

	private repoPath(suffix: string): string {
		return `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}${suffix}`;
	}

	private cacheKey(): string {
		return `${this.owner}/${this.repo}/${this.branch}`;
	}

	private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
		this.ensureConfigured();
		try {
			const response = await requestUrl({
				url: `${this.baseUrl}${path}`,
				method,
				headers: this.headers(),
				body: body === undefined ? undefined : JSON.stringify(body),
				throw: false,
			});
			const parsed = parseBody(response.text);
			if (response.status < 200 || response.status >= 300) {
				throw new GitHubApiError(
					response.status,
					`${messageOf(parsed, `HTTP ${response.status}`)} (${method} ${path})`,
					parsed,
				);
			}
			return parsed as T;
		} catch (error) {
			if (error instanceof GitHubApiError) throw error;
			throw new GitHubApiError(
				0,
				'Unable to reach GitHub. Check the network connection.',
				error,
			);
		}
	}

	// The branch head is read on every poll, so it is fetched conditionally.
	// GitHub answers an unchanged ref with 304 Not Modified, which carries no
	// body and does not count against the rate limit. If the ETag header is ever
	// absent the cache simply stays empty and this behaves like a plain GET.
	async getBranchReference(skipCache = false): Promise<GitReference> {
		const branch = encodeURIComponent(this.branchRef());
		const path = this.repoPath(`/git/ref/${branch}`);
		const key = this.cacheKey();
		const cached = skipCache ? undefined : branchRefCache.get(key);

		const result = await this.conditionalGet<GitReference>(path, cached?.etag);
		if (result.status === 304 && cached) {
			return cached.ref;
		}
		if (!result.body) {
			throw new GitHubApiError(0, 'GitHub returned an empty branch reference.');
		}
		if (result.etag) {
			branchRefCache.set(key, { etag: result.etag, ref: result.body });
		} else {
			branchRefCache.delete(key);
		}
		return result.body;
	}

	// Drops the cached ETag for the branch, forcing the next read to be answered
	// with a body rather than a 304. Used when the cached head turns out to be
	// older than the commit this vault has already reconciled: continuing to
	// serve it would keep the vault pinned to the past.
	invalidateBranchCache(): void {
		branchRefCache.delete(this.cacheKey());
	}

	// True when a branch read came back older than a commit this installation has
	// already placed on that branch, meaning a stale replica rather than a branch
	// that moved.
	//
	// Building a commit on top of such a head is guaranteed to be rejected as a
	// non-fast-forward, because the parent is not the real tip. Costs nothing in
	// the ordinary case: when the read matches what we last pushed, or when we
	// have pushed nothing yet, no request is made.
	async isStaleHead(headSha: string): Promise<boolean> {
		const known = lastPushedHead.get(this.cacheKey());
		if (!known || known === headSha) return false;
		try {
			return (await this.compareCommits(headSha, known)).status === 'ahead';
		} catch {
			return true;
		}
	}

	private async conditionalGet<T>(
		path: string,
		etag: string | undefined,
	): Promise<ConditionalResponse<T>> {
		this.ensureConfigured();
		const headers = this.headers();
		if (etag) {
			headers['If-None-Match'] = etag;
		}
		try {
			const response = await requestUrl({
				url: `${this.baseUrl}${path}`,
				method: 'GET',
				headers,
				throw: false,
			});
			if (response.status === 304) {
				return { status: 304, body: undefined, etag };
			}
			const parsed = parseBody(response.text);
			if (response.status < 200 || response.status >= 300) {
				throw new GitHubApiError(
					response.status,
					`${messageOf(parsed, `HTTP ${response.status}`)} (GET ${path})`,
					parsed,
				);
			}
			return {
				status: response.status,
				body: parsed as T | undefined,
				etag: readEtag(response.headers),
			};
		} catch (error) {
			if (error instanceof GitHubApiError) throw error;
			throw new GitHubApiError(
				0,
				'Unable to reach GitHub. Check the network connection.',
				error,
			);
		}
	}

	async getCommit(shaOrRef: string): Promise<GitCommit> {
		return this.request('GET', this.repoPath(`/git/commits/${encodeURIComponent(shaOrRef)}`));
	}

	// How head relates to base, in one request. "ahead" means base is an ancestor
	// of head, the ordinary case where the remote has simply moved forward.
	//
	// This is the guard that replaced waiting a minute to see whether a file
	// stayed missing. GitHub's Git Database API is read-after-write eventually
	// consistent, so a read taken moments after a push can hand back an older
	// commit, whose tree is missing files that genuinely exist. Against that
	// older tree every one of those files reads as a deletion. Asking how the two
	// commits are related turns that from an indistinguishable case into a
	// "behind", and deletions are simply not applied unless the answer is "ahead".
	async compareCommits(baseSha: string, headSha: string): Promise<CompareResult> {
		const response = await this.request<{
			status?: string;
			commits?: { sha: string; commit?: { message?: string } }[];
		}>(
			'GET',
			this.repoPath(
				`/compare/${encodeURIComponent(baseSha)}...${encodeURIComponent(headSha)}`,
			),
		);
		const commits = (response.commits ?? []).map((entry) => ({
			sha: entry.sha,
			message: entry.commit?.message ?? '',
		}));

		switch (response.status) {
			case 'ahead':
			case 'behind':
			case 'identical':
			case 'diverged':
				return { status: response.status, commits };
			default:
				return { status: 'diverged', commits };
		}
	}

	async getTree(treeSha: string, recursive = true): Promise<GitTree> {
		if (treeSha === EMPTY_TREE_SHA) {
			return { sha: treeSha, url: '', tree: [], truncated: false };
		}
		const query = recursive ? '?recursive=1' : '';
		return this.request('GET', this.repoPath(`/git/trees/${encodeURIComponent(treeSha)}${query}`));
	}

	/**
	 * The blob entries of one commit's tree, keyed by path. A truncated
	 * response is refused rather than silently treated as a smaller tree,
	 * which would read as a mass deletion.
	 */
	async readTreeSnapshot(commitSha: string, treeSha: string): Promise<RemoteSnapshot> {
		const response = await this.getTree(treeSha, true);
		if (response.truncated) {
			throw new Error(
				"The GitHub tree is too large for recursive retrieval. This first version requires a repository tree within GitHub's recursive tree limit.",
			);
		}
		const entries = new Map<string, GitTreeEntry>();
		for (const entry of response.tree) {
			if (entry.type === 'blob' && entry.mode !== '120000') {
				entries.set(entry.path.replace(/\\/g, '/'), entry);
			}
		}
		return { commitSha, treeSha, entries };
	}

	async getBlob(sha: string): Promise<GitBlob> {
		return this.request('GET', this.repoPath(`/git/blobs/${encodeURIComponent(sha)}`));
	}

	async createBlob(content: string, encoding: string): Promise<GitBlob> {
		return this.request('POST', this.repoPath('/git/blobs'), { content, encoding });
	}

	/** A null base tree builds the tree from nothing, for a first commit. */
	async createTree(baseTreeSha: string | null, tree: NewTreeEntry[]): Promise<GitTree> {
		return this.request('POST', this.repoPath('/git/trees'), {
			...(baseTreeSha === null ? {} : { base_tree: baseTreeSha }),
			tree,
		});
	}

	/** A null parent creates a root commit, which is what an empty repo needs. */
	async createCommit(
		message: string,
		treeSha: string,
		parentSha: string | null,
	): Promise<GitCommit> {
		return this.request('POST', this.repoPath('/git/commits'), {
			message,
			tree: treeSha,
			parents: parentSha === null ? [] : [parentSha],
		});
	}

	/** Creates the branch itself. Only used when the repository had no commits. */
	async createReference(commitSha: string): Promise<GitReference> {
		const created = await this.request<GitReference>('POST', this.repoPath('/git/refs'), {
			ref: `refs/heads/${this.branch}`,
			sha: commitSha,
		});
		lastPushedHead.set(this.cacheKey(), commitSha);
		return created;
	}

	/** The branch head, or null when the branch does not exist yet. */
	async getBranchReferenceOrNull(skipCache = false): Promise<GitReference | null> {
		try {
			return await this.getBranchReference(skipCache);
		} catch (error) {
			if (isMissingBranch(error)) return null;
			throw error;
		}
	}

	async updateReference(currentRef: GitReference, newCommitSha: string): Promise<GitReference> {
		const branchName = currentRef.ref.replace(/^refs\/heads\//, '');
		branchRefCache.delete(this.cacheKey());
		const updated = await this.request<GitReference>(
			'PATCH',
			this.repoPath(`/git/refs/heads/${encodeURIComponent(branchName)}`),
			{ sha: newCommitSha, force: false },
		);
		lastPushedHead.set(this.cacheKey(), newCommitSha);
		return updated;
	}

	private branchRef(): string {
		return `heads/${this.branch}`;
	}
}

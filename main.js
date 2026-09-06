var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/types.ts
var PULL_INTERVAL_MS, POLL_HOLD_AFTER_PUSH_MS, PUSH_DELAY_SECONDS, ACTIVITY_LIMIT, NEW_FILE_SETTLE_MS, EMPTY_BLOB_SHA, EMPTY_TREE_SHA, SELF_WRITE_GRACE_MS, DEFAULT_SETTINGS, DEFAULT_STATE, SUPPORTED_EXTENSIONS;
var init_types = __esm({
  "src/types.ts"() {
    PULL_INTERVAL_MS = 5e3;
    POLL_HOLD_AFTER_PUSH_MS = 1e4;
    PUSH_DELAY_SECONDS = 5;
    ACTIVITY_LIMIT = 30;
    NEW_FILE_SETTLE_MS = 6e4;
    EMPTY_BLOB_SHA = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";
    EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
    SELF_WRITE_GRACE_MS = 2e3;
    DEFAULT_SETTINGS = {
      githubOwner: "",
      githubRepo: "",
      branch: "main",
      token: "",
      pullExtensions: [],
      pushExtensions: [],
      ignoredPaths: []
    };
    DEFAULT_STATE = {
      deviceId: "",
      lastSyncedCommit: null,
      lastRemoteCheck: null,
      lastSuccessfulPull: null,
      lastSuccessfulPush: null,
      trackedFiles: {},
      conflicts: {},
      lastSyncedTree: {},
      pendingRenames: {},
      debugLog: []
    };
    SUPPORTED_EXTENSIONS = [
      ".md",
      ".canvas",
      ".base",
      ".png",
      ".jpg",
      ".jpeg",
      ".gif",
      ".webp",
      ".svg",
      ".bmp",
      ".avif",
      ".pdf",
      ".mp3",
      ".wav",
      ".m4a",
      ".ogg",
      ".3gp",
      ".flac",
      ".mp4",
      ".webm",
      ".ogv",
      ".mov",
      ".mkv"
    ];
  }
});

// src/github/GitHubClient.ts
var GitHubClient_exports = {};
__export(GitHubClient_exports, {
  GitHubApiError: () => GitHubApiError,
  GitHubClient: () => GitHubClient
});
function readEtag(headers) {
  if (!headers) return void 0;
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === "etag") return value;
  }
  return void 0;
}
var import_obsidian, GitHubApiError, branchRefCache, lastPushedHead, GitHubClient;
var init_GitHubClient = __esm({
  "src/github/GitHubClient.ts"() {
    import_obsidian = require("obsidian");
    init_types();
    GitHubApiError = class extends Error {
      constructor(status, message, raw) {
        super(message);
        this.name = "GitHubApiError";
        this.status = status;
        this.raw = raw;
      }
    };
    branchRefCache = /* @__PURE__ */ new Map();
    lastPushedHead = /* @__PURE__ */ new Map();
    GitHubClient = class {
      constructor(owner, repo, token, branch) {
        this.owner = owner;
        this.repo = repo;
        this.token = token;
        this.branch = branch;
        this.baseUrl = "https://api.github.com";
        this.apiVersion = "2026-03-10";
      }
      ensureConfigured() {
        if (!this.owner || !this.repo || !this.token) {
          throw new GitHubApiError(400, "GitHub owner, repository and token are required.");
        }
      }
      async request(method, path, body) {
        this.ensureConfigured();
        try {
          const response = await (0, import_obsidian.requestUrl)({
            url: `${this.baseUrl}${path}`,
            method,
            headers: {
              "Accept": "application/vnd.github+json",
              "Authorization": `Bearer ${this.token}`,
              "X-GitHub-Api-Version": this.apiVersion,
              "User-Agent": "gitsync"
            },
            body: body === void 0 ? void 0 : JSON.stringify(body),
            throw: false
          });
          let parsed = void 0;
          try {
            parsed = response.text ? JSON.parse(response.text) : void 0;
          } catch (e) {
            parsed = response.text;
          }
          if (response.status < 200 || response.status >= 300) {
            const detail = typeof parsed === "object" && parsed !== null && "message" in parsed && typeof parsed.message === "string" ? parsed.message : `HTTP ${response.status}`;
            throw new GitHubApiError(
              response.status,
              `${detail} (${method} ${path})`,
              parsed
            );
          }
          return parsed;
        } catch (error) {
          if (error instanceof GitHubApiError) {
            throw error;
          }
          throw new GitHubApiError(
            0,
            "Unable to reach GitHub. Check the network connection.",
            error
          );
        }
      }
      async testConnection() {
        return this.getBranchReference(true);
      }
      // The branch head is read on every poll, so it is fetched conditionally.
      // GitHub answers an unchanged ref with 304 Not Modified, which carries no
      // body and does not count against the rate limit. If the ETag header is ever
      // absent the cache simply stays empty and this behaves like a plain GET.
      async getBranchReference(skipCache = false) {
        const branch = encodeURIComponent(this.branchRef());
        const path = `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/git/ref/${branch}`;
        const key = `${this.owner}/${this.repo}/${this.branch}`;
        const cached = skipCache ? void 0 : branchRefCache.get(key);
        const result = await this.conditionalGet(path, cached == null ? void 0 : cached.etag);
        if (result.status === 304 && cached) {
          return cached.ref;
        }
        if (!result.body) {
          throw new GitHubApiError(0, "GitHub returned an empty branch reference.");
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
      invalidateBranchCache() {
        branchRefCache.delete(`${this.owner}/${this.repo}/${this.branch}`);
      }
      // True when a branch read came back older than a commit this installation has
      // already placed on that branch — a stale replica, not a branch that moved.
      //
      // Building a commit on top of such a head is guaranteed to be rejected as a
      // non-fast-forward, because the parent is not the real tip. Costs nothing in
      // the ordinary case: when the read matches what we last pushed, or when we
      // have pushed nothing yet, no request is made.
      async isStaleHead(headSha) {
        const known = lastPushedHead.get(`${this.owner}/${this.repo}/${this.branch}`);
        if (!known || known === headSha) return false;
        try {
          return (await this.compareCommits(headSha, known)).status === "ahead";
        } catch (e) {
          return true;
        }
      }
      async conditionalGet(path, etag) {
        this.ensureConfigured();
        const headers = {
          "Accept": "application/vnd.github+json",
          "Authorization": `Bearer ${this.token}`,
          "X-GitHub-Api-Version": this.apiVersion,
          "User-Agent": "gitsync"
        };
        if (etag) {
          headers["If-None-Match"] = etag;
        }
        try {
          const response = await (0, import_obsidian.requestUrl)({
            url: `${this.baseUrl}${path}`,
            method: "GET",
            headers,
            throw: false
          });
          if (response.status === 304) {
            return { status: 304, body: void 0, etag };
          }
          let parsed = void 0;
          try {
            parsed = response.text ? JSON.parse(response.text) : void 0;
          } catch (e) {
            parsed = response.text;
          }
          if (response.status < 200 || response.status >= 300) {
            const detail = typeof parsed === "object" && parsed !== null && "message" in parsed && typeof parsed.message === "string" ? parsed.message : `HTTP ${response.status}`;
            throw new GitHubApiError(
              response.status,
              `${detail} (GET ${path})`,
              parsed
            );
          }
          return {
            status: response.status,
            body: parsed,
            etag: readEtag(response.headers)
          };
        } catch (error) {
          if (error instanceof GitHubApiError) {
            throw error;
          }
          throw new GitHubApiError(
            0,
            "Unable to reach GitHub. Check the network connection.",
            error
          );
        }
      }
      async getCommit(shaOrRef) {
        return this.request(
          "GET",
          `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/git/commits/${encodeURIComponent(shaOrRef)}`
        );
      }
      // How head relates to base, in one request. "ahead" means base is an ancestor
      // of head — the ordinary case where the remote has simply moved forward.
      //
      // This is the guard that replaced waiting a minute to see whether a file
      // stayed missing. GitHub's Git Database API is read-after-write eventually
      // consistent, so a read taken moments after a push can hand back an older
      // commit, whose tree is missing files that genuinely exist. Against that
      // older tree every one of those files reads as a deletion. Asking how the two
      // commits are related turns that from an indistinguishable case into a
      // "behind", and deletions are simply not applied unless the answer is "ahead".
      async compareCommits(baseSha, headSha) {
        var _a;
        const response = await this.request(
          "GET",
          `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/compare/${encodeURIComponent(baseSha)}...${encodeURIComponent(headSha)}`
        );
        const commits = ((_a = response.commits) != null ? _a : []).map((entry) => {
          var _a2, _b;
          return {
            sha: entry.sha,
            message: (_b = (_a2 = entry.commit) == null ? void 0 : _a2.message) != null ? _b : ""
          };
        });
        switch (response.status) {
          case "ahead":
          case "behind":
          case "identical":
          case "diverged":
            return { status: response.status, commits };
          default:
            return { status: "diverged", commits };
        }
      }
      async getTree(treeSha, recursive = true) {
        if (treeSha === EMPTY_TREE_SHA) {
          return { sha: treeSha, url: "", tree: [], truncated: false };
        }
        const query = recursive ? "?recursive=1" : "";
        return this.request(
          "GET",
          `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/git/trees/${encodeURIComponent(treeSha)}${query}`
        );
      }
      async getBlob(sha) {
        return this.request(
          "GET",
          `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/git/blobs/${encodeURIComponent(sha)}`
        );
      }
      async createBlob(content, encoding) {
        return this.request(
          "POST",
          `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/git/blobs`,
          { content, encoding }
        );
      }
      async createTree(baseTreeSha, tree) {
        return this.request(
          "POST",
          `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/git/trees`,
          {
            base_tree: baseTreeSha,
            tree
          }
        );
      }
      async createCommit(message, treeSha, parentSha) {
        return this.request(
          "POST",
          `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/git/commits`,
          {
            message,
            tree: treeSha,
            parents: [parentSha]
          }
        );
      }
      async updateReference(currentRef, newCommitSha) {
        const branchName = currentRef.ref.replace(/^refs\/heads\//, "");
        branchRefCache.delete(`${this.owner}/${this.repo}/${this.branch}`);
        const updated = await this.request(
          "PATCH",
          `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/git/refs/heads/${encodeURIComponent(branchName)}`,
          {
            sha: newCommitSha,
            force: false
          }
        );
        lastPushedHead.set(`${this.owner}/${this.repo}/${this.branch}`, newCommitSha);
        return updated;
      }
      branchRef() {
        return `heads/${this.branch}`;
      }
    };
  }
});

// src/vault/PathFilter.ts
function normalizePath(path) {
  return path.replace(/\\/g, "/").replace(/^\/+/, "");
}
function isSafeVaultPath(path) {
  const normalized = normalizePath(path);
  if (!normalized || normalized.startsWith("../") || normalized.includes("/../") || normalized === "..") {
    return false;
  }
  return !normalized.split("/").some((part) => part === "");
}
function isIgnoredPath(path, ignoredPaths) {
  const normalized = normalizePath(path);
  const matches = (candidate) => candidate !== "" && (normalized === candidate || normalized.startsWith(`${candidate}/`));
  if (ALWAYS_IGNORED_PREFIXES.some(matches)) return true;
  return ignoredPaths.some((ignored) => matches(normalizePath(ignored.trim())));
}
function matchesExtensions(path, extensions) {
  const normalizedPath = normalizePath(path).toLowerCase();
  const normalizedExtensions = extensions.map(normalizeExtension);
  return normalizedExtensions.some((extension) => normalizedPath.endsWith(extension));
}
var ALWAYS_IGNORED_PREFIXES;
var init_PathFilter = __esm({
  "src/vault/PathFilter.ts"() {
    init_VaultScanner();
    ALWAYS_IGNORED_PREFIXES = [".trash", ".obsidian"];
  }
});

// src/vault/VaultScanner.ts
var VaultScanner_exports = {};
__export(VaultScanner_exports, {
  VaultScanner: () => VaultScanner,
  base64ToArrayBuffer: () => base64ToArrayBuffer,
  bytesToBase64: () => bytesToBase64,
  gitBlobSha: () => gitBlobSha,
  normalizeExtension: () => normalizeExtension,
  sha256: () => sha256
});
function normalizeExtension(extension) {
  const value = extension.trim().toLowerCase();
  if (!value) return "";
  return value.startsWith(".") ? value : `.${value}`;
}
async function sha256(data) {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function gitBlobSha(data) {
  const content = new Uint8Array(data);
  const header = new TextEncoder().encode(`blob ${content.length}\0`);
  const payload = new Uint8Array(header.length + content.length);
  payload.set(header, 0);
  payload.set(content, header.length);
  const digest = await crypto.subtle.digest("SHA-1", payload);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function bytesToBase64(data) {
  const bytes = new Uint8Array(data);
  const chunkSize = 32768;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}
function base64ToArrayBuffer(value) {
  const binary = atob(value.replace(/\n/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}
var import_obsidian2, VaultScanner;
var init_VaultScanner = __esm({
  "src/vault/VaultScanner.ts"() {
    import_obsidian2 = require("obsidian");
    init_PathFilter();
    VaultScanner = class {
      constructor(vault, settings) {
        this.vault = vault;
        this.settings = settings;
      }
      getEligibleFiles(extensions) {
        return this.vault.getFiles().filter((file) => {
          const path = normalizePath(file.path);
          return matchesExtensions(path, extensions) && !isIgnoredPath(path, this.settings.ignoredPaths);
        });
      }
      async readSnapshot(file) {
        const bytes = await this.vault.readBinary(file);
        return {
          path: normalizePath(file.path),
          hash: await sha256(bytes),
          bytes
        };
      }
      async getLocalHash(file) {
        const bytes = await this.vault.readBinary(file);
        return sha256(bytes);
      }
      async findFile(path) {
        const normalized = normalizePath(path);
        const abstract = this.vault.getAbstractFileByPath(normalized);
        return abstract instanceof import_obsidian2.TFile ? abstract : null;
      }
    };
  }
});

// src/main.ts
var main_exports = {};
__export(main_exports, {
  default: () => GitSyncPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian11 = require("obsidian");
init_types();

// src/sync/SyncState.ts
init_types();
var SyncStateStore = class {
  constructor(plugin, getSettings, getState) {
    this.plugin = plugin;
    this.getSettings = getSettings;
    this.getState = getState;
  }
  async load() {
    var _a, _b, _c, _d;
    const stored = await this.plugin.loadData();
    const state = stored == null ? void 0 : stored.state;
    const merged = {
      ...DEFAULT_STATE,
      ...state != null ? state : {},
      trackedFiles: (_a = state == null ? void 0 : state.trackedFiles) != null ? _a : {},
      conflicts: (_b = state == null ? void 0 : state.conflicts) != null ? _b : {},
      // Absent on state written before the tree snapshot existed. An empty map
      // is the safe reading: no path was in it, so nothing looks deleted, and
      // the first pull records the real tree.
      lastSyncedTree: (_c = state == null ? void 0 : state.lastSyncedTree) != null ? _c : {},
      pendingRenames: (_d = state == null ? void 0 : state.pendingRenames) != null ? _d : {}
    };
    if (!merged.deviceId) {
      merged.deviceId = generateDeviceId();
      await this.save(merged);
    }
    return merged;
  }
  async save(state) {
    await this.plugin.saveData({
      settings: this.getSettings(),
      state
    });
  }
};
function generateDeviceId() {
  const prefix = /iphone|ipad|ios/i.test(navigator.userAgent) ? "iphone" : "mac";
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const suffix = Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${prefix}-${suffix}`;
}

// src/sync/SyncManager.ts
var import_obsidian6 = require("obsidian");
init_GitHubClient();

// src/sync/PullManager.ts
var import_obsidian3 = require("obsidian");
init_VaultScanner();
init_PathFilter();
var PullManager = class {
  constructor(vault, github, settings) {
    this.vault = vault;
    this.github = github;
    this.settings = settings;
  }
  async applyRemoteChanges(remote, state, safeChangedPaths, safeDeletedPaths) {
    const deletedPaths = /* @__PURE__ */ new Set();
    const trace = [];
    const changed = [...safeChangedPaths].filter(
      (path) => this.isPullable(path, remote)
    );
    const pulled = await this.downloadAndWrite(changed, remote, state);
    for (const path of safeDeletedPaths) {
      if (!matchesExtensions(path, this.settings.pullExtensions)) {
        trace.push(`${path}: skipped, extension not in pullExtensions`);
        continue;
      }
      if (isIgnoredPath(path, this.settings.ignoredPaths)) {
        trace.push(`${path}: skipped, ignoredPaths`);
        continue;
      }
      const file = this.vault.getAbstractFileByPath(path);
      if (file instanceof import_obsidian3.TFile) {
        await this.vault.trash(file, false);
        trace.push(`${path}: found locally, moved to .trash`);
      } else {
        trace.push(`${path}: NOT found locally (getAbstractFileByPath returned ${file === null ? "null" : typeof file}) \u2014 nothing to trash, only bookkeeping cleared`);
      }
      delete state.trackedFiles[path];
      deletedPaths.add(path);
    }
    return { pulled, deletedPaths, trace };
  }
  // Used once, when the user chooses GitHub as the starting point on a vault
  // that already holds files. Unlike performInitialPull this does not refuse to
  // overwrite — the user has explicitly asked for the remote to win — but the
  // versions it replaces go to .trash rather than being destroyed, and files
  // that exist only locally are left completely alone.
  async adoptRemote(remote, state, confirmOverwrite) {
    if (this.settings.pullExtensions.length === 0) {
      throw new Error("Select at least one Pull Extension first.");
    }
    const paths = Array.from(remote.entries.keys()).filter(
      (path) => this.isPullable(path, remote)
    );
    const differing = [];
    for (const path of paths) {
      const file = this.vault.getAbstractFileByPath(normalizePath(path));
      if (!(file instanceof import_obsidian3.TFile)) continue;
      const entry = remote.entries.get(path);
      if (!(entry == null ? void 0 : entry.sha)) continue;
      if (await gitBlobSha(await this.vault.readBinary(file)) !== entry.sha) {
        differing.push(path);
      }
    }
    if (differing.length && !confirmOverwrite(differing)) {
      return { pulled: 0, replaced: 0, cancelled: true };
    }
    for (const path of differing) {
      const file = this.vault.getAbstractFileByPath(normalizePath(path));
      if (file instanceof import_obsidian3.TFile) {
        await this.vault.trash(file, false);
      }
    }
    const pulled = await this.downloadAndWrite(paths, remote, state);
    return { pulled, replaced: differing.length, cancelled: false };
  }
  async performInitialPull(remote, state) {
    if (this.settings.pullExtensions.length === 0) {
      throw new Error("Select at least one Pull Extension before the initial pull.");
    }
    const paths = Array.from(remote.entries.keys()).filter((path) => {
      const entry = remote.entries.get(path);
      return Boolean(
        entry && entry.type === "blob" && matchesExtensions(path, this.settings.pullExtensions) && !isIgnoredPath(path, this.settings.ignoredPaths) && isSafeVaultPath(path)
      );
    });
    const collisions = paths.filter((path) => this.vault.getAbstractFileByPath(path));
    if (collisions.length) {
      const SHOWN = 25;
      const list = collisions.slice(0, SHOWN).map((path) => `  \u2022 ${path}`).join("\n");
      const more = collisions.length > SHOWN ? `
  ...and ${collisions.length - SHOWN} more` : "";
      throw new Error(
        `Initial pull would overwrite ${collisions.length} existing local file(s). Remove them (or the whole vault's content) first, then retry:
` + list + more
      );
    }
    const pulled = await this.downloadAndWrite(paths, remote, state);
    return { pulled };
  }
  // Blobs are fetched a batch at a time rather than strictly one after another.
  // Each download is a separate round trip, and on a phone the serial version
  // spends nearly all of its time waiting. The batch is kept small so the
  // decoded contents of a large pull never all sit in memory at once.
  async downloadAndWrite(paths, remote, state) {
    const BATCH_SIZE = 4;
    let pulled = 0;
    for (let index = 0; index < paths.length; index += BATCH_SIZE) {
      const batch = paths.slice(index, index + BATCH_SIZE);
      const fetched = await Promise.all(
        batch.map(async (path) => {
          const entry = remote.entries.get(path);
          if (!(entry == null ? void 0 : entry.sha)) return null;
          const blob = await this.github.getBlob(entry.sha);
          return {
            path,
            sha: entry.sha,
            bytes: base64ToArrayBuffer(blob.content)
          };
        })
      );
      for (const item of fetched) {
        if (!item) continue;
        await this.writeBinaryFile(item.path, item.bytes);
        state.trackedFiles[item.path] = {
          localHash: await hashBuffer(item.bytes),
          remoteSha: item.sha,
          ...this.statOf(item.path)
        };
        pulled++;
      }
    }
    return pulled;
  }
  isPullable(path, remote) {
    const entry = remote.entries.get(path);
    return Boolean(
      entry && entry.type === "blob" && entry.sha && matchesExtensions(path, this.settings.pullExtensions) && !isIgnoredPath(path, this.settings.ignoredPaths) && isSafeVaultPath(path)
    );
  }
  // Read back after writing: the stat has to describe the file as it now sits on
  // disk, or the change detector's fast path will think it was edited.
  statOf(path) {
    const file = this.vault.getAbstractFileByPath(normalizePath(path));
    if (!(file instanceof import_obsidian3.TFile)) return {};
    return { mtime: file.stat.mtime, size: file.stat.size };
  }
  async writeBinaryFile(path, bytes) {
    const normalized = normalizePath(path);
    await this.ensureParentFolder(normalized);
    const existing = this.vault.getAbstractFileByPath(normalized);
    if (existing instanceof import_obsidian3.TFile) {
      await this.vault.modifyBinary(existing, bytes);
      return;
    }
    if (existing) {
      throw new Error(`Cannot write ${normalized}: a folder already exists at that path.`);
    }
    await this.vault.createBinary(normalized, bytes);
  }
  async ensureParentFolder(path) {
    const parts = path.split("/");
    parts.pop();
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.vault.getAbstractFileByPath(current)) {
        await this.vault.createFolder(current);
      }
    }
  }
};
async function hashBuffer(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// src/sync/PushManager.ts
var import_obsidian4 = require("obsidian");
init_types();
init_GitHubClient();
init_VaultScanner();

// src/sync/MergeAttempt.ts
init_VaultScanner();

// src/sync/TextMerge.ts
var MAX_ALIGNMENT_CELLS = 4e6;
function merge3(base, ours, theirs) {
  if (ours === theirs) return { merged: ours, clean: true };
  if (base === ours) return { merged: theirs, clean: true };
  if (base === theirs) return { merged: ours, clean: true };
  const baseLines = splitLines(base);
  const ourLines = splitLines(ours);
  const theirLines = splitLines(theirs);
  const ourRegions = diffRegions(baseLines, ourLines);
  const theirRegions = diffRegions(baseLines, theirLines);
  if (!ourRegions || !theirRegions) return null;
  const output = [];
  let cursor = 0;
  let ourIndex = 0;
  let theirIndex = 0;
  while (ourIndex < ourRegions.length || theirIndex < theirRegions.length) {
    const ourRegion = ourRegions[ourIndex];
    const theirRegion = theirRegions[theirIndex];
    const takeOurs = theirRegion === void 0 || ourRegion !== void 0 && ourRegion.baseStart <= theirRegion.baseStart;
    const region = takeOurs ? ourRegion : theirRegion;
    if (!region) break;
    const counterpart = takeOurs ? theirRegion : ourRegion;
    for (let line = cursor; line < region.baseStart; line++) {
      output.push(baseLines[line]);
    }
    const overlaps = counterpart !== void 0 && regionsCollide(region, counterpart);
    if (!overlaps) {
      const source = takeOurs ? ourLines : theirLines;
      for (let line = region.otherStart; line < region.otherEnd; line++) {
        output.push(source[line]);
      }
      cursor = Math.max(cursor, region.baseEnd);
      if (takeOurs) ourIndex++;
      else theirIndex++;
      continue;
    }
    const ourText = ourLines.slice(ourRegion.otherStart, ourRegion.otherEnd).join("\n");
    const theirText = theirLines.slice(theirRegion.otherStart, theirRegion.otherEnd).join("\n");
    if (ourText !== theirText) {
      return null;
    }
    output.push(...ourLines.slice(ourRegion.otherStart, ourRegion.otherEnd));
    cursor = Math.max(cursor, ourRegion.baseEnd, theirRegion.baseEnd);
    ourIndex++;
    theirIndex++;
  }
  for (let line = cursor; line < baseLines.length; line++) {
    output.push(baseLines[line]);
  }
  return { merged: output.join("\n"), clean: true };
}
function splitLines(value) {
  return value.split("\n");
}
function regionsCollide(a, b) {
  if (a.baseStart === b.baseStart) return true;
  return a.baseStart < b.baseEnd && b.baseStart < a.baseEnd;
}
function diffRegions(base, other) {
  let start = 0;
  while (start < base.length && start < other.length && base[start] === other[start]) {
    start++;
  }
  let baseEnd = base.length;
  let otherEnd = other.length;
  while (baseEnd > start && otherEnd > start && base[baseEnd - 1] === other[otherEnd - 1]) {
    baseEnd--;
    otherEnd--;
  }
  if (start === baseEnd && start === otherEnd) return [];
  const midBase = base.slice(start, baseEnd);
  const midOther = other.slice(start, otherEnd);
  if (midBase.length * midOther.length > MAX_ALIGNMENT_CELLS) return null;
  const regions = [];
  for (const block of alignedBlocks(midBase, midOther)) {
    regions.push({
      baseStart: block.baseStart + start,
      baseEnd: block.baseEnd + start,
      otherStart: block.otherStart + start,
      otherEnd: block.otherEnd + start
    });
  }
  return regions;
}
function alignedBlocks(base, other) {
  const rows = base.length;
  const columns = other.length;
  const table = Array.from(
    { length: rows + 1 },
    () => new Array(columns + 1).fill(0)
  );
  for (let row2 = rows - 1; row2 >= 0; row2--) {
    for (let column2 = columns - 1; column2 >= 0; column2--) {
      table[row2][column2] = base[row2] === other[column2] ? table[row2 + 1][column2 + 1] + 1 : Math.max(table[row2 + 1][column2], table[row2][column2 + 1]);
    }
  }
  const matches = [];
  let row = 0;
  let column = 0;
  while (row < rows && column < columns) {
    if (base[row] === other[column]) {
      matches.push([row, column]);
      row++;
      column++;
    } else if (table[row + 1][column] >= table[row][column + 1]) {
      row++;
    } else {
      column++;
    }
  }
  const regions = [];
  let baseCursor = 0;
  let otherCursor = 0;
  for (const [matchedBase, matchedOther] of matches) {
    if (matchedBase > baseCursor || matchedOther > otherCursor) {
      regions.push({
        baseStart: baseCursor,
        baseEnd: matchedBase,
        otherStart: otherCursor,
        otherEnd: matchedOther
      });
    }
    baseCursor = matchedBase + 1;
    otherCursor = matchedOther + 1;
  }
  if (baseCursor < rows || otherCursor < columns) {
    regions.push({
      baseStart: baseCursor,
      baseEnd: rows,
      otherStart: otherCursor,
      otherEnd: columns
    });
  }
  return regions;
}

// src/sync/MergeAttempt.ts
var MERGEABLE_EXTENSIONS = [".md"];
async function attemptMerge(github, path, localBytes, tracked, remoteEntry) {
  if (!MERGEABLE_EXTENSIONS.some((ext) => path.toLowerCase().endsWith(ext))) {
    return null;
  }
  if (!(tracked == null ? void 0 : tracked.remoteSha) || !(remoteEntry == null ? void 0 : remoteEntry.sha)) return null;
  if (tracked.remoteSha === remoteEntry.sha) return null;
  try {
    const [baseBlob, theirBlob] = await Promise.all([
      github.getBlob(tracked.remoteSha),
      github.getBlob(remoteEntry.sha)
    ]);
    const decoder = new TextDecoder();
    const theirBytes = base64ToArrayBuffer(theirBlob.content);
    const base = decoder.decode(base64ToArrayBuffer(baseBlob.content));
    const theirs = decoder.decode(theirBytes);
    const ours = decoder.decode(localBytes);
    const result = merge3(base, ours, theirs);
    if (!(result == null ? void 0 : result.clean)) return null;
    return { merged: result.merged, theirBytes };
  } catch (error) {
    console.error("[GitSync] merge unavailable for", path, error);
    return null;
  }
}

// src/sync/RenameRecord.ts
var PREFIX = "Renamed: ";
function formatRenameLine(pairs) {
  return `${PREFIX}${JSON.stringify(pairs)}`;
}
function renamesDeclaredIn(commits) {
  var _a;
  const renames = /* @__PURE__ */ new Map();
  for (const commit of commits) {
    for (const line of commit.message.split("\n")) {
      if (!line.startsWith(PREFIX)) continue;
      for (const [from, to] of parseRenameLine(line)) {
        const origin = (_a = [...renames].find(([, current]) => current === from)) == null ? void 0 : _a[0];
        if (origin) {
          if (origin === to) renames.delete(origin);
          else renames.set(origin, to);
          continue;
        }
        renames.set(from, to);
      }
    }
  }
  return renames;
}
function parseRenameLine(line) {
  try {
    const parsed = JSON.parse(line.slice(PREFIX.length));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (pair) => Array.isArray(pair) && pair.length === 2 && typeof pair[0] === "string" && typeof pair[1] === "string" && pair[0].length > 0 && pair[1].length > 0 && pair[0] !== pair[1]
    );
  } catch (e) {
    return [];
  }
}

// src/sync/PushManager.ts
init_PathFilter();

// src/sync/ChangeDetector.ts
init_types();
init_PathFilter();
init_VaultScanner();
var ChangeDetector = class {
  constructor(vault, settings) {
    this.vault = vault;
    this.settings = settings;
  }
  async detectLocalChanges(state, extensions, userNamed = /* @__PURE__ */ new Set()) {
    const eligible = /* @__PURE__ */ new Map();
    for (const file of this.vault.getFiles()) {
      const path = normalizePath(file.path);
      if (matchesExtensions(path, extensions) && !isIgnoredPath(path, this.settings.ignoredPaths)) {
        eligible.set(path, file);
      }
    }
    const modifiedOrCreated = /* @__PURE__ */ new Set();
    const deleted = /* @__PURE__ */ new Set();
    const deferred = /* @__PURE__ */ new Map();
    for (const [path, file] of eligible) {
      const tracked = state.trackedFiles[path];
      if (!tracked) {
        const settledAt = file.stat.ctime + NEW_FILE_SETTLE_MS;
        if (!userNamed.has(path) && file.stat.size === 0 && Date.now() < settledAt) {
          deferred.set(path, settledAt);
          continue;
        }
        modifiedOrCreated.add(path);
        continue;
      }
      if (tracked.mtime !== void 0 && tracked.size !== void 0 && file.stat.mtime === tracked.mtime && file.stat.size === tracked.size) {
        continue;
      }
      const bytes = await this.vault.readBinary(file);
      const hash = await sha256(bytes);
      if (hash !== tracked.localHash) {
        modifiedOrCreated.add(path);
        continue;
      }
      tracked.mtime = file.stat.mtime;
      tracked.size = file.stat.size;
    }
    for (const path of Object.keys(state.trackedFiles)) {
      if (!matchesExtensions(path, extensions)) continue;
      if (isIgnoredPath(path, this.settings.ignoredPaths)) continue;
      if (!eligible.has(path)) {
        deleted.add(path);
      }
    }
    return { modifiedOrCreated, deleted, deferred };
  }
  detectRemoteChanges(state, remote, extensions) {
    const changedOrCreated = /* @__PURE__ */ new Set();
    const deleted = /* @__PURE__ */ new Set();
    for (const [path, tracked] of Object.entries(state.trackedFiles)) {
      if (!matchesExtensions(path, extensions)) continue;
      if (isIgnoredPath(path, this.settings.ignoredPaths)) continue;
      const remoteEntry = remote.entries.get(path);
      if (!remoteEntry || remoteEntry.type !== "blob") {
        if (tracked.remoteSha !== null) {
          deleted.add(path);
        }
        continue;
      }
      if (remoteEntry.sha !== tracked.remoteSha) {
        changedOrCreated.add(path);
      }
    }
    for (const [path, remoteEntry] of remote.entries) {
      if (!matchesExtensions(path, extensions)) continue;
      if (isIgnoredPath(path, this.settings.ignoredPaths)) continue;
      if (remoteEntry.type !== "blob") continue;
      if (!state.trackedFiles[path]) {
        changedOrCreated.add(path);
      }
    }
    return { changedOrCreated, deleted };
  }
};

// src/sync/PushManager.ts
var MAX_PUSH_ATTEMPTS = 8;
var PUSH_RETRY_BACKOFF_MS = [400, 900, 2e3, 4e3, 6e3, 8e3, 1e4];
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function resultsInEmptyTree(remote, entries) {
  if (!entries.length) return false;
  if (entries.some((entry) => entry.sha !== null)) return false;
  const deleted = new Set(entries.map((entry) => entry.path));
  for (const path of remote.entries.keys()) {
    if (!deleted.has(path)) return false;
  }
  return true;
}
var BULK_DELETION_THRESHOLD = 5;
var PushManager = class {
  constructor(vault, github, settings) {
    this.vault = vault;
    this.github = github;
    this.settings = settings;
  }
  // Pushes local changes without pulling first.
  //
  // The merge happens on GitHub's side: the new tree is built with the remote's
  // current tree as its base and carries entries only for the files this device
  // touched. Every other path — including files another device just changed —
  // is inherited untouched. Two devices editing different files therefore merge
  // cleanly with no coordination at all.
  //
  // The one case that cannot be resolved this way is the same file changed in
  // both places. Those paths are detected here, withheld from the commit, and
  // returned as collisions.
  async push(state, options) {
    var _a, _b;
    if (this.settings.pushExtensions.length === 0) {
      return this.emptyResult();
    }
    let lastError = null;
    let staleReads = 0;
    for (let attempt = 1; attempt <= MAX_PUSH_ATTEMPTS; attempt++) {
      const ref = await this.github.getBranchReference(attempt > 1);
      const headSha = ref.object.sha;
      if (await this.github.isStaleHead(headSha)) {
        staleReads++;
        if (attempt < MAX_PUSH_ATTEMPTS) {
          await sleep(
            (_a = PUSH_RETRY_BACKOFF_MS[attempt - 1]) != null ? _a : PUSH_RETRY_BACKOFF_MS[PUSH_RETRY_BACKOFF_MS.length - 1]
          );
          continue;
        }
      }
      const headCommit = await this.github.getCommit(headSha);
      const remote = await this.readRemoteTree(headSha, headCommit.tree.sha);
      const plan = await this.planPush(state, remote, options);
      if (!plan.entries.length) {
        return {
          pushed: false,
          changedCount: 0,
          commitSha: null,
          collisions: plan.collisions,
          withheldDeletions: plan.withheldDeletions,
          remote,
          deletedPaths: [],
          writtenShas: {},
          deferredUntil: plan.deferredUntil,
          trace: plan.trace
        };
      }
      const emptying = resultsInEmptyTree(remote, plan.entries);
      if (emptying) plan.trace.push("this commit removes every remaining file \u2014 using the empty-tree sha directly, GitHub's create-tree endpoint 404s on that case");
      const tree = emptying ? { sha: EMPTY_TREE_SHA } : await this.github.createTree(remote.treeSha, plan.entries);
      const message = buildCommitMessage(plan.renamedPaths, state.pendingRenames);
      const commit = await this.github.createCommit(message, tree.sha, headSha);
      try {
        await this.github.updateReference(ref, commit.sha);
      } catch (error) {
        if (isBranchMovedError(error) && attempt < MAX_PUSH_ATTEMPTS) {
          lastError = error;
          await sleep(
            (_b = PUSH_RETRY_BACKOFF_MS[attempt - 1]) != null ? _b : PUSH_RETRY_BACKOFF_MS[PUSH_RETRY_BACKOFF_MS.length - 1]
          );
          continue;
        }
        throw error;
      }
      for (const path of plan.deletedPaths) {
        delete state.trackedFiles[path];
      }
      for (const path of plan.renamedPaths) {
        delete state.pendingRenames[path];
      }
      for (const [path, tracked] of plan.pushedTracking) {
        state.trackedFiles[path] = tracked;
      }
      return {
        pushed: true,
        changedCount: plan.entries.length,
        commitSha: commit.sha,
        collisions: plan.collisions,
        withheldDeletions: plan.withheldDeletions,
        remote,
        deferredUntil: plan.deferredUntil,
        deletedPaths: [...plan.deletedPaths, ...plan.renamedPaths],
        writtenShas: Object.fromEntries(
          [...plan.pushedTracking].flatMap(
            ([path, tracked]) => tracked.remoteSha ? [[path, tracked.remoteSha]] : []
          )
        ),
        trace: plan.trace
      };
    }
    throw new Error(
      staleReads >= MAX_PUSH_ATTEMPTS - 1 ? `GitHub kept returning a branch position older than this device's own last push, across ${MAX_PUSH_ATTEMPTS} attempts. Nothing was force-pushed and your changes are still local. This usually clears within a minute \u2014 the next push will send them.` : `The branch moved ${MAX_PUSH_ATTEMPTS} times while this push was being built, so it was abandoned rather than force-pushed. Your changes are still local and the next push will send them.` + (lastError instanceof Error ? ` (${lastError.message})` : "")
    );
  }
  async planPush(state, remote, options) {
    var _a;
    const detector = new ChangeDetector(this.vault, this.settings);
    const detected = await detector.detectLocalChanges(
      state,
      this.settings.pushExtensions,
      options.userNamed
    );
    const trace = [
      `vault rescan found deleted=[${[...detected.deleted].join(", ")}] modifiedOrCreated=[${[...detected.modifiedOrCreated].join(", ")}]`
    ];
    const entries = [];
    const collisions = [];
    const deletedPaths = [];
    const withheldDeletions = [];
    const renamedPaths = [];
    const pushedTracking = /* @__PURE__ */ new Map();
    for (const path of detected.modifiedOrCreated) {
      if (!this.isPushable(path)) continue;
      const file = this.vault.getAbstractFileByPath(path);
      if (!(file instanceof import_obsidian4.TFile)) continue;
      const bytes = await this.vault.readBinary(file);
      const localBlobSha = await gitBlobSha(bytes);
      const remoteEntry = remote.entries.get(path);
      const tracked = state.trackedFiles[path];
      if ((remoteEntry == null ? void 0 : remoteEntry.sha) === localBlobSha) {
        state.trackedFiles[path] = {
          localHash: await sha256(bytes),
          remoteSha: localBlobSha,
          mtime: file.stat.mtime,
          size: file.stat.size
        };
        continue;
      }
      const remoteIsUnknown = remoteEntry !== void 0 && (!tracked || tracked.remoteSha !== remoteEntry.sha);
      if (remoteIsUnknown) {
        const outcome = await attemptMerge(this.github, path, bytes, tracked, remoteEntry);
        if (!outcome) {
          collisions.push(path);
          continue;
        }
        await this.vault.modify(file, outcome.merged);
        const mergedBytes = await this.vault.readBinary(file);
        const mergedBlob = await this.github.createBlob(
          bytesToBase64(mergedBytes),
          "base64"
        );
        entries.push({ path, mode: "100644", type: "blob", sha: mergedBlob.sha });
        pushedTracking.set(path, {
          localHash: await sha256(mergedBytes),
          remoteSha: mergedBlob.sha,
          mtime: file.stat.mtime,
          size: file.stat.size
        });
        continue;
      }
      const blob = await this.github.createBlob(bytesToBase64(bytes), "base64");
      entries.push({ path, mode: "100644", type: "blob", sha: blob.sha });
      pushedTracking.set(path, {
        localHash: await sha256(bytes),
        remoteSha: blob.sha,
        mtime: file.stat.mtime,
        size: file.stat.size
      });
    }
    const renamedAway = /* @__PURE__ */ new Set();
    for (const [from, to] of Object.entries((_a = state.pendingRenames) != null ? _a : {})) {
      if (!this.isPushable(from)) continue;
      const destination = this.vault.getAbstractFileByPath(to);
      if (!(destination instanceof import_obsidian4.TFile)) {
        trace.push(
          `pendingRename ${from} -> ${to}: destination not resolvable via getAbstractFileByPath (got ${destination === null ? "null" : typeof destination}), dropped WITHOUT pushing a deletion for ${from}`
        );
        delete state.pendingRenames[from];
        continue;
      }
      renamedAway.add(from);
      const remoteEntry = remote.entries.get(from);
      if (!remoteEntry) {
        deletedPaths.push(from);
        renamedPaths.push(from);
        continue;
      }
      const tracked = state.trackedFiles[from];
      if ((tracked == null ? void 0 : tracked.remoteSha) && remoteEntry.sha !== tracked.remoteSha) {
        continue;
      }
      entries.push({ path: from, mode: "100644", type: "blob", sha: null });
      deletedPaths.push(from);
      renamedPaths.push(from);
    }
    const candidateDeletions = [...detected.deleted].filter(
      (path) => this.isPushable(path) && !renamedAway.has(path)
    );
    const excludedFromCandidates = [...detected.deleted].filter(
      (path) => !candidateDeletions.includes(path)
    );
    for (const path of excludedFromCandidates) {
      trace.push(
        `${path}: vault reports it deleted, but excluded from push \u2014 isPushable=${this.isPushable(path)}, renamedAway=${renamedAway.has(path)}`
      );
    }
    if (candidateDeletions.length) {
      const verdict = this.screenDeletions(candidateDeletions, state, options);
      trace.push(
        `screenDeletions candidates=[${candidateDeletions.join(", ")}] allowed=${verdict.allowed} includeDeletions=${options.includeDeletions} bulkThreshold=${BULK_DELETION_THRESHOLD}`
      );
      if (verdict.allowed) {
        for (const path of candidateDeletions) {
          const remoteEntry = remote.entries.get(path);
          if (!remoteEntry) {
            trace.push(`${path}: already absent on remote, bookkeeping only`);
            deletedPaths.push(path);
            continue;
          }
          const tracked = state.trackedFiles[path];
          if ((tracked == null ? void 0 : tracked.remoteSha) && remoteEntry.sha !== tracked.remoteSha) {
            trace.push(`${path}: remote changed since last seen, treated as collision \u2014 not deleted`);
            collisions.push(path);
            continue;
          }
          trace.push(`${path}: queued for deletion in this commit`);
          entries.push({ path, mode: "100644", type: "blob", sha: null });
          deletedPaths.push(path);
        }
      } else {
        withheldDeletions.push(...candidateDeletions);
      }
    }
    const deferredUntil = detected.deferred.size ? Math.min(...detected.deferred.values()) : null;
    return {
      entries,
      collisions,
      deletedPaths,
      withheldDeletions,
      renamedPaths,
      pushedTracking,
      deferredUntil,
      trace
    };
  }
  // Decides whether a set of apparent local deletions may be sent at all.
  screenDeletions(paths, state, options) {
    var _a, _b, _c, _d;
    if (!options.includeDeletions) {
      return { allowed: false };
    }
    const localCount = this.vault.getFiles().filter((file) => matchesExtensions(file.path, this.settings.pushExtensions)).length;
    if (localCount === 0 && Object.keys(state.trackedFiles).length > 0) {
      return { allowed: (_b = (_a = options.confirmDeletions) == null ? void 0 : _a.call(options, paths)) != null ? _b : false };
    }
    if (paths.length >= BULK_DELETION_THRESHOLD) {
      return { allowed: (_d = (_c = options.confirmDeletions) == null ? void 0 : _c.call(options, paths)) != null ? _d : false };
    }
    return { allowed: true };
  }
  isPushable(path) {
    return isSafeVaultPath(path) && !isIgnoredPath(path, this.settings.ignoredPaths) && matchesExtensions(path, this.settings.pushExtensions);
  }
  async readRemoteTree(commitSha, treeSha) {
    const response = await this.github.getTree(treeSha, true);
    if (response.truncated) {
      throw new Error(
        "The GitHub tree is too large for recursive retrieval. This first version requires a repository tree within GitHub's recursive tree limit."
      );
    }
    const entries = /* @__PURE__ */ new Map();
    for (const entry of response.tree) {
      if (entry.type === "blob") {
        entries.set(entry.path.replace(/\\/g, "/"), entry);
      }
    }
    return { commitSha, treeSha, entries };
  }
  emptyResult() {
    return {
      pushed: false,
      changedCount: 0,
      commitSha: null,
      collisions: [],
      withheldDeletions: [],
      remote: null,
      deletedPaths: [],
      writtenShas: {},
      deferredUntil: null,
      trace: ["no pushExtensions configured \u2014 nothing is ever pushed"]
    };
  }
};
function isBranchMovedError(error) {
  return error instanceof GitHubApiError && (error.status === 422 || error.status === 409);
}
function devicePlatform() {
  return /iphone|ipad|ios/i.test(navigator.userAgent) ? "mobile" : "desktop";
}
function formatTimestamp(date) {
  const pad = (value) => value.toString().padStart(2, "0");
  const day = [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join("-");
  const time = [pad(date.getHours()), pad(date.getMinutes()), pad(date.getSeconds())].join(":");
  return `${day} ${time}`;
}
function buildCommitMessage(renamedPaths, pendingRenames) {
  const header = `Sync from ${devicePlatform()} at ${formatTimestamp(new Date())}`;
  const pairs = renamedPaths.filter((from) => typeof pendingRenames[from] === "string").map((from) => [from, pendingRenames[from]]);
  if (!pairs.length) return header;
  return `${header}
${formatRenameLine(pairs)}`;
}

// src/sync/ConflictDetector.ts
var import_obsidian5 = require("obsidian");
init_PathFilter();
init_VaultScanner();
var ConflictDetector = class {
  constructor(vault, settingsIgnoredPaths) {
    this.vault = vault;
    this.settingsIgnoredPaths = settingsIgnoredPaths;
  }
  async detect(state, remote, localChanged, remoteChanged, remoteDeleted) {
    var _a;
    const conflicts = [];
    const identical = /* @__PURE__ */ new Map();
    const remoteChangedPaths = /* @__PURE__ */ new Set([
      ...remoteChanged,
      ...remoteDeleted
    ]);
    for (const path of localChanged) {
      if (!remoteChangedPaths.has(path)) continue;
      if (isIgnoredPath(path, this.settingsIgnoredPaths)) continue;
      const file = this.vault.getAbstractFileByPath(path);
      const bytes = file instanceof import_obsidian5.TFile ? await this.vault.readBinary(file) : null;
      const localHash = bytes ? await sha256(bytes) : null;
      const remoteEntry = remote.entries.get(path);
      if (bytes && localHash && remoteEntry && remoteEntry.type === "blob" && remoteEntry.sha && await gitBlobSha(bytes) === remoteEntry.sha) {
        identical.set(path, { localHash, remoteSha: remoteEntry.sha });
        continue;
      }
      conflicts.push({
        path,
        detectedAt: (/* @__PURE__ */ new Date()).toISOString(),
        localHash,
        remoteSha: (_a = remoteEntry == null ? void 0 : remoteEntry.sha) != null ? _a : null,
        remoteExists: Boolean(remoteEntry && remoteEntry.type === "blob"),
        conflictCopyPath: null
      });
    }
    return { conflicts, identical };
  }
};

// src/sync/SyncManager.ts
init_PathFilter();
init_VaultScanner();
init_types();
var SyncManager = class {
  constructor(plugin, vault, settings, stateStore, state, setStatus, refreshUI) {
    this.plugin = plugin;
    this.vault = vault;
    this.settings = settings;
    this.stateStore = stateStore;
    this.state = state;
    this.setStatus = setStatus;
    this.refreshUI = refreshUI;
    this.running = false;
    this.requested = false;
    this.dirty = false;
    this.pushTimer = null;
    this.pollTimer = null;
    // Nothing automatic — no poll, no debounced push, no follow-up requested
    // mid-push — runs before this moment. It is re-armed when a push finishes,
    // so the next attempt never lands on a branch read GitHub has not caught up
    // with yet: that read is what turned an edit made during a push into a
    // spurious conflict.
    this.syncHoldUntil = 0;
    // Paths this plugin has just written, against the moment the flag lapses.
    this.selfWrites = /* @__PURE__ */ new Map();
    // Paths the user renamed before they were ever pushed. Held in memory only —
    // it matters for the minute between creating a note and pushing it.
    this.userNamed = /* @__PURE__ */ new Set();
    this.activity = [];
  }
  getState() {
    return this.state;
  }
  getActivity() {
    return this.activity;
  }
  // Flags paths the plugin is about to write, so the vault events that follow
  // are recognised as this plugin's own work rather than the user's.
  // Naming a note is the user finishing what Obsidian started. Until that
  // happens an empty new file is a placeholder and waits; afterwards it is an
  // ordinary new note and goes out on the usual delay, empty or not.
  markUserNamed(path) {
    this.userNamed.add(normalizePath(path));
  }
  markSelfWrite(...paths) {
    const until = Date.now() + SELF_WRITE_GRACE_MS;
    for (const path of paths) {
      this.selfWrites.set(normalizePath(path), until);
    }
  }
  // Consulted by the vault event handlers. Without it a pull feeds itself: the
  // files it writes look exactly like edits the user just made, so the vault is
  // marked dirty and pushed straight back, and a rename it applies is recorded
  // as a local rename and declared to the other device as though this vault had
  // performed it.
  isSelfWrite(path) {
    const key = normalizePath(path);
    const until = this.selfWrites.get(key);
    if (until === void 0) return false;
    if (Date.now() > until) {
      this.selfWrites.delete(key);
      return false;
    }
    return true;
  }
  // Newest first, capped. The side panel is the only reader, and it wants to
  // show what just happened without scrolling.
  record(kind, text) {
    this.activity.unshift({ at: Date.now(), kind, text });
    if (this.activity.length > ACTIVITY_LIMIT) {
      this.activity.length = ACTIVITY_LIMIT;
    }
    this.debug(`[${kind}] ${text}`);
    this.refreshUI();
  }
  // Same information as the in-memory activity list, but written to disk. The
  // status panel is lost the moment the app closes or the device is out of
  // sight; this is what lets a sync that happened on a device nobody is
  // watching still be read back afterward, from the outside, without asking
  // anyone to transcribe what a screen said.
  debug(line) {
    if (!this.state.debugLog) this.state.debugLog = [];
    this.state.debugLog.push(`${(/* @__PURE__ */ new Date()).toISOString()} ${line}`);
    const DEBUG_LOG_LIMIT = 200;
    if (this.state.debugLog.length > DEBUG_LOG_LIMIT) {
      this.state.debugLog.splice(0, this.state.debugLog.length - DEBUG_LOG_LIMIT);
    }
    void this.stateStore.save(this.state);
  }
  // Called from the vault's rename event, which is the only place the old and
  // new path are known together. Once the event is gone the old path is just a
  // file that is not there any more, indistinguishable from a deletion.
  recordRename(oldPath, newPath) {
    const from = normalizePath(oldPath);
    const to = normalizePath(newPath);
    if (!from || !to || from === to) return;
    const pairs = [[from, to]];
    for (const trackedPath of Object.keys(this.state.trackedFiles)) {
      if (trackedPath.startsWith(`${from}/`)) {
        pairs.push([trackedPath, `${to}${trackedPath.slice(from.length)}`]);
      }
    }
    for (const [start, end] of pairs) {
      this.applyRenamePair(start, end);
    }
    void this.stateStore.save(this.state);
  }
  applyRenamePair(from, to) {
    let origin = from;
    for (const [start, current] of Object.entries(this.state.pendingRenames)) {
      if (current === from) {
        origin = start;
        delete this.state.pendingRenames[start];
        break;
      }
    }
    if (origin === to) {
      delete this.state.pendingRenames[origin];
      return;
    }
    if (!this.state.trackedFiles[origin]) return;
    this.state.pendingRenames[origin] = to;
  }
  markDirty() {
    if (this.needsStartingPoint()) {
      this.dirty = true;
      return;
    }
    const wasClean = !this.dirty;
    this.dirty = true;
    this.setStatus("pending", "Local changes pending.");
    if (wasClean) this.record("info", "Local changes waiting to be pushed");
    this.scheduleDebouncedPush();
  }
  startPolling() {
    this.stopPolling();
    this.pollTimer = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") {
        return;
      }
      if (Date.now() < this.syncHoldUntil) return;
      void this.checkRemote();
    }, PULL_INTERVAL_MS);
  }
  stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
  async onActivation() {
    const last = this.state.lastRemoteCheck ? Date.parse(this.state.lastRemoteCheck) : 0;
    if (Date.now() - last < PULL_INTERVAL_MS) {
      return;
    }
    await this.checkRemote();
  }
  // True while this vault has never been linked to a commit. Everything
  // automatic stays inert until a starting point is chosen.
  needsStartingPoint() {
    return !this.state.lastSyncedCommit;
  }
  // "Upload this vault." Adopts the remote's current position without
  // downloading anything, then pushes. Every local file is untracked at this
  // point, so the push carries all of them; remote-only files are untouched on
  // GitHub and arrive with the next ordinary pull.
  async adoptLocal() {
    if (this.running) return;
    this.running = true;
    this.setStatus("pushing", "Uploading this vault...");
    try {
      const github = this.getClient();
      const ref = await github.getBranchReference(true);
      const commit = await github.getCommit(ref.object.sha);
      const remote = await this.getRemoteSnapshot(github, commit.sha, commit.tree.sha);
      this.state.lastSyncedCommit = remote.commitSha;
      this.state.lastSyncedTree = treeMapOf(remote);
      await this.stateStore.save(this.state);
      await this.performPush("adopt");
      new import_obsidian6.Notice("GitSync: this vault is now the starting point.");
    } catch (error) {
      this.state.lastSyncedCommit = null;
      this.state.lastSyncedTree = {};
      await this.stateStore.save(this.state);
      this.handleError(error);
    } finally {
      this.running = false;
    }
  }
  // "Download from GitHub." Overwrites this vault's copies with the remote's.
  // Files that exist only locally are left alone — this replaces what both
  // sides have, it does not empty the vault.
  async adoptRemote() {
    if (this.running) return;
    this.running = true;
    this.setStatus("pulling", "Downloading from GitHub...");
    try {
      const github = this.getClient();
      const ref = await github.getBranchReference(true);
      const commit = await github.getCommit(ref.object.sha);
      const remote = await this.getRemoteSnapshot(github, commit.sha, commit.tree.sha);
      const pull = new PullManager(this.vault, github, this.settings);
      const result = await pull.adoptRemote(
        remote,
        this.state,
        (paths) => window.confirm(
          `${paths.length} file(s) in this vault differ from GitHub and will be replaced.

The current versions are moved to the vault's .trash folder first:

` + paths.slice(0, 12).map((path) => `  \u2022 ${path}`).join("\n") + (paths.length > 12 ? `
  ...and ${paths.length - 12} more` : "") + "\n\nReplace them?"
        )
      );
      if (result.cancelled) {
        new import_obsidian6.Notice("GitSync: cancelled. Nothing was changed.");
        this.setStatus("pending", "No starting point chosen yet.");
        return;
      }
      this.state.lastSyncedCommit = remote.commitSha;
      this.state.lastSyncedTree = treeMapOf(remote);
      this.state.lastSuccessfulPull = (/* @__PURE__ */ new Date()).toISOString();
      this.state.lastRemoteCheck = (/* @__PURE__ */ new Date()).toISOString();
      await this.stateStore.save(this.state);
      this.dirty = false;
      this.setStatus("synced", `Downloaded ${result.pulled} file(s).`);
      new import_obsidian6.Notice(`GitSync: downloaded ${result.pulled} file(s) from GitHub.`);
      this.refreshUI();
    } catch (error) {
      this.state.lastSyncedCommit = null;
      this.state.lastSyncedTree = {};
      await this.stateStore.save(this.state);
      this.handleError(error);
    } finally {
      this.running = false;
    }
  }
  async initialPull() {
    if (this.running) {
      this.requested = true;
      return;
    }
    this.running = true;
    this.setStatus("pulling", "Initial pull...");
    try {
      const github = this.getClient();
      const ref = await github.getBranchReference();
      const commit = await github.getCommit(ref.object.sha);
      const remote = await this.getRemoteSnapshot(github, commit.sha, commit.tree.sha);
      const pull = new PullManager(this.vault, github, this.settings);
      const result = await pull.performInitialPull(remote, this.state);
      this.state.lastSyncedCommit = remote.commitSha;
      this.state.lastSyncedTree = treeMapOf(remote);
      this.state.lastRemoteCheck = (/* @__PURE__ */ new Date()).toISOString();
      this.state.lastSuccessfulPull = (/* @__PURE__ */ new Date()).toISOString();
      await this.stateStore.save(this.state);
      this.dirty = false;
      this.setStatus("synced", `Initial pull complete: ${result.pulled} file(s).`);
      new import_obsidian6.Notice(`GitSync: initial pull complete (${result.pulled} file(s)).`);
      this.refreshUI();
    } catch (error) {
      this.handleError(error);
    } finally {
      this.running = false;
      await this.runRequestedIfNeeded();
    }
  }
  async syncNow() {
    if (this.running) {
      this.requested = true;
      return;
    }
    this.running = true;
    this.setStatus("syncing", "Synchronizing...");
    try {
      await this.syncInternal();
    } catch (error) {
      this.handleError(error);
    } finally {
      this.running = false;
      await this.runRequestedIfNeeded();
    }
  }
  async pullNow() {
    if (this.running) {
      this.requested = true;
      return;
    }
    this.running = true;
    this.setStatus("pulling", "Pulling...");
    try {
      await this.pullInternal();
    } catch (error) {
      this.handleError(error);
    } finally {
      this.running = false;
      await this.runRequestedIfNeeded();
    }
  }
  // The manual Push. Unlike the debounced automatic push this carries deletions,
  // because a person pressing a button has an intent that a timer does not — and
  // deletions are still confirmed before a large batch is sent.
  async pushEverything() {
    if (this.running) {
      this.requested = true;
      return;
    }
    this.running = true;
    this.setStatus("pushing", "Pushing...");
    try {
      if (!this.state.lastSyncedCommit) {
        throw new Error(
          "This vault has not been linked to GitHub yet. Turn on automatic synchronization and choose a starting point first."
        );
      }
      await this.performPush("manual");
    } catch (error) {
      this.handleError(error);
    } finally {
      this.running = false;
      await this.runRequestedIfNeeded();
    }
  }
  async pushNow() {
    if (this.running) {
      this.requested = true;
      return;
    }
    this.running = true;
    this.setStatus("pushing", "Pushing...");
    try {
      await this.pushInternal();
    } catch (error) {
      this.handleError(error);
      if (this.dirty && !this.needsStartingPoint()) {
        this.scheduleDebouncedPush();
      }
    } finally {
      this.running = false;
      await this.runRequestedIfNeeded();
    }
  }
  // Sync Now is the only entry point that does both halves, and even here they
  // are two independent operations run in sequence, not one combined procedure.
  // Sync Now is the deliberate, full reconcile: the only place deletions move
  // in either direction.
  async syncInternal() {
    await this.pullInternal(true);
    await this.performPush("manual");
  }
  // Pull is how this device gets current. It runs on activation, on the poll
  // timer, and from Sync Now / Pull Now — never as a precondition of pushing.
  //
  // Deletions are applied here now rather than only on an explicit Sync Now.
  // The reason they were withheld was that a path missing from the remote tree
  // was indistinguishable from one this device had simply never pulled, and
  // from one a stale read had failed to mention. Neither is true any more:
  // lastSyncedTree says exactly what the remote held, and the comparison below
  // refuses to act at all unless the remote genuinely moved forward. Removed
  // files still go to the vault's .trash.
  async pullInternal(allowDeletions = true) {
    const github = this.getClient();
    if (!this.state.lastSyncedCommit) {
      await this.initialPull();
      return;
    }
    const ref = await github.getBranchReference();
    const remoteHead = ref.object.sha;
    if (remoteHead === this.state.lastSyncedCommit) {
      await this.pruneConflictsAgainstSyncedTree();
      this.state.lastRemoteCheck = (/* @__PURE__ */ new Date()).toISOString();
      await this.stateStore.save(this.state);
      this.setStatus(
        Object.keys(this.state.conflicts).length ? "conflict" : "synced",
        "No remote changes."
      );
      return;
    }
    const comparison = await github.compareCommits(
      this.state.lastSyncedCommit,
      remoteHead
    );
    const relation = comparison.status;
    if (relation === "identical" || relation === "behind") {
      github.invalidateBranchCache();
      this.state.lastRemoteCheck = (/* @__PURE__ */ new Date()).toISOString();
      await this.stateStore.save(this.state);
      this.setStatus(
        Object.keys(this.state.conflicts).length ? "conflict" : "synced",
        "No remote changes."
      );
      return;
    }
    await this.reconcileRemoteAndLocal(
      remoteHead,
      github,
      allowDeletions,
      relation,
      renamesDeclaredIn(comparison.commits)
    );
  }
  async pushInternal() {
    if (!this.state.lastSyncedCommit) {
      throw new Error("Complete an initial pull before pushing.");
    }
    await this.performPush("automatic");
  }
  // Push stands alone. It reads the branch itself, builds its commit on top of
  // whatever the remote currently holds, and retries if the branch moves while
  // it works. It never pulls first: GitHub carries over every path this device
  // did not touch, so a change made elsewhere to a different file survives
  // untouched. Getting this vault current is the pull path's job.
  // Deleting a note on one device should remove it on the other — that is
  // ordinary synchronization, not a special operation. What differs by trigger
  // is only how a *large* batch is treated: a person who pressed Push is there
  // to answer for it, whereas a background timer is not, so a bulk deletion
  // waits for someone to look at it rather than being confirmed by a dialog
  // nobody asked for.
  //
  // Everything that made deletions dangerous is now handled underneath: an
  // unbuilt vault index is refused outright, a file the other device edited is
  // reported as a collision instead of removed, and deleted files go to .trash.
  async performPush(trigger = "automatic") {
    this.syncHoldUntil = Date.now() + POLL_HOLD_AFTER_PUSH_MS;
    try {
      await this.performPushInternal(trigger);
    } finally {
      // The settling period counts from the moment the push actually finished.
      // Arming it only at the start left a long push clear to be followed
      // immediately by another one.
      this.syncHoldUntil = Date.now() + POLL_HOLD_AFTER_PUSH_MS;
    }
  }
  async performPushInternal(trigger) {
    var _a;
    const github = this.getClient();
    const push = new PushManager(this.vault, github, this.settings);
    const result = await push.push(this.state, {
      // Adoption is the one push that must not delete: nothing was tracked
      // before it, so every absence is meaningless rather than intentional.
      includeDeletions: trigger !== "adopt",
      userNamed: this.userNamed,
      confirmDeletions: (paths) => trigger === "manual" ? window.confirm(
        `Sync will delete ${paths.length} file(s) from GitHub because they are no longer in this vault:

` + paths.slice(0, 12).map((path) => `  \u2022 ${path}`).join("\n") + (paths.length > 12 ? `
  ...and ${paths.length - 12} more` : "") + "\n\nIf this vault has not finished loading, cancel and try again.\n\nDelete them on GitHub?"
      ) : false
    });
    this.debug(`push trigger=${trigger}`);
    for (const line of result.trace) this.debug(`push-trace ${line}`);
    if (result.remote) {
      await this.pruneResolvedConflicts(result.remote);
      await this.recordCollisions(result.collisions, result.remote);
    }
    if (result.withheldDeletions.length) {
      const held = result.withheldDeletions.length;
      this.record("info", `${held} deletion(s) held back`);
      new import_obsidian6.Notice(
        trigger === "manual" ? `GitSync: kept ${held} file(s) on GitHub. Nothing was deleted.` : `GitSync: ${held} deletion(s) held back. Use Push in settings to send them.`
      );
    }
    if (result.deletedPaths.length) {
      this.record("push", `Removed ${result.deletedPaths.length} file(s) from GitHub`);
    }
    if (result.pushed && result.commitSha) {
      this.state.lastSuccessfulPush = (/* @__PURE__ */ new Date()).toISOString();
      this.record(
        "push",
        `Pushed ${result.changedCount} change(s) to GitHub`
      );
      if (((_a = result.remote) == null ? void 0 : _a.commitSha) === this.state.lastSyncedCommit) {
        this.state.lastSyncedCommit = result.commitSha;
        const tree = treeMapOf(result.remote);
        for (const path of result.deletedPaths) delete tree[path];
        for (const [path, sha] of Object.entries(result.writtenShas)) tree[path] = sha;
        for (const path of Object.keys(result.writtenShas)) {
          this.userNamed.delete(path);
        }
        this.state.lastSyncedTree = tree;
      }
    }
    await this.pruneConflictsAgainstSyncedTree();
    this.state.lastRemoteCheck = (/* @__PURE__ */ new Date()).toISOString();
    await this.stateStore.save(this.state);
    this.dirty = false;
    if (result.deferredUntil !== null) {
      this.dirty = true;
      this.scheduleDeferredPush(result.deferredUntil);
    }
    const conflictCount = Object.keys(this.state.conflicts).length;
    this.setStatus(
      conflictCount ? "conflict" : "synced",
      conflictCount ? `${conflictCount} conflict(s) need attention.` : result.pushed ? `Pushed ${result.changedCount} change(s).` : "Nothing to push."
    );
    this.refreshUI();
  }
  // A collision is the one thing GitHub cannot merge for us: the same file
  // changed here and there. The local file is left exactly as it is and the
  // remote version is brought down beside it.
  async recordCollisions(paths, remote) {
    var _a;
    if (!paths.length) return;
    const conflicts = [];
    for (const path of paths) {
      if (this.state.conflicts[path]) continue;
      const file = this.vault.getAbstractFileByPath(path);
      const localHash = file instanceof import_obsidian6.TFile ? await sha256(await this.vault.readBinary(file)) : null;
      const remoteEntry = remote.entries.get(path);
      conflicts.push({
        path,
        detectedAt: (/* @__PURE__ */ new Date()).toISOString(),
        localHash,
        remoteSha: (_a = remoteEntry == null ? void 0 : remoteEntry.sha) != null ? _a : null,
        remoteExists: Boolean(remoteEntry && remoteEntry.type === "blob"),
        conflictCopyPath: null
      });
    }
    await this.recordConflicts(conflicts, remote);
  }
  // Combines a file that changed here and on the remote. Returns true when the
  // vault now holds merged text; false means it is a genuine conflict.
  async mergeDivergence(path, remote, github) {
    const file = this.vault.getAbstractFileByPath(path);
    if (!(file instanceof import_obsidian6.TFile)) return false;
    const bytes = await this.vault.readBinary(file);
    const tracked = this.state.trackedFiles[path];
    const remoteEntry = remote.entries.get(path);
    const outcome = await attemptMerge(github, path, bytes, tracked, remoteEntry);
    if (!outcome || !(remoteEntry == null ? void 0 : remoteEntry.sha)) return false;
    this.markSelfWrite(path);
    await this.vault.modify(file, outcome.merged);
    this.record("merge", `Merged remote edits into ${basename(path)}`);
    this.state.trackedFiles[path] = {
      localHash: await sha256(outcome.theirBytes),
      remoteSha: remoteEntry.sha
    };
    this.markDirty();
    return true;
  }
  // Records tracking for paths whose local bytes already match the remote blob,
  // and drops them from the pending change sets so neither side acts on them.
  reconcileIdentical(identical, localChanged, remoteChanged) {
    for (const [path, entry] of identical) {
      this.state.trackedFiles[path] = {
        localHash: entry.localHash,
        remoteSha: entry.remoteSha
      };
      localChanged.delete(path);
      remoteChanged.delete(path);
    }
  }
  // Pull only. This brings the vault up to the remote commit and never pushes;
  // outgoing changes are the debounced push's business.
  async reconcileRemoteAndLocal(remoteHeadSha, github, allowDeletions = false, relation = "ahead", declaredRenames = /* @__PURE__ */ new Map()) {
    this.setStatus("pulling", "Inspecting remote changes...");
    this.record("info", "New changes on GitHub");
    const remoteCommit = await github.getCommit(remoteHeadSha);
    const remote = await this.getRemoteSnapshot(
      github,
      remoteHeadSha,
      remoteCommit.tree.sha
    );
    await this.pruneResolvedConflicts(remote);
    const remoteChanged = this.remoteChangedAgainstState(remote);
    const remoteDeleted = this.remoteDeletedAgainstState(remote);
    this.debug(
      `pull-scan relation=${relation} remoteDeleted=[${[...remoteDeleted].join(", ")}] remoteChanged=[${[...remoteChanged].join(", ")}]`
    );
    const renames = this.detectRemoteRenames(remote, remoteDeleted, remoteChanged);
    for (const [from, to] of declaredRenames) {
      if (remoteDeleted.has(from) && remote.entries.has(to)) {
        renames.set(from, to);
      }
    }
    if (renames.size) {
      this.debug(`pull-renames detected=[${[...renames.entries()].map(([f, t]) => `${f}->${t}`).join(", ")}]`);
    }
    const renamed = await this.applyRemoteRenames(
      renames,
      remote,
      remoteDeleted,
      remoteChanged
    );
    this.debug(`pull-renames applied=${renamed} remoteDeletedAfter=[${[...remoteDeleted].join(", ")}]`);
    const deletionsTrustworthy = allowDeletions && relation === "ahead";
    if (allowDeletions && remoteDeleted.size && !deletionsTrustworthy) {
      new import_obsidian6.Notice(
        `GitSync: the remote has diverged from this vault, so ${remoteDeleted.size} deletion(s) were not applied.`
      );
    }
    const detector = new ChangeDetector(this.vault, this.settings);
    const local = await detector.detectLocalChanges(
      this.state,
      this.settings.pushExtensions,
      this.userNamed
    );
    const conflictDetector = new ConflictDetector(
      this.vault,
      this.settings.ignoredPaths
    );
    const detection = await conflictDetector.detect(
      this.state,
      remote,
      local.modifiedOrCreated,
      remoteChanged,
      remoteDeleted
    );
    this.reconcileIdentical(detection.identical, local.modifiedOrCreated, remoteChanged);
    const conflicts = [];
    for (const conflict of detection.conflicts) {
      const mergedPath = await this.mergeDivergence(conflict.path, remote, github);
      if (mergedPath) {
        remoteChanged.delete(conflict.path);
        continue;
      }
      conflicts.push(conflict);
    }
    await this.recordConflicts(conflicts, remote);
    const conflictPaths = new Set(conflicts.map((c) => c.path));
    const safeRemoteChanged = new Set(
      [...remoteChanged].filter((path) => !conflictPaths.has(path))
    );
    const safeRemoteDeleted = deletionsTrustworthy ? new Set([...remoteDeleted].filter((path) => !conflictPaths.has(path))) : /* @__PURE__ */ new Set();
    this.debug(
      `pull-delete-plan deletionsTrustworthy=${deletionsTrustworthy} conflictPaths=[${[...conflictPaths].join(", ")}] safeRemoteDeleted=[${[...safeRemoteDeleted].join(", ")}]`
    );
    this.markSelfWrite(...safeRemoteChanged, ...safeRemoteDeleted);
    const pull = new PullManager(this.vault, github, this.settings);
    const pullResult = await pull.applyRemoteChanges(
      remote,
      this.state,
      safeRemoteChanged,
      safeRemoteDeleted
    );
    this.debug(
      `pull-delete-result actuallyDeleted=[${[...pullResult.deletedPaths].join(", ")}] pulledFileCount=${pullResult.pulled}`
    );
    for (const line of pullResult.trace) this.debug(`pull-delete-trace ${line}`);
    const nextTree = treeMapOf(remote);
    let carriedForward = 0;
    for (const path of remoteDeleted) {
      if (pullResult.deletedPaths.has(path)) continue;
      const previous = this.state.lastSyncedTree[path];
      if (previous === void 0) continue;
      nextTree[path] = previous;
      carriedForward++;
    }
    if (carriedForward) {
      this.record("info", `${carriedForward} remote deletion(s) not applied yet`);
    }
    this.state.lastSyncedCommit = remoteHeadSha;
    this.state.lastSyncedTree = nextTree;
    this.state.lastRemoteCheck = (/* @__PURE__ */ new Date()).toISOString();
    this.state.lastSuccessfulPull = (/* @__PURE__ */ new Date()).toISOString();
    await this.stateStore.save(this.state);
    this.dirty = local.modifiedOrCreated.size > 0 || local.deleted.size > 0;
    if (this.dirty) {
      this.scheduleDebouncedPush();
    }
    this.setStatus(
      Object.keys(this.state.conflicts).length ? "conflict" : "synced",
      renamed ? `Pulled ${pullResult.pulled} file(s), moved ${renamed}.` : `Pulled ${pullResult.pulled} file(s).`
    );
    if (pullResult.pulled || renamed || pullResult.deletedPaths.size) {
      const parts = [];
      if (pullResult.pulled) parts.push(`${pullResult.pulled} file(s)`);
      if (renamed) parts.push(`${renamed} renamed`);
      if (pullResult.deletedPaths.size) {
        parts.push(`${pullResult.deletedPaths.size} removed`);
      }
      this.record("pull", `Pulled ${parts.join(", ")}`);
    }
    this.refreshUI();
  }
  async getRemoteSnapshot(github, commitSha, treeSha) {
    const response = await github.getTree(treeSha, true);
    if (response.truncated) {
      throw new Error(
        "The GitHub tree is too large for recursive retrieval. This first version requires a repository tree within GitHub's recursive tree limit."
      );
    }
    const entries = /* @__PURE__ */ new Map();
    for (const entry of response.tree) {
      if (entry.type === "blob") {
        entries.set(entry.path.replace(/\\/g, "/"), entry);
      }
    }
    return {
      commitSha,
      treeSha,
      entries
    };
  }
  remoteChangedAgainstState(remote) {
    const result = /* @__PURE__ */ new Set();
    const remoteExtensions = this.remoteTrackingExtensions();
    for (const [path, tracked] of Object.entries(this.state.trackedFiles)) {
      if (!matchesExtensions(path, remoteExtensions)) continue;
      if (isIgnoredPath(path, this.settings.ignoredPaths)) continue;
      const remoteEntry = remote.entries.get(path);
      if (remoteEntry && remoteEntry.type === "blob" && remoteEntry.sha !== tracked.remoteSha) {
        result.add(path);
      }
    }
    for (const [path, entry] of remote.entries) {
      if (!matchesExtensions(path, remoteExtensions)) continue;
      if (isIgnoredPath(path, this.settings.ignoredPaths)) continue;
      if (entry.type === "blob" && !this.state.trackedFiles[path]) {
        result.add(path);
      }
    }
    return result;
  }
  // A path was deleted when the tree this vault last synced to contained it and
  // the current tree does not. trackedFiles is deliberately not consulted here:
  // it holds only what this device happened to pull, which is what made a file
  // that was never this device's business look exactly like a deleted one.
  remoteDeletedAgainstState(remote) {
    const result = /* @__PURE__ */ new Set();
    const remoteExtensions = this.remoteTrackingExtensions();
    for (const path of Object.keys(this.state.lastSyncedTree)) {
      if (!matchesExtensions(path, remoteExtensions)) continue;
      if (isIgnoredPath(path, this.settings.ignoredPaths)) continue;
      if (!remote.entries.has(path)) {
        result.add(path);
      }
    }
    return result;
  }
  // A rename arrives at this device as one path vanishing and an unrelated path
  // appearing. Git does not record renames either — it recognises them by
  // noticing the content is unchanged, and the blob sha is precisely that
  // comparison, already computed by GitHub.
  //
  // A file renamed *and* edited in the same remote commit has a different sha
  // and is not matched. It falls through to delete-plus-download, which costs a
  // round trip and loses nothing.
  detectRemoteRenames(remote, remoteDeleted, remoteChanged) {
    var _a, _b;
    const renames = /* @__PURE__ */ new Map();
    if (!remoteDeleted.size) return renames;
    const arrivalsBySha = /* @__PURE__ */ new Map();
    for (const path of remoteChanged) {
      if (this.state.trackedFiles[path]) continue;
      const sha = (_a = remote.entries.get(path)) == null ? void 0 : _a.sha;
      if (!sha || sha === EMPTY_BLOB_SHA) continue;
      const existing = arrivalsBySha.get(sha);
      if (existing) existing.push(path);
      else arrivalsBySha.set(sha, [path]);
    }
    if (!arrivalsBySha.size) return renames;
    const claimed = /* @__PURE__ */ new Set();
    for (const from of remoteDeleted) {
      const sha = this.state.lastSyncedTree[from];
      if (!sha || sha === EMPTY_BLOB_SHA) continue;
      const to = (_b = arrivalsBySha.get(sha)) == null ? void 0 : _b.find((path) => !claimed.has(path));
      if (!to) continue;
      claimed.add(to);
      renames.set(from, to);
    }
    return renames;
  }
  // Moves the local file instead of deleting it and downloading a copy under
  // the new name. This runs on every pull, including automatic ones: a rename
  // preserves content, so unlike a deletion there is nothing here to withhold
  // until the user asks for it.
  async applyRemoteRenames(renames, remote, remoteDeleted, remoteChanged) {
    var _a;
    let renamed = 0;
    for (const [from, to] of renames) {
      const file = this.vault.getAbstractFileByPath(from);
      const sha = (_a = remote.entries.get(to)) == null ? void 0 : _a.sha;
      const movable = file instanceof import_obsidian6.TFile && !this.vault.getAbstractFileByPath(to) && matchesExtensions(to, this.settings.pullExtensions) && !isIgnoredPath(to, this.settings.ignoredPaths) && isSafeVaultPath(to);
      if (!movable || !(file instanceof import_obsidian6.TFile)) continue;
      const tracked = this.state.trackedFiles[from];
      this.markSelfWrite(from, to);
      await this.ensureParentFolder(to);
      await this.vault.rename(file, to);
      delete this.state.trackedFiles[from];
      if (tracked && sha) {
        const moved = this.vault.getAbstractFileByPath(to);
        this.state.trackedFiles[to] = {
          ...tracked,
          remoteSha: sha,
          ...moved instanceof import_obsidian6.TFile ? { mtime: moved.stat.mtime, size: moved.stat.size } : {}
        };
      }
      remoteDeleted.delete(from);
      remoteChanged.delete(to);
      renamed++;
    }
    return renamed;
  }
  async ensureParentFolder(path) {
    const parts = normalizePath(path).split("/");
    parts.pop();
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.vault.getAbstractFileByPath(current)) {
        await this.vault.createFolder(current);
      }
    }
  }
  // Prunes conflicts using the recorded tree rather than a freshly fetched one.
  //
  // Conflicts were only ever re-examined during a reconcile or a push, and both
  // of those look at the remote as it was *before* the operation. Once the two
  // devices had settled and the branch went quiet, nothing looked again: the
  // "no remote changes" path returns early, so a conflict both sides had long
  // since resolved stayed pinned to the status bar indefinitely.
  //
  // lastSyncedTree already describes the remote at the synced commit, so this
  // costs no request at all.
  async pruneConflictsAgainstSyncedTree() {
    var _a;
    const paths = Object.keys(this.state.conflicts);
    if (!paths.length) return;
    let changed = false;
    for (const path of paths) {
      const localFile = this.vault.getAbstractFileByPath(path);
      const remoteSha = (_a = this.state.lastSyncedTree[path]) != null ? _a : null;
      if (!(localFile instanceof import_obsidian6.TFile) && !remoteSha) {
        delete this.state.conflicts[path];
        changed = true;
        continue;
      }
      if (localFile instanceof import_obsidian6.TFile && remoteSha) {
        const bytes = await this.vault.readBinary(localFile);
        if (await gitBlobSha(bytes) === remoteSha) {
          delete this.state.conflicts[path];
          this.state.trackedFiles[path] = {
            localHash: await sha256(bytes),
            remoteSha
          };
          changed = true;
        }
      }
    }
    if (changed) {
      await this.stateStore.save(this.state);
      this.refreshUI();
    }
  }
  // Conflict records are sticky: recordConflicts refuses to overwrite an
  // existing entry, and nothing else removes them. Without pruning, a conflict
  // that has since resolved itself pins the status bar to "conflict" forever
  // and leaves phantom entries in the conflict modal, where Keep Remote on a
  // path that no longer exists remotely would delete the local file.
  async pruneResolvedConflicts(remote) {
    let changed = false;
    for (const path of Object.keys(this.state.conflicts)) {
      const localFile = this.vault.getAbstractFileByPath(path);
      const remoteEntry = remote.entries.get(path);
      const remoteSha = (remoteEntry == null ? void 0 : remoteEntry.type) === "blob" ? remoteEntry.sha : null;
      if (!(localFile instanceof import_obsidian6.TFile) && !remoteSha) {
        delete this.state.conflicts[path];
        changed = true;
        continue;
      }
      if (localFile instanceof import_obsidian6.TFile && remoteSha) {
        const bytes = await this.vault.readBinary(localFile);
        if (await gitBlobSha(bytes) === remoteSha) {
          delete this.state.conflicts[path];
          this.state.trackedFiles[path] = {
            localHash: await sha256(bytes),
            remoteSha
          };
          changed = true;
        }
      }
    }
    if (changed) {
      await this.stateStore.save(this.state);
      this.refreshUI();
    }
  }
  remoteTrackingExtensions() {
    return Array.from(
      /* @__PURE__ */ new Set([
        ...this.settings.pullExtensions,
        ...this.settings.pushExtensions
      ])
    );
  }
  async recordConflicts(conflicts, remote) {
    for (const conflict of conflicts) {
      if (this.state.conflicts[conflict.path]) continue;
      const copyPath = await this.createConflictCopy(conflict.path, remote);
      conflict.conflictCopyPath = copyPath;
      this.state.conflicts[conflict.path] = conflict;
    }
    if (conflicts.length) {
      await this.stateStore.save(this.state);
      for (const conflict of conflicts) {
        this.record("conflict", `Conflict in ${basename(conflict.path)}`);
      }
      new import_obsidian6.Notice(`${conflicts.length} synchronization conflict(s) detected.`);
    }
  }
  async createConflictCopy(path, remote) {
    const remoteEntry = remote.entries.get(path);
    if (!remoteEntry || remoteEntry.type !== "blob" || !remoteEntry.sha) {
      return null;
    }
    const github = this.getClient();
    const blob = await github.getBlob(remoteEntry.sha);
    const bytes = (await Promise.resolve().then(() => (init_VaultScanner(), VaultScanner_exports))).base64ToArrayBuffer(blob.content);
    const dot = path.lastIndexOf(".");
    const stem = dot >= 0 ? path.slice(0, dot) : path;
    const ext = dot >= 0 ? path.slice(dot) : "";
    const device = this.state.deviceId;
    const copyPath = `${stem} (conflict - ${device})${ext}`;
    if (this.vault.getAbstractFileByPath(copyPath)) {
      return copyPath;
    }
    const parts = copyPath.split("/");
    parts.pop();
    let folder = "";
    for (const part of parts) {
      folder = folder ? `${folder}/${part}` : part;
      if (!this.vault.getAbstractFileByPath(folder)) {
        await this.vault.createFolder(folder);
      }
    }
    this.markSelfWrite(copyPath);
    await this.vault.createBinary(copyPath, bytes);
    return copyPath;
  }
  async keepLocal(path) {
    const conflict = this.state.conflicts[path];
    if (!conflict) return;
    delete this.state.conflicts[path];
    await this.stateStore.save(this.state);
    this.markDirty();
    await this.pushNow();
  }
  async keepRemote(path) {
    const conflict = this.state.conflicts[path];
    if (!conflict) return;
    const github = this.getClient();
    const ref = await github.getBranchReference();
    const commit = await github.getCommit(ref.object.sha);
    const remote = await this.getRemoteSnapshot(github, ref.object.sha, commit.tree.sha);
    const pull = new PullManager(this.vault, github, this.settings);
    if (remote.entries.has(path)) {
      await pull.applyRemoteChanges(
        remote,
        this.state,
        /* @__PURE__ */ new Set([path]),
        /* @__PURE__ */ new Set()
      );
    } else {
      const localFile = this.vault.getAbstractFileByPath(path);
      if (localFile instanceof import_obsidian6.TFile) {
        const proceed = window.confirm(
          `"${path}" does not exist on GitHub.

Keeping the remote version means deleting your local copy. It will be moved to the vault's .trash folder.

Delete the local file?`
        );
        if (!proceed) {
          new import_obsidian6.Notice("GitSync: kept the local file. Conflict left unresolved.");
          return;
        }
      }
      await pull.applyRemoteChanges(
        remote,
        this.state,
        /* @__PURE__ */ new Set(),
        /* @__PURE__ */ new Set([path])
      );
    }
    delete this.state.conflicts[path];
    this.state.lastSyncedCommit = ref.object.sha;
    this.state.lastSyncedTree = treeMapOf(remote);
    this.state.lastRemoteCheck = (/* @__PURE__ */ new Date()).toISOString();
    await this.stateStore.save(this.state);
    this.setStatus(
      Object.keys(this.state.conflicts).length ? "conflict" : "synced",
      `Kept remote version of ${path}.`
    );
    this.refreshUI();
  }
  async clearConflict(path) {
    delete this.state.conflicts[path];
    await this.stateStore.save(this.state);
    this.setStatus(
      Object.keys(this.state.conflicts).length ? "conflict" : "synced",
      "Conflict cleared."
    );
    this.refreshUI();
  }
  getClient() {
    return new GitHubClient(
      this.settings.githubOwner.trim(),
      this.settings.githubRepo.trim(),
      this.settings.token,
      this.settings.branch.trim() || "main"
    );
  }
  // Re-arms for a specific moment rather than the usual delay, so a held-back
  // new file is reconsidered exactly when it becomes eligible.
  scheduleDeferredPush(at) {
    if (this.pushTimer) {
      clearTimeout(this.pushTimer);
    }
    const delay = Math.max(
      PUSH_DELAY_SECONDS * 1e3,
      at - Date.now() + 250,
      this.syncHoldUntil - Date.now() + 250
    );
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      void this.pushNow();
    }, delay);
  }
  scheduleDebouncedPush() {
    if (this.pushTimer) {
      clearTimeout(this.pushTimer);
    }
    const delay = Math.max(
      PUSH_DELAY_SECONDS * 1e3,
      this.syncHoldUntil - Date.now() + 250
    );
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      void this.pushNow();
    }, delay);
  }
  async checkRemote() {
    if (this.running) {
      return;
    }
    if (Date.now() < this.syncHoldUntil) {
      return;
    }
    if (!this.state.lastSyncedCommit) {
      return;
    }
    try {
      const github = this.getClient();
      const ref = await github.getBranchReference();
      this.state.lastRemoteCheck = (/* @__PURE__ */ new Date()).toISOString();
      if (ref.object.sha !== this.state.lastSyncedCommit) {
        await this.pullNow();
      } else if (this.dirty && !this.pushTimer) {
        await this.pushNow();
      }
    } catch (error) {
      this.handleError(error);
    }
  }
  async runRequestedIfNeeded() {
    if (!this.requested) return;
    this.requested = false;
    if (Date.now() < this.syncHoldUntil) {
      this.scheduleHeldSync();
      return;
    }
    await this.syncNow();
  }
  // An edit made while a push was in flight asks for another sync the instant
  // that push returns. Holding it until the push has settled is what keeps the
  // second attempt from reading a stale branch and calling the file a conflict.
  scheduleHeldSync() {
    if (this.pushTimer) {
      clearTimeout(this.pushTimer);
    }
    const delay = Math.max(0, this.syncHoldUntil - Date.now()) + 250;
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      void this.syncNow();
    }, delay);
  }
  handleError(error) {
    let message = "Synchronization failed.";
    if (error instanceof GitHubApiError) {
      if (error.status === 401) {
        message = `GitHub authentication failed. Check the token. \u2014 ${error.message}`;
      } else if (error.status === 403) {
        message = `GitHub denied the request or rate limiting is active. \u2014 ${error.message}`;
      } else if (error.status === 404) {
        message = `GitHub repository or branch was not found. \u2014 ${error.message}`;
      } else if (error.status === 409 || error.status === 422) {
        message = `GitHub rejected the request: ${error.message}`;
      } else if (error.status === 0) {
        message = error.message;
      } else {
        message = `GitHub request failed (HTTP ${error.status}): ${error.message}`;
      }
    } else if (error instanceof Error) {
      message = error.message;
    }
    console.error("[GitSync]", error);
    this.record("error", message);
    this.setStatus("error", message);
    new import_obsidian6.Notice(`GitSync: ${message}`);
    this.refreshUI();
  }
  destroy() {
    this.stopPolling();
    if (this.pushTimer) {
      clearTimeout(this.pushTimer);
      this.pushTimer = null;
    }
  }
};
function treeMapOf(remote) {
  const map = {};
  for (const [path, entry] of remote.entries) {
    if (entry.type === "blob" && entry.sha) {
      map[path] = entry.sha;
    }
  }
  return map;
}
function basename(path) {
  const cut = path.lastIndexOf("/");
  return cut >= 0 ? path.slice(cut + 1) : path;
}

// src/ui/SettingsTab.ts
var import_obsidian7 = require("obsidian");
init_types();
init_VaultScanner();
init_PathFilter();
var SettingsTab = class extends import_obsidian7.PluginSettingTab {
  constructor(app, host, plugin) {
    super(app, plugin);
    this.host = host;
  }
  display() {
    var _a;
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("p", {
      text: "Settings and synchronization state are local to this installation."
    });
    containerEl.createEl("h3", { text: "GitHub" });
    new import_obsidian7.Setting(containerEl).setName("GitHub owner").setDesc("GitHub account or organization that owns the repository.").addText(
      (text) => text.setPlaceholder("Your GitHub Username").setValue(this.host.settings.githubOwner).onChange(async (value) => {
        this.host.settings.githubOwner = value.trim();
        await this.host.saveSettings();
      })
    );
    new import_obsidian7.Setting(containerEl).setName("GitHub repository").setDesc("Repository name without .git.").addText(
      (text) => text.setPlaceholder("my-obsidian-vault").setValue(this.host.settings.githubRepo).onChange(async (value) => {
        this.host.settings.githubRepo = value.trim();
        await this.host.saveSettings();
      })
    );
    new import_obsidian7.Setting(containerEl).setName("Branch").setDesc("The single synchronization branch. Defaults to main.").addText(
      (text) => text.setValue(this.host.settings.branch).onChange(async (value) => {
        this.host.settings.branch = value.trim() || "main";
        await this.host.saveSettings();
      })
    );
    new import_obsidian7.Setting(containerEl).setName("Personal access token").setDesc("Fine-grained token limited to this repository with Contents read/write permission. The token is never logged.").addText((text) => {
      text.inputEl.type = "password";
      text.setPlaceholder("github_pat_...").setValue(this.host.settings.token).onChange(async (value) => {
        this.host.settings.token = value;
        await this.host.saveSettings();
      });
    });
    new import_obsidian7.Setting(containerEl).setName("Test connection").setDesc("Checks authentication, repository access and the configured branch.").addButton(
      (button) => button.setButtonText("Test connection").onClick(async () => {
        await this.host.testConnection();
      })
    );
    containerEl.createEl("h3", { text: "Synchronization" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: `Always on, identically on every device: nothing here is configurable per-install any more, so a phone and a desktop never drift into different sync behavior. A push goes out ${PUSH_DELAY_SECONDS} seconds after your last edit. GitHub is checked every five seconds while Obsidian is open and visible, and again as soon as it comes back to the foreground, with checking pausing while a push settles. After every push, ten seconds pass before anything automatic runs again, so an edit made mid-push is sent by a second push rather than racing the first.`
    });
    containerEl.createEl("h3", { text: "Pull extensions" });
    containerEl.createEl("p", {
      text: this.host.settings.pullExtensions.length ? "Selected extensions will be downloaded from GitHub." : "No extensions selected. Nothing will be downloaded until you choose at least one."
    });
    this.renderExtensionSelector(
      containerEl,
      this.host.settings.pullExtensions,
      async (value) => {
        this.host.settings.pullExtensions = value;
        await this.host.saveSettings();
      }
    );
    containerEl.createEl("h3", { text: "Push extensions" });
    containerEl.createEl("p", {
      text: this.host.settings.pushExtensions.length ? "Selected extensions may be pushed to GitHub." : "No extensions selected. Nothing will be pushed automatically."
    });
    this.renderExtensionSelector(
      containerEl,
      this.host.settings.pushExtensions,
      async (value) => {
        this.host.settings.pushExtensions = value;
        await this.host.saveSettings();
      }
    );
    containerEl.createEl("h3", { text: "Ignored paths" });
    new import_obsidian7.Setting(containerEl).setName("Ignored paths").setDesc("One path or path prefix per line. Example: .obsidian/workspace.json").addTextArea(
      (text) => text.setPlaceholder(".obsidian/workspace.json\n.obsidian/workspace-mobile.json").setValue(this.host.settings.ignoredPaths.join("\n")).onChange(async (value) => {
        this.host.settings.ignoredPaths = value.split(/\r?\n/).map(normalizePath).map((path) => path.trim()).filter(Boolean);
        await this.host.saveSettings();
      })
    );
    containerEl.createEl("h3", { text: "Actions" });
    new import_obsidian7.Setting(containerEl).setName("Push").setDesc(
      "Sends everything in this vault to GitHub now, without waiting for the timer: new files, edits, renames and deletions. A large batch of deletions is confirmed first. Pulling happens on its own."
    ).addButton(
      (button) => button.setCta().setButtonText("Push").onClick(() => {
        void this.host.pushNow();
      })
    );
    new import_obsidian7.Setting(containerEl).setName("Reset and re-pull from GitHub").setDesc(
      "Discards this vault's synced files and downloads them again from GitHub. Removed files go to the vault's .trash folder. Anything local that was never pushed will be lost. GitHub is not modified."
    ).addButton(
      (button) => button.setWarning().setButtonText("Reset and re-pull").onClick(async () => {
        await this.host.resetSyncState();
        this.display();
      })
    );
    containerEl.createEl("h3", { text: "Device" });
    new import_obsidian7.Setting(containerEl).setName("Device ID").setDesc("Generated locally and never derived from hardware identifiers.").addText(
      (text) => text.setValue(this.host.getDeviceId()).setDisabled(true)
    );
    const status = this.host.getStatus();
    new import_obsidian7.Setting(containerEl).setName("Current status").setDesc((_a = status.detail) != null ? _a : status.status);
  }
  renderExtensionSelector(containerEl, selected, onChange) {
    const normalizedSelected = selected.map(normalizeExtension);
    const controls = containerEl.createDiv();
    controls.style.marginBottom = "8px";
    const selectAll = controls.createEl("button", { text: "Select All" });
    selectAll.addEventListener("click", () => {
      void onChange([...SUPPORTED_EXTENSIONS]);
      this.display();
    });
    const clearAll = controls.createEl("button", { text: "Clear All" });
    clearAll.style.marginLeft = "8px";
    clearAll.addEventListener("click", () => {
      void onChange([]);
      this.display();
    });
    const grid = containerEl.createDiv("gitsync-extension-grid");
    for (const extension of SUPPORTED_EXTENSIONS) {
      const label = grid.createEl("label");
      const input = label.createEl("input", { type: "checkbox" });
      input.checked = normalizedSelected.includes(extension);
      label.createSpan({ text: extension });
      input.addEventListener("change", () => {
        const next = new Set(normalizedSelected);
        if (input.checked) {
          next.add(extension);
        } else {
          next.delete(extension);
        }
        void onChange([...next]);
      });
    }
  }
};

// src/ui/StatusBar.ts
var StatusBarController = class {
  constructor(plugin, workspace, onClick) {
    this.item = plugin.addStatusBarItem();
    this.item.addClass("gitsync-status");
    this.item.setAttribute("aria-label", "GitSync status");
    this.item.addEventListener("click", onClick);
    workspace.onLayoutReady(() => {
      this.set("synced", "Ready");
    });
  }
  set(status, detail) {
    const labels = {
      synced: "\u2713 Synced",
      pending: "\u2191 Pending",
      syncing: "\u21BB Syncing",
      pulling: "\u2193 Pulling",
      pushing: "\u2191 Pushing",
      conflict: "\u26A0 Conflict",
      error: "\u2715 Error"
    };
    this.item.setText(labels[status]);
    this.item.setAttribute("title", detail != null ? detail : labels[status]);
  }
};

// src/ui/ConflictModal.ts
var import_obsidian8 = require("obsidian");
var ConflictModal = class extends import_obsidian8.Modal {
  constructor(app, syncManager) {
    super(app);
    this.syncManager = syncManager;
  }
  onOpen() {
    this.render();
  }
  render() {
    var _a;
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Sync conflicts" });
    const conflicts = Object.values(this.syncManager.getState().conflicts);
    if (conflicts.length === 0) {
      contentEl.createEl("p", { text: "No unresolved conflicts." });
      return;
    }
    contentEl.createEl("p", {
      text: "The plugin has preserved the local version and created a remote conflict copy where possible. Nothing was silently overwritten."
    });
    for (const conflict of conflicts) {
      const container = contentEl.createDiv("gitsync-conflict");
      container.createDiv({
        cls: "gitsync-conflict-path",
        text: conflict.path
      });
      container.createEl("small", {
        text: conflict.remoteExists ? `Remote version: ${(_a = conflict.remoteSha) != null ? _a : "unknown"}` : "Remote version was deleted."
      });
      if (conflict.conflictCopyPath) {
        container.createEl("p", {
          text: `Remote copy: ${conflict.conflictCopyPath}`
        });
      }
      new import_obsidian8.Setting(container).addButton(
        (button) => button.setButtonText("Keep local").onClick(async () => {
          await this.syncManager.keepLocal(conflict.path);
          this.render();
        })
      ).addButton(
        (button) => button.setButtonText("Keep remote").onClick(async () => {
          await this.syncManager.keepRemote(conflict.path);
          this.render();
        })
      ).addButton(
        (button) => button.setButtonText("Clear").onClick(async () => {
          await this.syncManager.clearConflict(conflict.path);
          this.render();
        })
      );
    }
  }
};

// src/ui/FirstRunModal.ts
var import_obsidian9 = require("obsidian");
var FirstRunModal = class extends import_obsidian9.Modal {
  constructor(app, repoLabel, localFileCount, onChoice, onDismissed) {
    super(app);
    this.repoLabel = repoLabel;
    this.localFileCount = localFileCount;
    this.onChoice = onChoice;
    this.onDismissed = onDismissed;
    this.resolved = false;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Which side is the starting point?" });
    contentEl.createEl("p", {
      text: `This vault has not been synchronized with ${this.repoLabel} yet. Choose which side to start from. This is asked once \u2014 afterwards the two stay in step on their own.`
    });
    new import_obsidian9.Setting(contentEl).setName("Upload this vault").setDesc(
      `Sends this vault's ${this.localFileCount} matching file(s) to GitHub. Nothing on GitHub is deleted, and files that exist only there are downloaded afterwards. Choose this on the device that already has your notes.`
    ).addButton(
      (button) => button.setCta().setButtonText("Upload").onClick(() => this.choose("local"))
    );
    new import_obsidian9.Setting(contentEl).setName("Download from GitHub").setDesc(
      "Replaces this vault's copies with GitHub's. Local files that differ are moved to .trash first, and files that exist only here are left alone. Choose this on a new or empty device."
    ).addButton(
      (button) => button.setButtonText("Download").onClick(() => this.choose("remote"))
    );
    contentEl.createEl("p", {
      cls: "setting-item-description",
      text: "Closing this window leaves synchronization switched off until you choose."
    });
  }
  choose(choice) {
    if (this.resolved) return;
    this.resolved = true;
    this.close();
    this.onChoice(choice);
  }
  onClose() {
    this.contentEl.empty();
    if (!this.resolved) this.onDismissed();
  }
};

// src/ui/SyncPanelView.ts
var import_obsidian10 = require("obsidian");
var SYNC_PANEL_VIEW_TYPE = "gitsync-panel";
var STATUS_COPY = {
  synced: { label: "Up to date", hint: "Everything here matches GitHub." },
  pending: { label: "Waiting to push", hint: "Local edits are queued for the next push." },
  syncing: { label: "Synchronizing", hint: "Reconciling both sides." },
  pulling: { label: "Pulling", hint: "Bringing down changes from GitHub." },
  pushing: { label: "Pushing", hint: "Sending local changes to GitHub." },
  conflict: { label: "Needs attention", hint: "A file changed in both places." },
  error: { label: "Stopped", hint: "Synchronization hit a problem." }
};
var ACTIVITY_ICON = {
  push: "\u2191",
  pull: "\u2193",
  merge: "\u292D",
  conflict: "\u26A0",
  error: "\u2715",
  info: "\u2022"
};
var SyncPanelView = class extends import_obsidian10.ItemView {
  constructor(leaf, host) {
    super(leaf);
    this.host = host;
    this.ticker = null;
    // Elements whose text is purely "how long ago", paired with the instant they
    // describe. Elapsed time changes with no event to announce it, but rebuilding
    // the panel once a second to say so would throw away the activity list's
    // scroll position every second. So the timer touches only these, and a full
    // rebuild happens when something actually changes.
    this.timeNodes = [];
  }
  getViewType() {
    return SYNC_PANEL_VIEW_TYPE;
  }
  getDisplayText() {
    return "GitSync";
  }
  getIcon() {
    return "refresh-cw";
  }
  async onOpen() {
    this.render();
    this.ticker = window.setInterval(() => this.tickTimes(), 1e3);
    this.registerInterval(this.ticker);
  }
  tickTimes() {
    for (const node of this.timeNodes) {
      node.el.setText(node.at === null ? "never" : shortAgo(node.at));
    }
  }
  async onClose() {
    if (this.ticker !== null) {
      window.clearInterval(this.ticker);
      this.ticker = null;
    }
  }
  render() {
    const root = this.contentEl;
    root.empty();
    root.addClass("gitsync-panel");
    this.timeNodes = [];
    const { status, detail } = this.host.getStatus();
    const state = this.host.getState();
    const copy = STATUS_COPY[status];
    const card = root.createDiv({ cls: `ghs-card ghs-status ghs-${status}` });
    const heading = card.createDiv({ cls: "ghs-status-heading" });
    heading.createSpan({ cls: "ghs-dot" });
    heading.createSpan({ cls: "ghs-status-label", text: copy.label });
    card.createDiv({ cls: "ghs-status-detail", text: detail || copy.hint });
    const conflictCount = Object.keys(state.conflicts).length;
    const trackedCount = Object.keys(state.trackedFiles).length;
    const facts = root.createDiv({ cls: "ghs-card ghs-facts" });
    this.timeFact(facts, "Last pull", state.lastSuccessfulPull);
    this.timeFact(facts, "Last push", state.lastSuccessfulPush);
    this.fact(facts, "Files tracked", String(trackedCount));
    if (!state.lastSyncedCommit) {
      const warn = root.createDiv({ cls: "ghs-card ghs-warn" });
      warn.createDiv({
        cls: "ghs-warn-text",
        text: "Not linked to GitHub yet. Turn on automatic synchronization to choose a starting point."
      });
    }
    if (conflictCount) {
      const warn = root.createDiv({ cls: "ghs-card ghs-warn" });
      warn.createDiv({
        cls: "ghs-warn-text",
        text: `${conflictCount} file(s) changed in both places and need a decision.`
      });
      const resolve = warn.createEl("button", {
        cls: "mod-cta ghs-button",
        text: "Review conflicts"
      });
      resolve.addEventListener("click", () => this.host.openConflicts());
    }
    const actions = root.createDiv({ cls: "ghs-actions" });
    const settings = actions.createEl("button", { cls: "ghs-button", text: "Open settings" });
    settings.addEventListener("click", () => this.host.openSettings());
    root.createEl("h4", { cls: "ghs-heading", text: "Recent activity" });
    const activity = this.host.getActivity();
    if (!activity.length) {
      root.createDiv({ cls: "ghs-empty", text: "Nothing yet." });
      return;
    }
    const list = root.createDiv({ cls: "ghs-activity" });
    for (const entry of activity) {
      const row = list.createDiv({ cls: `ghs-entry ghs-entry-${entry.kind}` });
      row.createSpan({ cls: "ghs-entry-icon", text: ACTIVITY_ICON[entry.kind] });
      row.createSpan({ cls: "ghs-entry-text", text: entry.text });
      this.timeNodes.push({
        el: row.createSpan({ cls: "ghs-entry-time", text: shortAgo(entry.at) }),
        at: entry.at
      });
    }
  }
  fact(parent, label, value) {
    const row = parent.createDiv({ cls: "ghs-fact" });
    row.createSpan({ cls: "ghs-fact-label", text: label });
    row.createSpan({ cls: "ghs-fact-value", text: value });
  }
  timeFact(parent, label, iso) {
    const row = parent.createDiv({ cls: "ghs-fact" });
    row.createSpan({ cls: "ghs-fact-label", text: label });
    const parsed = iso ? Date.parse(iso) : Number.NaN;
    const at = Number.isNaN(parsed) ? null : parsed;
    this.timeNodes.push({
      el: row.createSpan({
        cls: "ghs-fact-value",
        text: at === null ? "never" : shortAgo(at)
      }),
      at
    });
  }
};
function shortAgo(at) {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1e3));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

// src/main.ts
init_PathFilter();
var GitSyncPlugin = class extends import_obsidian11.Plugin {
  constructor() {
    super(...arguments);
    this.settings = { ...DEFAULT_SETTINGS };
    this.currentStatus = "synced";
    this.currentStatusDetail = "Ready";
    // Set while the question is on screen or its answer is still being carried
    // out. Both states must suppress a second prompt: the first would open two
    // modals, the second would start two adoptions over the same files.
    this.startingPointPending = false;
  }
  async onload() {
    await this.loadSettingsAndState();
    this.statusBar = new StatusBarController(
      this,
      this.app.workspace,
      () => this.openStatus()
    );
    this.syncManager = new SyncManager(
      this,
      this.app.vault,
      this.settings,
      this.stateStore,
      this.state,
      (status, detail) => this.setStatus(status, detail),
      () => this.updateStateReference()
    );
    this.addSettingTab(
      new SettingsTab(this.app, {
        settings: this.settings,
        saveSettings: () => this.saveSettings(),
        testConnection: () => this.testConnection(),
        pushNow: () => this.syncManager.pushEverything(),
        resetSyncState: () => this.resetSyncState(),
        getDeviceId: () => this.state.deviceId,
        getStatus: () => ({
          status: this.currentStatus,
          detail: this.currentStatusDetail
        })
      }, this)
    );
    this.registerView(
      SYNC_PANEL_VIEW_TYPE,
      (leaf) => new SyncPanelView(leaf, {
        getStatus: () => ({
          status: this.currentStatus,
          detail: this.currentStatusDetail
        }),
        getState: () => this.state,
        getActivity: () => this.syncManager.getActivity(),
        openConflicts: () => new ConflictModal(this.app, this.syncManager).open(),
        openSettings: () => this.openSettings()
      })
    );
    this.addRibbonIcon("refresh-cw", "GitSync status", () => {
      void this.revealPanel();
    });
    this.registerCommands();
    this.registerVaultEvents();
    this.registerActivationEvents();
    this.syncManager.startPolling();
    this.app.workspace.onLayoutReady(() => {
      window.setTimeout(() => {
        if (this.promptForStartingPointIfNeeded()) return;
        void this.syncManager.onActivation();
      }, 1500);
    });
    this.setStatus("synced", "Ready.");
  }
  onunload() {
    var _a;
    (_a = this.syncManager) == null ? void 0 : _a.destroy();
  }
  // Opens the panel in the right sidebar, or reveals it if it is already there.
  async revealPanel() {
    var _a;
    const existing = this.app.workspace.getLeavesOfType(SYNC_PANEL_VIEW_TYPE);
    if (existing.length) {
      await this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = (_a = this.app.workspace.getRightLeaf(false)) != null ? _a : this.app.workspace.getLeaf(true);
    if (!leaf) {
      new import_obsidian11.Notice("GitSync: could not open the status panel.");
      return;
    }
    await leaf.setViewState({ type: SYNC_PANEL_VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }
  // Every status change and every state refresh redraws the panel. It is the
  // only view that has to keep up with a background process.
  refreshPanel() {
    for (const leaf of this.app.workspace.getLeavesOfType(SYNC_PANEL_VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof SyncPanelView) view.render();
    }
  }
  // Asked once per vault, and only when there is something to ask about: the
  // repository has to be configured and no starting commit recorded yet.
  // Returns true when the question was put, so callers can hold off on doing
  // anything else.
  promptForStartingPointIfNeeded() {
    if (this.startingPointPending) return true;
    if (!this.syncManager.needsStartingPoint()) return false;
    const configured = this.settings.githubOwner && this.settings.githubRepo && this.settings.token;
    if (!configured) return false;
    this.startingPointPending = true;
    this.setStatus("pending", "Waiting for a starting point.");
    new FirstRunModal(
      this.app,
      `${this.settings.githubOwner}/${this.settings.githubRepo}`,
      this.managedFiles().length,
      (choice) => {
        void (choice === "local" ? this.syncManager.adoptLocal() : this.syncManager.adoptRemote()).finally(() => {
          this.startingPointPending = false;
        });
      },
      () => {
        this.startingPointPending = false;
        this.setStatus("pending", "No starting point chosen yet.");
      }
    ).open();
    return true;
  }
  registerCommands() {
    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      callback: () => {
        void this.syncManager.syncNow();
      }
    });
    this.addCommand({
      id: "open-panel",
      name: "Open status panel",
      callback: () => {
        void this.revealPanel();
      }
    });
    this.addCommand({
      id: "show-status",
      name: "Show status",
      callback: () => this.openStatus()
    });
    this.addCommand({
      id: "show-conflicts",
      name: "Show conflicts",
      callback: () => new ConflictModal(this.app, this.syncManager).open()
    });
    this.addCommand({
      id: "open-settings",
      name: "Open settings",
      callback: () => this.openSettings()
    });
  }
  // Opens Obsidian's settings modal straight to this plugin's own tab, rather
  // than whatever tab was last open. Obsidian doesn't type this part of its
  // API, so it's reached through an unknown cast.
  openSettings() {
    var _a, _b;
    const app = this.app;
    (_a = app.setting) == null ? void 0 : _a.open();
    (_b = app.setting) == null ? void 0 : _b.openTabById(this.manifest.id);
  }
  registerVaultEvents() {
    this.registerEvent(
      this.app.vault.on("create", (file) => this.handleVaultChange(file))
    );
    this.registerEvent(
      this.app.vault.on("modify", (file) => this.handleVaultChange(file))
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => this.handleVaultChange(file))
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (oldPath && !this.syncManager.isSelfWrite(oldPath) && !isIgnoredPath(file.path, this.settings.ignoredPaths)) {
          this.syncManager.markUserNamed(file.path);
          this.syncManager.recordRename(oldPath, file.path);
        }
        this.handleVaultChange(file);
        if (oldPath) {
          this.handleVaultPath(oldPath);
        }
      })
    );
  }
  registerActivationEvents() {
    this.registerDomEvent(document, "visibilitychange", () => {
      if (document.visibilityState === "visible") {
        void this.syncManager.onActivation();
      }
    });
    this.registerDomEvent(window, "focus", () => {
      void this.syncManager.onActivation();
    });
  }
  handleVaultChange(file) {
    this.handleVaultPath(file.path);
  }
  handleVaultPath(path) {
    if (this.syncManager.isSelfWrite(path)) return;
    if (isIgnoredPath(path, this.settings.ignoredPaths)) return;
    const normalized = normalizePath(path);
    const pushExtensions = this.settings.pushExtensions.map((extension) => extension.toLowerCase());
    const relevant = pushExtensions.some((extension) => {
      const normalizedExtension = extension.startsWith(".") ? extension : `.${extension}`;
      return normalized.toLowerCase().endsWith(normalizedExtension);
    });
    if (relevant) {
      this.syncManager.markDirty();
    }
  }
  async loadSettingsAndState() {
    var _a, _b, _c, _d, _e;
    const savedSettings = await this.loadData();
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...(_a = savedSettings == null ? void 0 : savedSettings.settings) != null ? _a : {}
    };
    this.stateStore = new SyncStateStore(this, () => this.settings, () => this.state);
    const rawState = savedSettings == null ? void 0 : savedSettings.state;
    if (rawState) {
      this.state = {
        ...DEFAULT_STATE,
        ...rawState,
        trackedFiles: (_b = rawState.trackedFiles) != null ? _b : {},
        conflicts: (_c = rawState.conflicts) != null ? _c : {},
        lastSyncedTree: (_d = rawState.lastSyncedTree) != null ? _d : {},
        pendingRenames: (_e = rawState.pendingRenames) != null ? _e : {}
      };
    } else {
      this.state = await this.stateStore.load();
    }
    if (!this.state.deviceId) {
      this.state = await this.stateStore.load();
    }
    if (!(savedSettings == null ? void 0 : savedSettings.state)) {
      await this.persistEverything();
    }
  }
  async saveSettings() {
    await this.persistEverything();
    if (this.syncManager) {
      this.syncManager.destroy();
      this.syncManager.startPolling();
      this.promptForStartingPointIfNeeded();
    }
  }
  async persistEverything() {
    await this.saveData({
      settings: this.settings,
      state: this.state
    });
  }
  // Throws away this vault's copy of the synced files and downloads them again.
  // This is the only action in the plugin that destroys local work on purpose,
  // so it is confirmed explicitly and everything it removes goes to .trash.
  async resetSyncState() {
    var _a;
    const managed = this.managedFiles();
    const confirmed = window.confirm(
      `Reset and re-pull from GitHub?

${managed.length} file(s) in this vault will be moved to .trash and downloaded again from GitHub.

Any local change that has not been pushed yet will be lost. GitHub itself is not modified.

Continue?`
    );
    if (!confirmed) {
      new import_obsidian11.Notice("GitSync: reset cancelled. Nothing was changed.");
      return;
    }
    (_a = this.syncManager) == null ? void 0 : _a.destroy();
    this.setStatus("syncing", "Resetting local files...");
    try {
      for (const file of managed) {
        await this.app.vault.trash(file, false);
      }
    } catch (error) {
      console.error("[GitSync]", error);
      new import_obsidian11.Notice("GitSync: could not clear local files. Nothing was re-pulled.");
      this.setStatus("error", "Reset failed while clearing local files.");
      this.restartSyncManager();
      return;
    }
    this.state = {
      ...DEFAULT_STATE,
      deviceId: this.state.deviceId || await this.createDeviceId()
    };
    await this.persistEverything();
    this.restartSyncManager();
    await this.syncManager.initialPull();
  }
  // Every vault file the plugin is responsible for, in either direction.
  managedFiles() {
    const extensions = Array.from(
      /* @__PURE__ */ new Set([...this.settings.pullExtensions, ...this.settings.pushExtensions])
    );
    return this.app.vault.getFiles().filter((file) => {
      const path = normalizePath(file.path);
      return matchesExtensions(path, extensions) && !isIgnoredPath(path, this.settings.ignoredPaths);
    });
  }
  restartSyncManager() {
    this.syncManager = new SyncManager(
      this,
      this.app.vault,
      this.settings,
      this.stateStore,
      this.state,
      (status, detail) => this.setStatus(status, detail),
      () => this.updateStateReference()
    );
    this.syncManager.startPolling();
  }
  async createDeviceId() {
    const bytes = new Uint8Array(4);
    crypto.getRandomValues(bytes);
    const prefix = /iphone|ipad|ios/i.test(navigator.userAgent) ? "iphone" : "mac";
    return `${prefix}-${Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }
  async testConnection() {
    try {
      const { GitHubClient: GitHubClient3 } = await Promise.resolve().then(() => (init_GitHubClient(), GitHubClient_exports));
      const client = new GitHubClient3(
        this.settings.githubOwner.trim(),
        this.settings.githubRepo.trim(),
        this.settings.token,
        this.settings.branch.trim() || "main"
      );
      const ref = await client.testConnection();
      new import_obsidian11.Notice(
        `GitSync: connected. ${ref.ref} \u2192 ${ref.object.sha.slice(0, 12)}`
      );
      this.setStatus("synced", "GitHub connection successful.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Connection test failed.";
      console.error("[GitSync]", error);
      new import_obsidian11.Notice(`GitSync: ${message}`);
      this.setStatus("error", message);
    }
  }
  updateStateReference() {
    this.state = this.syncManager.getState();
    this.refreshPanel();
  }
  setStatus(status, detail) {
    var _a;
    this.currentStatus = status;
    this.currentStatusDetail = detail != null ? detail : status;
    (_a = this.statusBar) == null ? void 0 : _a.set(status, detail);
    this.refreshPanel();
  }
  openStatus() {
    const conflicts = Object.keys(this.state.conflicts).length;
    new import_obsidian11.Notice(
      `GitSync: ${this.currentStatusDetail}${conflicts ? ` Conflicts: ${conflicts}.` : ""}`
    );
  }
};

"use strict";

const assert = require("node:assert/strict");
const { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join } = require("node:path");
const { test } = require("node:test");
const { collectContext, implementationRevision, assertImplementationRevision } = require("../context/index.cjs");

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const OLD_HEAD = "c".repeat(40);
const REVIEWER = "review-agent[bot]";

function comment(id, body, author = "developer") {
  return {
    id: `C_${id}`, databaseId: id, body, url: `https://github.com/org/repo/pull/42#comment-${id}`,
    author: { login: author, __typename: "User" }, updatedAt: "2026-09-18T00:00:00Z",
  };
}

function thread(id, { replies = [], ...overrides } = {}) {
  const root = comment(id, "The empty input throws.", REVIEWER);
  return {
    id: `T_${id}`, path: "src/example.py", line: 10, isResolved: false, isOutdated: false,
    root: { nodes: [root] },
    replies: { totalCount: replies.length + 1, nodes: [root, ...replies].slice(-5) },
    ...overrides,
  };
}

function sticky(snapshot, changes = {}, author = REVIEWER) {
  return comment(9999, "<!-- ai-review-summary:v1 -->\nSummary\n" +
    "<!-- ai-review-state:" + JSON.stringify({
      head_sha: HEAD, base_sha: BASE, context_digest: snapshot.context_digest,
      policy_digest: snapshot.policy_digest,
      review_complete: true, is_draft: false, ...changes,
    }) + " -->", author);
}

function connection(nodes, { more = false, cursor = null, total = nodes.length } = {}) {
  return { nodes, totalCount: total, pageInfo: { hasPreviousPage: more, startCursor: cursor } };
}

function harness({ threads = [], comments = [], latest = {}, pages, recheck = {}, policy = {} } = {}) {
  const calls = [];
  const notices = [];
  const pr = {
    number: 42, state: "open", draft: false, title: "Handle empty input", body: "Return None.",
    head: { sha: HEAD, repo: { full_name: "org/repo" } },
    base: { sha: BASE, repo: { full_name: "org/repo" } },
  };
  const options = {
    repository: "org/repo", pullRequestNumber: 42, reviewerLogin: REVIEWER,
    reviewProfile: 'model=example-v1;language=English;limits=v1;rules=v1',
    actionRevision: "d".repeat(40), ...policy,
    context: { repo: { owner: "org", repo: "repo" }, payload: { pull_request: pr } },
    core: { info() {}, notice(message) { notices.push(message); } },
    github: {
      rest: { pulls: { get: async () => {
        calls.push("get");
        return { data: { ...pr, ...latest,
          ...(calls.filter(call => call === "get").length > 1 ? recheck : {}),
        } };
      } } },
      graphql: async (query, variables) => {
        calls.push({ query, variables });
        const index = calls.filter(call => typeof call === "object").length - 1;
        return { repository: { pullRequest: {
          number: 42, state: "OPEN", headRefOid: HEAD, baseRefOid: BASE, isDraft: false,
          ...(pages ? pages[index] : {
            reviewThreads: connection(threads), comments: connection(comments),
          }),
        } } };
      },
    },
  };
  return { options, calls, notices, run: () => collectContext(options) };
}

test("a human reply invalidates an otherwise identical completed review", async () => {
  const existing = thread(10);
  const first = await harness({ threads: [existing] }).run();
  const initial = JSON.parse(first.contextJson);
  const status = sticky(initial);
  const unchanged = await harness({ threads: [existing], comments: [status] }).run();
  assert.equal(unchanged.skipReview, true);

  const updated = await harness({
    threads: [thread(10, { replies: [comment(11, "This input is valid; please reconsider.")] })],
    comments: [status],
  }).run();
  const value = JSON.parse(updated.contextJson);
  assert.equal(updated.skipReview, false);
  assert.notEqual(value.context_digest, initial.context_digest);
  assert.equal(value.threads[0].comments.at(-1).body, "This input is valid; please reconsider.");
  assert.equal(updated.reviewBaseSha, BASE);
});

test("GraphQL Bot accounts match the configured REST bot login without trusting similar users", async () => {
  const root = comment(10, "The empty input throws.");
  root.author = { login: "review-agent", __typename: "Bot" };
  const ownThread = { ...thread(10), root: { nodes: [root] }, replies: { totalCount: 1, nodes: [root] } };
  const first = JSON.parse((await harness({ threads: [ownThread] }).run()).contextJson);
  assert.equal(first.threads[0].author, REVIEWER);
  assert.equal(first.threads[0].is_own, true);

  const status = sticky(first);
  status.author = { login: "review-agent", __typename: "Bot" };
  assert.equal((await harness({ threads: [ownThread], comments: [status] }).run()).skipReview, true);
  status.author = { login: "review-agent", __typename: "User" };
  assert.equal((await harness({ threads: [ownThread], comments: [status] }).run()).skipReview, false);
});

test("only completed snapshots on the same base are reused, and full review bypasses them", async () => {
  const snapshot = JSON.parse((await harness().run()).contextJson);
  for (const state of [
    { review_complete: false }, { base_sha: "d".repeat(40) },
    { context_digest: "e".repeat(64) }, { is_draft: true },
  ]) {
    const result = await harness({ comments: [sticky(snapshot, state)] }).run();
    assert.equal(result.skipReview, false);
    assert.equal(result.reviewBaseSha, BASE);
  }
  const incremental = await harness({ comments: [sticky(snapshot, { head_sha: OLD_HEAD })] }).run();
  assert.equal(incremental.reviewBaseSha, OLD_HEAD);
  assert.equal(JSON.parse(incremental.contextJson).previous_head_sha, OLD_HEAD);
  assert.equal(incremental.skipReview, false);

  for (const head_sha of [HEAD, OLD_HEAD]) {
    const h = harness({ comments: [sticky(snapshot, { head_sha })] });
    h.options.fullReview = true;
    const result = await h.run();
    assert.equal(result.skipReview, false);
    assert.equal(result.reviewBaseSha, BASE);
  }
});

test("an outdated thread remains unresolved until its actual thread state says otherwise", async () => {
  const changed = thread(10, {
    isOutdated: true, line: null,
    replies: [comment(11, "Fixed in the latest commit.")],
  });
  const result = JSON.parse((await harness({ threads: [changed] }).run()).contextJson);
  assert.equal(result.threads[0].is_outdated, true);
  assert.equal(result.threads[0].is_resolved, false);
  assert.equal(result.threads[0].line, null);
  assert.equal(result.threads[0].comment_id, 10);
  assert.equal(result.threads[0].id, "T_10");
  assert.equal(result.threads[0].comments[1].body, "Fixed in the latest commit.");
});

test("thread status changes invalidate the snapshot, but generated text does not", async () => {
  const initial = JSON.parse((await harness({ threads: [thread(10)] }).run()).contextJson);
  const status = sticky(initial);
  const changedText = thread(10, { replies: [comment(11, "Updated explanation.", REVIEWER)] });
  changedText.root.nodes[0].body = "Reworded finding.";
  assert.equal((await harness({ threads: [changedText], comments: [status] }).run()).skipReview, true);
  for (const changes of [{ isResolved: true }, { isOutdated: true }]) {
    assert.equal((await harness({ threads: [thread(10, changes)], comments: [status] }).run()).skipReview, false);
  }
  assert.equal((await harness({ threads: [thread(10), thread(20)], comments: [status] }).run()).skipReview, false);
});

test("revision changes during context collection abort instead of emitting a mixed snapshot", async () => {
  for (const recheck of [
    { state: "closed" }, { draft: true }, { title: "Updated purpose" },
    { head: { sha: OLD_HEAD, repo: { full_name: "org/repo" } } },
    { base: { sha: OLD_HEAD, repo: { full_name: "org/repo" } } },
  ]) {
    await assert.rejects(harness({ recheck }).run(), /changed|open/i);
  }
  await assert.rejects(harness({ pages: [{
    headRefOid: OLD_HEAD, reviewThreads: connection([]), comments: connection([]),
  }] }).run(), /changed/i);
});

test("64-bit GraphQL comment IDs become exact numeric REST IDs", async () => {
  const id = "4294967296";
  const result = JSON.parse((await harness({ threads: [thread(id)] }).run()).contextJson);
  assert.equal(result.threads[0].comment_id, Number(id));
  assert.equal(result.threads[0].comments[0].id, Number(id));
  await assert.rejects(harness({ threads: [thread("9007199254740993")] }).run(), /comment ID/i);
});

test("PR descriptions and general human discussion affect the digest without including the sticky summary", async () => {
  const first = JSON.parse((await harness().run()).contextJson);
  const ownSummary = sticky(first);
  const discussion = comment(30, "Keep the existing API compatible.");
  const result = JSON.parse((await harness({ comments: [discussion, ownSummary] }).run()).contextJson);
  assert.deepEqual(result.comments.map(item => item.id), [30]);
  assert.notEqual(result.context_digest, first.context_digest);
  const changed = JSON.parse((await harness({ latest: { body: "New expected behavior." } }).run()).contextJson);
  assert.notEqual(changed.context_digest, first.context_digest);
});

test("only the newest trusted, unambiguous summary state can skip a review", async () => {
  const initial = JSON.parse((await harness().run()).contextJson);
  const valid = sticky(initial);
  const malformed = { ...valid, databaseId: 10000, body: "<!-- ai-review-summary:v1 -->\nInvalid state" };
  assert.equal((await harness({ comments: [valid, malformed] }).run()).skipReview, false);
  const duplicate = { ...valid, body: valid.body + "\n" + valid.body };
  assert.equal((await harness({ comments: [duplicate] }).run()).skipReview, false);
  const injected = { ...valid, author: { login: "developer", __typename: "User" } };
  assert.equal((await harness({ comments: [injected] }).run()).skipReview, false);
});

test("omitted replies or pagination gaps are marked incomplete", async () => {
  const existing = thread(10);
  const omittedReplies = { ...existing, replies: { ...existing.replies, totalCount: 10 } };
  assert.equal(JSON.parse((await harness({ threads: [omittedReplies] }).run()).contextJson).truncated, true);
  const result = await harness({ pages: [{
    reviewThreads: connection([existing], { total: 2 }), comments: connection([], { total: 1 }),
  }] }).run();
  assert.equal(JSON.parse(result.contextJson).truncated, true);
  assert.equal(result.skipReview, false);
});

test("thread pagination preserves roots and stops fetching an exhausted comments connection", async () => {
  const h = harness({ pages: [{
    reviewThreads: connection([thread(20)], { more: true, cursor: "older-threads", total: 2 }),
    comments: connection([comment(30, "General design context.")]),
  }, {
    reviewThreads: connection([thread(10)], { total: 2 }),
  }] });
  const value = JSON.parse((await h.run()).contextJson);
  assert.deepEqual(value.threads.map(item => item.comment_id), [20, 10]);
  assert.equal(value.comments[0].body, "General design context.");
  assert.equal(value.truncated, false);
  const calls = h.calls.filter(call => typeof call === "object");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].variables.threadsBefore, "older-threads");
  assert.equal(calls[1].variables.fetchComments, false);
  assert.equal(h.calls.filter(call => call === "get").length, 2);
});

test("model, review profile, and action revision changes invalidate skip and incremental reuse", async () => {
  const initial = JSON.parse((await harness().run()).contextJson);
  assert.match(initial.policy_digest, /^[a-f0-9]{64}$/);
  for (const policy of [
    { reviewProfile: 'model=example-v2;language=English;limits=v1;rules=v1' },
    { reviewProfile: 'model=example-v1;language=Japanese;limits=v2;rules=v2' },
    { actionRevision: "e".repeat(40) },
  ]) {
    for (const head_sha of [HEAD, OLD_HEAD]) {
      const result = await harness({ comments: [sticky(initial, { head_sha })], policy }).run();
      const snapshot = JSON.parse(result.contextJson);
      assert.equal(result.skipReview, false);
      assert.equal(result.reviewBaseSha, BASE);
      assert.equal(snapshot.previous_head_sha, null);
      assert.notEqual(snapshot.policy_digest, initial.policy_digest);
      assert.equal(snapshot.context_digest, initial.context_digest);
    }
  }
});

test("legacy states without a policy fingerprint always require a full review", async () => {
  const initial = JSON.parse((await harness().run()).contextJson);
  for (const policy_digest of [undefined, null, "not-a-digest"]) {
    for (const head_sha of [HEAD, OLD_HEAD]) {
      const result = await harness({ comments: [sticky(initial, { policy_digest, head_sha })] }).run();
      assert.equal(result.skipReview, false);
      assert.equal(result.reviewBaseSha, BASE);
      assert.equal(JSON.parse(result.contextJson).previous_head_sha, null);
    }
  }
});

test("local calls have a stable versioned policy when actionRevision is omitted", async () => {
  const initial = JSON.parse((await harness({ policy: { actionRevision: undefined } }).run()).contextJson);
  const result = await harness({
    policy: { actionRevision: undefined }, comments: [sticky(initial)],
  }).run();
  assert.match(initial.policy_digest, /^[a-f0-9]{64}$/);
  assert.equal(JSON.parse(result.contextJson).policy_digest, initial.policy_digest);
  assert.equal(result.skipReview, true);
});

test("source identity remains the downloaded implementation even with a custom policy revision", async () => {
  const snapshot = JSON.parse((await harness({ policy: { actionRevision: "custom-test-revision" } }).run()).contextJson);
  assert.equal(snapshot.source_digest, implementationRevision());
  assert.match(snapshot.source_digest, /^[a-f0-9]{64}$/);
});

function implementationFixture(t, reverse = false) {
  const root = mkdtempSync(join(tmpdir(), "ai-review-implementation-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const names = [
    "action.yml", "context/action.yml", "context/index.cjs", "publish/action.yml", "publish/index.cjs",
    "pyproject.toml", "uv.lock", "src/review.py", "src/model_io.py", "src/external_context.py",
    "sandbox/Dockerfile", "sandbox/network-policy.sh",
  ];
  for (const name of reverse ? [...names].reverse() : names) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), `example content for ${name}\n`);
  }
  return { root, names };
}

test("downloaded implementation content invalidates cached reviews even under the same moving ref", async t => {
  const { root, names } = implementationFixture(t);
  const originalRevision = implementationRevision(root);
  const initial = JSON.parse((await harness({ policy: { actionRevision: originalRevision } }).run()).contextJson);
  assert.match(originalRevision, /^[a-f0-9]{64}$/);
  for (const name of names) {
    const file = join(root, name);
    const original = readFileSync(file);
    writeFileSync(file, Buffer.concat([original, Buffer.from("changed implementation\n")]));
    const revision = implementationRevision(root);
    assert.notEqual(revision, originalRevision, name);
    for (const head_sha of [HEAD, OLD_HEAD]) {
      const result = await harness({
        policy: { actionRevision: revision }, comments: [sticky(initial, { head_sha })],
      }).run();
      assert.equal(result.skipReview, false, name);
      assert.equal(result.reviewBaseSha, BASE, name);
      assert.equal(JSON.parse(result.contextJson).previous_head_sha, null, name);
    }
    writeFileSync(file, original);
  }
});

test("implementation identity is deterministic and ignores generated and unrelated files", t => {
  const first = implementationFixture(t);
  const second = implementationFixture(t, true);
  const revision = implementationRevision(first.root);
  assert.equal(implementationRevision(second.root), revision);
  for (const name of ["README.md", "tests/test_example.py", ".env", ".venv/runtime.py",
    "src/__pycache__/review.pyc", "src/.env", "src/.cache/generated.py"]) {
    mkdirSync(dirname(join(first.root, name)), { recursive: true });
    writeFileSync(join(first.root, name), "not action implementation");
  }
  assert.equal(implementationRevision(first.root), revision);
  writeFileSync(join(first.root, "src/extra.py"), "new runtime module");
  assert.notEqual(implementationRevision(first.root), revision);
});

test("missing required files and source symlinks fail instead of hashing a partial implementation", t => {
  const { root } = implementationFixture(t);
  unlinkSync(join(root, "src/review.py"));
  assert.throws(() => implementationRevision(root), { code: "ENOENT" });
  const outside = join(root, ".env");
  writeFileSync(outside, "never follow this symlink");
  symlinkSync(outside, join(root, "src/review.py"));
  assert.throws(() => implementationRevision(root), /must be a regular file/i);
});

test("cross-job source checks accept matching or legacy context and reject changed implementations", t => {
  const { root } = implementationFixture(t);
  const snapshot = { source_digest: implementationRevision(root) };
  assert.doesNotThrow(() => assertImplementationRevision(snapshot, root));
  assert.doesNotThrow(() => assertImplementationRevision(JSON.stringify(snapshot), root));
  assert.doesNotThrow(() => assertImplementationRevision("{}", root));
  for (const source_digest of [null, "", "main", "A".repeat(64)]) {
    assert.throws(() => assertImplementationRevision({ source_digest }, root), /invalid source_digest/i);
  }
  writeFileSync(join(root, "src/review.py"), "new action downloaded by the next job");
  assert.throws(() => assertImplementationRevision(snapshot, root), /implementation changed/i);
});

test("missing policy profiles and explicit empty action revisions fail before API calls", async () => {
  for (const policy of [
    { reviewProfile: undefined }, { reviewProfile: "" }, { reviewProfile: "   " },
    { reviewProfile: {} }, { reviewProfile: "x".repeat(4097) }, { reviewProfile: "bad\u0000value" },
    { actionRevision: "" }, { actionRevision: "   " }, { actionRevision: null },
  ]) {
    const h = harness({ policy });
    await assert.rejects(h.run(), /profile|revision/i);
    assert.deepEqual(h.calls, []);
  }
});

test("huge histories have bounded pagination and UTF-8 output with explicit truncation", async () => {
  const body = "🙂".repeat(4000);
  const pages = Array.from({ length: 3 }, (_, page) => ({
    reviewThreads: connection(Array.from({ length: 50 }, (_, index) =>
      thread((3 - page) * 100 + index, {
        replies: [comment(1000 + page * 100 + index, body)],
      })), { more: true, cursor: `threads-${page}`, total: 1000 }),
    comments: connection(Array.from({ length: 50 }, (_, index) =>
      comment((3 - page) * 100 + index, body)),
    { more: true, cursor: `comments-${page}`, total: 1000 }),
  }));
  const h = harness({ pages });
  const result = await h.run();
  const value = JSON.parse(result.contextJson);
  assert.equal(h.calls.filter(call => typeof call === "object").length, 3);
  assert.ok(Buffer.byteLength(result.contextJson, "utf8") <= 30000);
  assert.equal(value.truncated, true);
  assert.equal(result.skipReview, false);
  assert.ok(value.threads.length > 0);
  assert.ok(value.threads[0].comments[1].body.includes("truncated"));
  assert.ok(h.notices.some(message => /truncated/i.test(message)));
});

test("invalid inputs, closed PRs, and cross-repository targets fail before context reads", async () => {
  for (const overrides of [
    { repository: "org/repo/extra" }, { repository: "other/repo" },
    { pullRequestNumber: 0 }, { pullRequestNumber: 42.5 },
    { pullRequestNumber: 43 }, { reviewerLogin: "bad login" }, { fullReview: "false" },
  ]) {
    const h = harness();
    Object.assign(h.options, overrides);
    await assert.rejects(h.run(), /invalid|match|boolean/i);
    assert.equal(h.calls.length, 0);
  }
  for (const latest of [
    { state: "closed" },
    { head: { sha: HEAD, repo: { full_name: "fork/repo" } } },
    { head: { sha: HEAD, repo: null } },
    { base: { sha: BASE, repo: { full_name: "other/repo" } } },
  ]) {
    const h = harness({ latest });
    await assert.rejects(h.run(), /open|repository|fork/i);
    assert.equal(h.calls.filter(call => typeof call === "object").length, 0);
  }
});

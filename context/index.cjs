"use strict";

const { createHash } = require("node:crypto");
const { lstatSync, readdirSync, readFileSync } = require("node:fs");
const { join, resolve } = require("node:path");

const SUMMARY_MARKER = "<!-- ai-review-summary:v1 -->";
const MAX_CONTEXT_BYTES = 30000;
const MAX_PAGES = 3;
const MAX_THREADS = 20;
const MAX_COMMENTS = 10;
// Bump when cache or context-selection semantics change, including direct local calls.
const POLICY_VERSION = 1;
const REQUIRED_IMPLEMENTATION_FILES = [
  "action.yml", "context/action.yml", "context/index.cjs", "publish/action.yml", "publish/index.cjs",
  "pyproject.toml", "uv.lock", "src/review.py", "src/model_io.py", "src/external_context.py",
  "sandbox/Dockerfile", "sandbox/network-policy.sh",
];

function implementationRevision(root = resolve(__dirname, "..")) {
  const files = new Set(REQUIRED_IMPLEMENTATION_FILES);
  const collect = (directory, include) => {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      if (entry.name.startsWith(".") || ["__pycache__", "node_modules"].includes(entry.name)) continue;
      const relative = `${directory}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`Implementation path must be a regular file or directory: ${relative}`);
      if (entry.isDirectory()) collect(relative, include);
      else if (include(entry.name)) files.add(relative);
    }
  };
  collect("src", name => name.endsWith(".py"));
  collect("sandbox", name => name === "Dockerfile" || name.endsWith(".sh"));
  for (const directory of ["context", "publish"]) {
    collect(directory, name => /\.(?:cjs|mjs|js|yml|yaml)$/.test(name));
  }
  const manifest = [...files].sort().map(relative => {
    const file = join(root, relative);
    if (!lstatSync(file).isFile()) throw new Error(`Implementation path must be a regular file: ${relative}`);
    return [relative, createHash("sha256").update(readFileSync(file)).digest("hex")];
  });
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

function assertImplementationRevision(snapshotOrJson, root) {
  const snapshot = typeof snapshotOrJson === "string" ? JSON.parse(snapshotOrJson) : snapshotOrJson;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new Error("Invalid review context for the implementation check.");
  }
  if (snapshot.source_digest === undefined) return;
  if (typeof snapshot.source_digest !== "string" || !/^[a-f0-9]{64}$/.test(snapshot.source_digest)) {
    throw new Error("Invalid source_digest in review context.");
  }
  if (snapshot.source_digest !== implementationRevision(root)) {
    throw new Error("The action implementation changed since context collection; collect fresh context before continuing.");
  }
}

const QUERY = `query AIReviewContext($owner: String!, $repo: String!, $number: Int!,
  $threadsBefore: String, $commentsBefore: String,
  $fetchThreads: Boolean!, $fetchComments: Boolean!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      number state headRefOid baseRefOid isDraft
      reviewThreads(last: 50, before: $threadsBefore) @include(if: $fetchThreads) {
        totalCount
        pageInfo { hasPreviousPage startCursor }
        nodes {
          id path line isResolved isOutdated
          root: comments(first: 1) {
            nodes { databaseId: fullDatabaseId body url author { login __typename } }
          }
          replies: comments(last: 5) {
            totalCount
            nodes { databaseId: fullDatabaseId body url author { login __typename } }
          }
        }
      }
      comments(last: 50, before: $commentsBefore) @include(if: $fetchComments) {
        totalCount
        pageInfo { hasPreviousPage startCursor }
        nodes { databaseId: fullDatabaseId body url updatedAt author { login __typename } }
      }
    }
  }
}`;

const login = author => {
  const value = author?.login || "[deleted]";
  return author?.__typename === "Bot" && !value.endsWith("[bot]") ? `${value}[bot]` : value;
};
function commentId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error("Invalid or unsafe REST comment ID.");
  return id;
}
const normalizeComment = node => ({
  id: commentId(node.databaseId), author: login(node.author), body: node.body || "", url: node.url || "",
});

function previousState(comments, isOwn) {
  for (const comment of [...comments].reverse()) {
    if (!isOwn(login(comment.author)) || !comment.body?.includes(SUMMARY_MARKER)) continue;
    const matches = [...comment.body.matchAll(/<!-- ai-review-state:(\{[^\n]*\}) -->/g)];
    if (matches.length !== 1 || !comment.body.trimEnd().endsWith(matches[0][0])) return null;
    try {
      const state = JSON.parse(matches[0][1]);
      if (/^[a-f0-9]{40}$/.test(state.head_sha) && /^[a-f0-9]{40}$/.test(state.base_sha) &&
          /^[a-f0-9]{64}$/.test(state.context_digest) &&
          typeof state.review_complete === "boolean" && typeof state.is_draft === "boolean") {
        return state;
      }
    } catch { /* Ignore malformed state; perform a review instead. */ }
    return null;
  }
  return null;
}

function validateTarget(pr, repository, number) {
  if (!pr || pr.number !== number || pr.state !== "open") {
    throw new Error("The target must be the requested open pull request.");
  }
  if (pr.base?.repo?.full_name?.toLowerCase() !== repository.toLowerCase() ||
      pr.head?.repo?.full_name?.toLowerCase() !== repository.toLowerCase()) {
    throw new Error("Review context requires a same-repository PR; forks and deleted heads are unsupported.");
  }
  if (!/^[a-f0-9]{40}$/.test(pr.head.sha) || !/^[a-f0-9]{40}$/.test(pr.base.sha) ||
      typeof pr.draft !== "boolean") {
    throw new Error("Invalid pull-request revision metadata.");
  }
}

async function collectContext({ github, context, core, repository, pullRequestNumber,
  reviewerLogin = "github-actions[bot]", fullReview = false, reviewProfile, actionRevision }) {
  if (typeof repository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
      repository.split("/").some(part => part === "." || part === "..")) {
    throw new Error("Invalid repository; use owner/name.");
  }
  if (typeof reviewerLogin !== "string" || reviewerLogin.length > 100 ||
      !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\[bot\])?$/i.test(reviewerLogin)) {
    throw new Error("Invalid reviewer-login.");
  }
  if (typeof fullReview !== "boolean") throw new Error("full-review must be a boolean.");
  if (typeof reviewProfile !== "string" || !reviewProfile.trim() ||
      Buffer.byteLength(reviewProfile, "utf8") > 4096 || reviewProfile.includes("\u0000")) {
    throw new Error("review-profile must be a nonempty configuration identity of at most 4096 bytes.");
  }
  const sourceDigest = implementationRevision();
  if (actionRevision === undefined) actionRevision = sourceDigest;
  if (typeof actionRevision !== "string" || !actionRevision.trim() ||
      Buffer.byteLength(actionRevision, "utf8") > 512 || actionRevision.includes("\u0000")) {
    throw new Error("The action revision must be a nonempty reference of at most 512 bytes.");
  }
  const policyDigest = createHash("sha256").update(JSON.stringify({
    schema_version: 1, policy_version: POLICY_VERSION,
    review_profile: reviewProfile, action_revision: actionRevision,
  })).digest("hex");
  const [owner, repo] = repository.split("/");
  const target = { owner, repo, pull_number: Number(pullRequestNumber) };
  if (!Number.isSafeInteger(target.pull_number) || target.pull_number < 1) {
    throw new Error("Invalid pull-request-number.");
  }
  if (context?.repo && `${context.repo.owner}/${context.repo.repo}`.toLowerCase() !== repository.toLowerCase()) {
    throw new Error("Repository does not match the workflow repository.");
  }
  const eventNumber = context?.payload?.pull_request?.number || context?.payload?.issue?.number;
  if (eventNumber && eventNumber !== target.pull_number) {
    throw new Error("Pull request does not match the triggering event.");
  }
  if (context?.payload?.issue && !context.payload.issue.pull_request) {
    throw new Error("The triggering issue must match a pull request.");
  }
  const { data: pr } = await github.rest.pulls.get(target);
  validateTarget(pr, repository, target.pull_number);
  const rawThreads = [];
  const rawComments = [];
  let fetchThreads = true;
  let fetchComments = true;
  let threadsBefore = null;
  let commentsBefore = null;
  let truncated = false;
  let totalThreads = 0;
  let totalComments = 0;
  for (let page = 0; page < MAX_PAGES && (fetchThreads || fetchComments); page++) {
    const response = await github.graphql(QUERY, {
      owner, repo, number: target.pull_number,
      threadsBefore, commentsBefore, fetchThreads, fetchComments,
    });
    const pull = response.repository.pullRequest;
    if (!pull || pull.number !== pr.number || pull.state !== "OPEN" ||
        pull.headRefOid !== pr.head.sha || pull.baseRefOid !== pr.base.sha || pull.isDraft !== pr.draft) {
      throw new Error("The pull request changed while collecting review context; retry on the latest revision.");
    }
    if (fetchThreads) {
      totalThreads = Math.max(totalThreads, pull.reviewThreads.totalCount);
      rawThreads.push(...pull.reviewThreads.nodes);
      fetchThreads = pull.reviewThreads.pageInfo.hasPreviousPage;
      threadsBefore = pull.reviewThreads.pageInfo.startCursor;
      if (fetchThreads && !threadsBefore) throw new Error("Missing review-thread pagination cursor.");
    }
    if (fetchComments) {
      totalComments = Math.max(totalComments, pull.comments.totalCount);
      rawComments.push(...pull.comments.nodes);
      fetchComments = pull.comments.pageInfo.hasPreviousPage;
      commentsBefore = pull.comments.pageInfo.startCursor;
      if (fetchComments && !commentsBefore) throw new Error("Missing comment pagination cursor.");
    }
  }
  const { data: latest } = await github.rest.pulls.get(target);
  validateTarget(latest, repository, target.pull_number);
  if (latest.head.sha !== pr.head.sha || latest.base.sha !== pr.base.sha || latest.draft !== pr.draft ||
      latest.title !== pr.title || latest.body !== pr.body) {
    throw new Error("The pull request changed while collecting review context; retry on the latest revision.");
  }
  if (fetchThreads || fetchComments || new Set(rawThreads.map(thread => thread.id)).size < totalThreads ||
      new Set(rawComments.map(comment => commentId(comment.databaseId))).size < totalComments) truncated = true;
  const isOwn = author => author.toLowerCase() === reviewerLogin.toLowerCase();
  const threads = rawThreads.filter((thread, index, nodes) =>
    nodes.findIndex(item => item.id === thread.id) === index).flatMap(thread => {
    const root = thread.root.nodes[0];
    if (!root) { truncated = true; return []; }
    const comments = [root, ...thread.replies.nodes].map(normalizeComment)
      .filter((comment, index, nodes) => nodes.findIndex(item => item.id === comment.id) === index);
    if (comments.length < thread.replies.totalCount) truncated = true;
    return [{
      id: thread.id, comment_id: commentId(root.databaseId), path: thread.path, line: thread.line,
      is_resolved: thread.isResolved, is_outdated: thread.isOutdated,
      author: login(root.author), is_own: isOwn(login(root.author)), comments,
    }];
  });
  const comments = rawComments.filter(node => !isOwn(login(node.author)))
    .map(normalizeComment).filter((comment, index, nodes) =>
      nodes.findIndex(item => item.id === comment.id) === index);
  const prContext = { title: pr.title, body: pr.body || "" };
  const discussion = threads.map(thread => ({
    id: thread.id, is_resolved: thread.is_resolved, is_outdated: thread.is_outdated,
    comments: thread.comments.filter(comment => !isOwn(comment.author)).sort((a, b) => a.id - b.id),
  })).sort((a, b) => a.id.localeCompare(b.id));
  const digest = createHash("sha256").update(JSON.stringify({
    pr: prContext, threads: discussion, comments: [...comments].sort((a, b) => a.id - b.id),
  })).digest("hex");
  const state = previousState([...rawComments].sort((a, b) =>
    commentId(a.databaseId) - commentId(b.databaseId)), isOwn);
  const complete = state?.review_complete && state.base_sha === pr.base.sha &&
    state.policy_digest === policyDigest;
  const clip = (value, max) => {
    const chars = Array.from(value.replace(/\u0000/g, "\\0"));
    if (chars.length <= max) return chars.join("");
    truncated = true;
    return chars.slice(0, max - 12).join("") + "\n[truncated]";
  };
  const clipComment = comment => ({ ...comment, body: clip(comment.body, 1600) });
  const rank = thread => thread.is_resolved ? 2 : thread.is_own ? 0 : 1;
  threads.sort((a, b) => rank(a) - rank(b) || b.comment_id - a.comment_id);
  comments.sort((a, b) => b.id - a.id);
  if (threads.length > MAX_THREADS || comments.length > MAX_COMMENTS) truncated = true;
  const result = {
    schema_version: 1, pr: { title: clip(prContext.title, 256), body: clip(prContext.body, 4000) },
    threads: threads.slice(0, MAX_THREADS).map(thread => ({
      ...thread, comments: thread.comments.map(clipComment),
    })),
    comments: comments.slice(0, MAX_COMMENTS).map(clipComment),
    previous_head_sha: complete ? state.head_sha : null,
    context_digest: digest, policy_digest: policyDigest, source_digest: sourceDigest, truncated,
  };
  const size = () => Buffer.byteLength(JSON.stringify(result), "utf8");
  if (size() > MAX_CONTEXT_BYTES) {
    result.pr.body = clip(result.pr.body, 1000);
    for (const comment of [...result.comments, ...result.threads.flatMap(thread => thread.comments)]) {
      comment.body = clip(comment.body, 300);
    }
  }
  while (size() > MAX_CONTEXT_BYTES && (result.comments.length || result.threads.length)) {
    truncated = true;
    if (result.comments.length) result.comments.pop();
    else result.threads.pop();
  }
  result.truncated = truncated;
  if (truncated) core?.notice("Review context was truncated; omitted discussion remains unverified.");
  return {
    contextJson: JSON.stringify(result),
    reviewBaseSha: !fullReview && complete && state.head_sha !== pr.head.sha ? state.head_sha : pr.base.sha,
    skipReview: Boolean(!fullReview && !truncated && complete && state.head_sha === pr.head.sha &&
      state.context_digest === digest && state.is_draft === pr.draft),
    headSha: pr.head.sha, baseSha: pr.base.sha,
  };
}

module.exports = { collectContext, implementationRevision, assertImplementationRevision };

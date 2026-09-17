"use strict";

const { createHash } = require("node:crypto");
const { assertImplementationRevision } = require("../context/index.cjs");
const MAX_INVESTIGATION_STEPS = 100;
const MAX_BODY_BYTES = 60000;

async function publishReview({ github, context, core, reportJson, model, runAttempt, serverUrl,
  reviewerLogin = "github-actions[bot]", reviewContext = "", pullRequestNumber = "", headSha = "", baseSha = "" }) {
  if (reviewContext) {
    if (typeof reviewContext !== "string" || Buffer.byteLength(reviewContext, "utf8") > 250000) {
      throw new Error("review-context: invalid or oversized JSON");
    }
    assertImplementationRevision(reviewContext);
  }
  if (pullRequestNumber !== "") {
    if (!/^[1-9][0-9]*$/.test(String(pullRequestNumber)) || !Number.isSafeInteger(Number(pullRequestNumber)) ||
        !/^[a-f0-9]{40}$/i.test(headSha) || !/^[a-f0-9]{40}$/i.test(baseSha)) {
      throw new Error("明示したpull-request-numberには、調査時のhead-shaとbase-shaが必要です。");
    }
    const { data: live } = await github.rest.pulls.get({ ...context.repo, pull_number: Number(pullRequestNumber) });
    if (live.state !== "open" || live.head.sha !== headSha || live.base.sha !== baseSha) {
      core.notice("PRが更新またはクローズされたため、古いレビューの投稿を中止しました。");
      return { published: false };
    }
    context = { ...context, payload: { ...context.payload, pull_request: live } };
  }
  const pr = context.payload.pull_request;
  if (!pr) throw new Error("pull_requestイベントのコンテキストが必要です。");
  const target = { ...context.repo, pull_number: pr.number };
  if (typeof reviewerLogin !== "string" || reviewerLogin.length > 100 ||
      !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\[bot\])?$/i.test(reviewerLogin) ||
      reviewerLogin !== reviewerLogin.trim()) {
    throw new Error("reviewer-loginに投稿トークンのアカウント名を指定してください。");
  }
  const isReviewer = user => user?.login?.toLowerCase() === reviewerLogin.toLowerCase();
  const raw = (reportJson || "").trim();

  // 空出力・巨大な出力・不正なJSONでは投稿せず失敗させる。
  if (!raw || Buffer.byteLength(raw, "utf8") > 60000) {
    throw new Error("レビュー結果が空、またはサイズ上限を超えています。");
  }
  const fenced = raw.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
  const report = JSON.parse(fenced ? fenced[1] : raw);

  const object = v => v !== null && typeof v === "object" && !Array.isArray(v);
  // Pydanticと同じUnicodeコードポイント数で上限を検証する。
  const text = (v, max) => typeof v === "string" &&
    v.trim().length > 0 && Array.from(v).length <= max && !v.includes("\u0000");
  const array = (v, max) => Array.isArray(v) && v.length <= max;
  const requireValid = (ok, label) => {
    if (!ok) throw new Error(`レビューJSONが不正です: ${label}`);
  };

  requireValid(object(report), "ルートオブジェクト");
  requireValid([1, 2].includes(report.schema_version), "schema_version");
  const evidenceBased = report.schema_version === 2;
  requireValid(report.reviewed_head_sha === pr.head.sha, "対象SHAの不一致");
  requireValid(typeof report.review_complete === "boolean", "review_complete");
  requireValid(text(report.summary, 1500), "summary");
  requireValid(array(report.limitations, 10), "limitations");
  requireValid(report.limitations.every(v => text(v, 500)), "limitationsの内容");
  requireValid(array(report.findings, 5), "findings");

  if (evidenceBased) {
    requireValid(text(report.verification_rationale, 500), "verification_rationale");
    requireValid(array(report.investigation, MAX_INVESTIGATION_STEPS), "investigation");
    requireValid(array(report.assessments, 8), "assessments");
    requireValid(array(report.not_run_checks, 6), "not_run_checks");
    const toolNames = ["get_pull_request_diff", "get_review_context", "list_directory", "read_file", "search_text", "run_command", "external_context"];
    for (const [index, step] of report.investigation.entries()) {
      requireValid(object(step) && step.id === index + 1, "investigation.id");
      requireValid(toolNames.includes(step.tool) && Number.isInteger(step.exit_code), "investigation.tool/exit_code");
      requireValid(!Object.hasOwn(step, "code_evidence") || typeof step.code_evidence === "boolean", "investigation.code_evidence");
      requireValid(text(step.purpose, 500) && text(step.command, 2100) && text(step.result, 1000), "investigationの内容");
    }
    const stepIds = new Set(report.investigation.map(step => step.id));
    for (const assessment of report.assessments) {
      requireValid(object(assessment), "assessment");
      requireValid(text(assessment.question, 500) && text(assessment.conclusion, 1000), "assessmentの内容");
      requireValid(typeof assessment.resolved === "boolean", "assessment.resolved");
      const ids = assessment.evidence_step_ids;
      requireValid(array(ids, MAX_INVESTIGATION_STEPS) && new Set(ids).size === ids.length &&
        ids.every(id => Number.isInteger(id) && stepIds.has(id)), "assessment.evidence_step_ids");
      requireValid(!assessment.resolved || ids.length > 0, "解決済み評価の根拠");
    }
    for (const check of report.not_run_checks) {
      requireValid(object(check) && text(check.command, 500) && text(check.result, 1000), "not_run_check");
    }
  } else {
    requireValid(array(report.checks, 30), "checks");
    for (const c of report.checks) {
      requireValid(object(c), "check");
      requireValid(text(c.command, 500) && text(c.result, 1000), "checkの内容");
      requireValid(["passed", "failed", "not_run"].includes(c.status), "check.status");
    }
  }
  for (const f of report.findings) {
    requireValid(object(f), "finding");
    requireValid(["critical", "high", "medium", "low"].includes(f.severity), "severity");
    requireValid(text(f.title, 200) && text(f.body, 3000), "指摘本文");
    requireValid(text(f.file, 500), "file");
    requireValid(!/^[\/]/.test(f.file) && !/[\\`\r\n]/.test(f.file) &&
      !f.file.split("/").some(p => p === ".." || p === "."), "相対パス");
    requireValid(Number.isInteger(f.line) && f.line > 0, "line");
    requireValid(f.existing_thread_id == null || text(f.existing_thread_id, 200), "finding.existing_thread_id");
    if (evidenceBased) {
      const ids = f.evidence_step_ids;
      requireValid(array(ids, MAX_INVESTIGATION_STEPS) && ids.length > 0 && new Set(ids).size === ids.length &&
        ids.every(id => Number.isInteger(id) && report.investigation.some(step => step.id === id)),
      "finding.evidence_step_ids");
    }
  }
  const priorFindings = report.prior_findings || [];
  requireValid(array(priorFindings, 100), "prior_findings");
  const priorIds = new Set();
  for (const prior of priorFindings) {
    requireValid(evidenceBased && object(prior) && text(prior.thread_id, 200) &&
      !priorIds.has(prior.thread_id), "prior_findings.thread_id");
    priorIds.add(prior.thread_id);
    requireValid(["still_present", "fixed", "uncertain"].includes(prior.status) && text(prior.body, 1500),
      "prior_findings.status/body");
    const ids = prior.evidence_step_ids;
    requireValid(array(ids, MAX_INVESTIGATION_STEPS) && (prior.status === "uncertain" || ids.length > 0) && new Set(ids).size === ids.length &&
      ids.every(id => Number.isInteger(id) && report.investigation.some(step => step.id === id)),
    "prior_findings.evidence_step_ids");
    requireValid(prior.status === "uncertain" || ids.some(id =>
      isCodeEvidence(report.investigation.find(step => step.id === id))), "prior_findings.code_evidence");
  }

  // 終了コードやコマンドの成功件数からレビューの良否を推定しない。
  const blocking = evidenceBased && report.findings.some(f => ["critical", "high"].includes(f.severity));
  const cited = new Set(evidenceBased
    ? [...report.assessments, ...report.findings, ...priorFindings].flatMap(item => item.evidence_step_ids) : []);
  const incomplete = !evidenceBased || !report.review_complete || report.limitations.length > 0 ||
    report.assessments.length === 0 || report.assessments.some(a => !a.resolved) ||
    report.not_run_checks.length > 0 ||
    !report.investigation.some(step => step.tool === "get_pull_request_diff") ||
    !report.investigation.some(isCodeEvidence) ||
    report.investigation.some(step => !cited.has(step.id));
  let event = blocking ? "REQUEST_CHANGES" :
    (report.findings.length > 0 || incomplete ? "COMMENT" : "APPROVE");
  const runUrl = `${serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`;
  const renderBody = budgetRenderer(report, core);

  if (reviewContext) {
    return publishWithContext({ github, context, core, report, model, runAttempt, serverUrl,
      isReviewer, reviewContext, event, incomplete, priorFindings, renderBody });
  }
  requireValid(priorFindings.length === 0 && !report.findings.some(f => f.existing_thread_id),
    "review-context is required for existing threads");

  // APIの再試行などで同一実行のレビューが重複することを防ぐ。
  const marker = `<!-- ai-review:${context.runId}:${runAttempt} -->`;
  const previous = await github.paginate(github.rest.pulls.listReviews, {
    ...target, per_page: 100
  });
  if (previous.some(r => isReviewer(r.user) &&
      r.body?.includes(marker))) {
    core.info("この実行のレビューは投稿済みです。");
    return { published: false };
  }

  const order = { critical: 0, high: 1, medium: 2, low: 3 };
  const findings = report.findings.map(finding => ({
    ...finding, evidence_step_ids: evidenceBased ? finding.evidence_step_ids : [],
  })).sort((a, b) => order[a.severity] - order[b.severity]);
  const files = findings.length > 0
    ? await github.paginate(github.rest.pulls.listFiles, { ...target, per_page: 100 })
    : [];
  const { comments, fallbackFindings } = placeFindings(findings, files, { renderBody, runUrl });

  // 投稿直前に確認し、別のコミットや別のマージ先へ古い結果を使わない。
  const { data: latest } = await github.rest.pulls.get(target);
  if (latest.state !== "open" || latest.head.sha !== pr.head.sha ||
      latest.base.sha !== pr.base.sha) {
    core.notice("PRが更新またはクローズされたため、古いレビューの投稿を中止しました。");
    return { published: false };
  }

  // Draftは調査結果だけを返す。
  // 投稿に使うアカウント自身が作成したPRも、自己承認を避けてCOMMENTにする。
  const commentOnly = latest.draft || isReviewer(latest.user);
  if (commentOnly) {
    event = "COMMENT";
  }

  const renderOptions = {
    report, event, incomplete, fallbackFindings, inlineCount: comments.length,
    context, model, serverUrl, marker,
    commentOnly
  };
  const body = renderBody(options => renderReviewBody({ ...renderOptions, ...options }));

  // 通常コメントではなく、対象コミットを指定した正式なPR Review。
  // 権限不足などで失敗した場合は、成功したふりをせずジョブを失敗させる。
  const { data: review } = await github.rest.pulls.createReview({
    ...target,
    commit_id: pr.head.sha,
    event,
    body,
    ...(comments.length > 0 ? { comments } : {})
  });
  core.info(`レビューを投稿しました: ${event} / ${review.html_url}`);
  return { published: true, event, reviewUrl: review.html_url };
}

const SUMMARY_MARKER = "<!-- ai-review-summary:v1 -->";
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function isCodeEvidence(step) {
  if (!step || step.exit_code !== 0) return false;
  if (typeof step.code_evidence === "boolean") {
    return step.code_evidence && ["read_file", "search_text", "get_pull_request_diff"].includes(step.tool);
  }
  const content = step.result.replace(/^\[exit_code=0\](?:\r?\n)?/, "").split(/(?:^|\n)\[stderr\]\n/, 1)[0];
  if (!content.trim()) return false;
  if (["read_file", "search_text"].includes(step.tool)) return true;
  return step.tool === "get_pull_request_diff" && !step.command.includes("--numstat") &&
    content.split("\n[total patch lines]", 1)[0].split("\n").some(line =>
      /^(?:@@|[ +\-])/.test(line) && !/^(?:--- |\+\+\+ )/.test(line) && line.trim());
}
const publicationState = body => {
  const match = body?.match(/<!-- ai-review-state:(\{[^\n]*\}) -->\s*$/);
  try { return match ? JSON.parse(match[1]) : null; } catch { return null; }
};

async function publishWithContext({ github, context, core, report, model, runAttempt, serverUrl,
  isReviewer, reviewContext, event, incomplete, priorFindings, renderBody }) {
  const fail = message => { throw new Error(`review-context: ${message}`); };
  if (typeof reviewContext !== "string" || Buffer.byteLength(reviewContext, "utf8") > 250000) {
    fail("invalid or oversized JSON");
  }
  const snapshot = JSON.parse(reviewContext);
  if (!snapshot || snapshot.schema_version !== 1 || !Array.isArray(snapshot.threads) ||
      snapshot.threads.length > 100 || typeof snapshot.truncated !== "boolean" ||
      typeof snapshot.context_digest !== "string" ||
      !/^[a-zA-Z0-9:_-]{1,128}$/.test(snapshot.context_digest)) fail("invalid snapshot");
  if (Object.hasOwn(snapshot, "policy_digest") &&
      (typeof snapshot.policy_digest !== "string" || !/^[a-f0-9]{64}$/.test(snapshot.policy_digest))) {
    fail("invalid policy_digest");
  }
  const threads = new Map();
  for (const thread of snapshot.threads) {
    if (!thread || typeof thread.id !== "string" || !/^[a-zA-Z0-9_+/=-]{1,200}$/.test(thread.id) ||
        threads.has(thread.id) || !Number.isSafeInteger(thread.comment_id) || thread.comment_id < 1 ||
        typeof thread.is_own !== "boolean") fail("invalid thread");
    threads.set(thread.id, thread);
  }
  const referencedIds = new Set([
    ...priorFindings.map(item => item.thread_id),
    ...report.findings.map(item => item.existing_thread_id).filter(Boolean),
  ]);
  for (const id of referencedIds) {
    if (!threads.get(id)?.is_own) fail("unknown or non-owned thread");
  }
  for (const finding of report.findings) {
    if (finding.existing_thread_id && priorFindings.some(item =>
      item.thread_id === finding.existing_thread_id && item.status === "fixed")) {
      fail("a fixed thread cannot also be a current finding");
    }
  }

  const pr = context.payload.pull_request;
  const target = { ...context.repo, pull_number: pr.number };
  const issueTarget = { ...context.repo, issue_number: pr.number };
  const [reviews, liveComments, issueComments, files] = await Promise.all([
    github.paginate(github.rest.pulls.listReviews, { ...target, per_page: 100 }),
    github.paginate(github.rest.pulls.listReviewComments, { ...target, per_page: 100 }),
    github.paginate(github.rest.issues.listComments, { ...issueTarget, per_page: 100 }),
    report.findings.length ? github.paginate(github.rest.pulls.listFiles, { ...target, per_page: 100 }) : [],
  ]);
  const ownReviews = reviews.filter(item => isReviewer(item.user));
  const ownComments = liveComments.filter(item => isReviewer(item.user));
  const ownSummaries = issueComments.filter(item => isReviewer(item.user) &&
    item.body?.includes(SUMMARY_MARKER)).sort((a, b) => b.id - a.id);
  const summary = ownSummaries[0];
  const ownThreads = [...threads.values()].filter(item => item.is_own);
  const validatedThreads = new Map();
  if (ownThreads.length) {
    // The snapshot is input data: verify each opaque thread ID and REST root against GitHub.
    const result = await github.graphql(`query($ids: [ID!]!) {
      nodes(ids: $ids) { ... on PullRequestReviewThread {
        id isResolved isOutdated
        pullRequest { number repository { nameWithOwner } }
        comments(first: 1) { nodes { databaseId: fullDatabaseId } }
      } }
    }`, { ids: ownThreads.map(thread => thread.id) });
    for (const thread of ownThreads) {
      const node = result.nodes?.find(node => node?.id === thread.id);
      const root = ownComments.find(comment => comment.id === thread.comment_id && !comment.in_reply_to_id);
      const rootId = Number(node?.comments?.nodes?.[0]?.databaseId);
      if (!node || !root || !Number.isSafeInteger(rootId) || rootId !== root.id ||
          node.pullRequest?.number !== pr.number ||
          node.pullRequest?.repository?.nameWithOwner?.toLowerCase() !==
          `${context.repo.owner}/${context.repo.repo}`.toLowerCase()) fail("thread ownership or binding changed");
      validatedThreads.set(thread.id, { ...thread, root, is_resolved: node.isResolved });
    }
  }
  const omitted = [...validatedThreads.values()].filter(thread => !thread.is_resolved &&
    !priorFindings.some(item => item.thread_id === thread.id));
  const stillPresent = priorFindings.some(item => item.status === "still_present");
  const uncertain = priorFindings.some(item => item.status === "uncertain");
  const changedDiscussion = [...validatedThreads.values()].filter(thread =>
    liveComments.some(comment => comment.in_reply_to_id === thread.comment_id &&
      !isReviewer(comment.user) && !(thread.comments || []).some(item => item.id === comment.id &&
        item.body === comment.body)));
  const discussionChanged = (captured, live) => {
    const before = new Map(captured.filter(item => !isReviewer({ login: item.author })).map(item => [item.id, item.body]));
    const after = new Map(live.filter(item => !isReviewer(item.user)).map(item => [item.id, item.body]));
    return before.size !== after.size || [...before].some(([id, body]) => after.get(id) !== body);
  };
  // A complete snapshot contains all discussion; additions, edits and deletions invalidate it.
  const newDiscussion = !snapshot.truncated && (
    discussionChanged(snapshot.comments || [], issueComments) ||
    discussionChanged(snapshot.threads.flatMap(thread => thread.comments || []), liveComments));
  incomplete ||= snapshot.truncated || omitted.length > 0 || uncertain || changedDiscussion.length > 0 || newDiscussion;
  if (event === "APPROVE" && (incomplete || stillPresent)) event = "COMMENT";

  let published = false;
  const current = async () => {
    const { data: latest } = await github.rest.pulls.get(target);
    if (latest.state !== "open" || latest.head.sha !== pr.head.sha || latest.base.sha !== pr.base.sha) {
      core.notice("PRが更新またはクローズされたため、古いレビューの投稿を中止しました。");
      return null;
    }
    if (!snapshot.truncated && snapshot.pr && (
      (typeof snapshot.pr.title === "string" && latest.title !== snapshot.pr.title) ||
      (typeof snapshot.pr.body === "string" && (latest.body ?? "") !== snapshot.pr.body))) {
      core.notice("PRのタイトルまたは説明が調査後に更新されたため、古いレビューの投稿を中止しました。");
      return null;
    }
    return latest;
  };
  const latest = await current();
  if (!latest) return { published: false };
  const commentOnly = latest.draft || isReviewer(latest.user);
  if (commentOnly) event = "COMMENT";
  const state = {
    head_sha: pr.head.sha, base_sha: pr.base.sha, context_digest: snapshot.context_digest,
    ...(snapshot.policy_digest ? { policy_digest: snapshot.policy_digest } : {}),
    review_complete: !incomplete, is_draft: !!latest.draft, event,
  };
  const stateMarker = `<!-- ai-review-state:${JSON.stringify(state)} -->`;
  const runUrl = `${serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`;
  const marker = `<!-- ai-review:${context.runId}:${runAttempt} -->`;
  const label = { APPROVE: "承認", COMMENT: "コメント", REQUEST_CHANGES: "変更をリクエスト" };

  // Every retry checks durable markers in live, bot-authored objects before writing.
  const replyRequests = [];
  for (const prior of priorFindings) {
    const thread = validatedThreads.get(prior.thread_id);
    // A reply arriving during analysis has not been read by the model yet.
    if (newDiscussion || changedDiscussion.some(item => item.id === thread.id)) continue;
    const conversation = liveComments.filter(comment => comment.id === thread.comment_id ||
      comment.in_reply_to_id === thread.comment_id);
    const human = conversation.filter(comment => !isReviewer(comment.user))
      .sort((a, b) => b.id - a.id)[0];
    // Rephrasing the same assessment is not a reason to notify the author again.
    const updateKey = digest([prior.thread_id, prior.status, human?.id || null, human?.body || null]);
    const updateMarker = `<!-- ai-review-thread:${updateKey} -->`;
    const lastBot = conversation.filter(comment => isReviewer(comment.user)).sort((a, b) => b.id - a.id)[0];
    if (lastBot?.body?.includes(updateMarker)) continue;
    const status = { fixed: "修正を確認しました", still_present: "引き続き確認が必要です", uncertain: "まだ判断できません" }[prior.status];
    const evidence = prior.evidence_step_ids.length ? `観測 ${prior.evidence_step_ids.join(", ")}` : "根拠未取得";
    const body = renderBody(({ narrativeLimit }) => `${status}。\n\n` +
      `${narrative(prior.body, narrativeLimit)}${omissionNote(narrativeLimit, runUrl)}\n\n根拠: ${evidence} · ` +
      `[今回の調査ログ](${runUrl})\n\n${updateMarker}`);
    replyRequests.push({ ...target, comment_id: thread.comment_id, body });
  }

  const newFindings = [];
  const knownLinks = [];
  const markedFindings = report.findings.map(finding => ({ ...finding,
    evidence_step_ids: report.schema_version === 2 ? finding.evidence_step_ids : [],
    marker: `<!-- ai-review-finding:${digest([finding.file, finding.line, finding.title, finding.body])} -->`,
  }));
  for (const finding of markedFindings) {
    if (finding.existing_thread_id) {
      const thread = validatedThreads.get(finding.existing_thread_id);
      knownLinks.push({ finding, url: thread.root.html_url, key: thread.id });
      continue;
    }
    const prior = [...ownComments, ...ownReviews].find(item => item.body?.includes(finding.marker));
    if (prior) knownLinks.push({ finding, url: prior.html_url,
      key: [...validatedThreads.values()].find(thread => thread.comment_id === prior.id)?.id || finding.marker });
    else newFindings.push(finding);
  }
  const placed = placeFindings(newFindings, files, { renderBody, runUrl });
  const latestReview = [...ownReviews].filter(item =>
    ["APPROVED", "COMMENTED", "CHANGES_REQUESTED", "DISMISSED"].includes(item.state)).sort((a, b) => b.id - a.id)[0];
  const desiredState = { APPROVE: "APPROVED", COMMENT: "COMMENTED", REQUEST_CHANGES: "CHANGES_REQUESTED" }[event];
  const needsReview = newFindings.length > 0 || !latestReview || latestReview.state !== desiredState ||
    (event === "APPROVE" && (latestReview.commit_id !== pr.head.sha ||
      publicationState(latestReview.body)?.base_sha !== pr.base.sha));
  let reviewUrl = summary?.html_url;
  let reviewRequest = null;
  if (needsReview) {
    const body = renderBody(({ narrativeLimit }) => {
      const formal = [`AIコードレビュー: **${label[event]}${incomplete ? " · 調査未完了" : ""}**`, "",
        "詳しい評価と既存の指摘への対応は、PRの「AIコードレビュー」要約を参照してください。",
        omissionNote(narrativeLimit, runUrl)];
      for (const finding of placed.fallbackFindings) {
        formal.push("", `### [${finding.severity}] ${safe(finding.title)}`, "",
          findingLocation(finding, { context, serverUrl, narrativeLimit }),
          "", narrative(finding.body, narrativeLimit), finding.marker);
      }
      formal.push("", `[今回の調査ログ](${runUrl})`, marker, stateMarker);
      return formal.join("\n");
    });
    reviewRequest = { ...target, commit_id: pr.head.sha,
      event, body, ...(placed.comments.length ? { comments: placed.comments } : {}) };
  }

  const currentFindings = placeFindings(markedFindings.filter(finding => !finding.existing_thread_id), files, { renderBody, runUrl });
  const renderOptions = { report, event, incomplete, fallbackFindings: currentFindings.fallbackFindings,
    inlineCount: newFindings.length ? placed.comments.length : 0, context, model, serverUrl, marker: "", commentOnly };
  const followupText = narrativeLimit => {
    const followup = [];
    for (const link of knownLinks) {
      const locationShown = narrativeLimit <= 100 && currentFindings.fallbackFindings.some(finding =>
        finding.marker === link.finding.marker);
      followup.push(`- [${link.finding.severity}] ` +
        `[${safe(link.finding.title)}](${commentLink(link.url, narrativeLimit)}) ` +
        (locationShown ? "" : `<code>${escapeHtml(link.finding.file)}:L${link.finding.line}</code>`) +
        "（既存の指摘）");
    }
    if (priorFindings.length || omitted.length) followup.push("", "### 以前の指摘の再評価", "");
    for (const prior of priorFindings) {
      const thread = validatedThreads.get(prior.thread_id);
      const stale = newDiscussion || changedDiscussion.some(item => item.id === thread.id);
      const status = stale ? "再確認が必要" : { fixed: "修正確認", still_present: "未修正", uncertain: "未確認" }[prior.status];
      followup.push(`- [${status}](${commentLink(thread.root.html_url, narrativeLimit)}): ${stale ? "調査後に議論が更新されたため、今回の判断は保留しています。" : narrative(prior.body, narrativeLimit)}`);
    }
    for (const thread of omitted) followup.push(`- [再評価が必要な指摘](${commentLink(thread.root.html_url, narrativeLimit)})があります。今回省略されたため、修正済みとは判断していません。`);
    for (const thread of changedDiscussion.filter(thread => !Number.isFinite(narrativeLimit) ||
      !priorFindings.some(prior => prior.thread_id === thread.id))) {
      followup.push(`- [新しい返信](${commentLink(thread.root.html_url, narrativeLimit)})が調査後に追加・更新されたため、次のレビューで確認が必要です。`);
    }
    if (newDiscussion) followup.push("", "PRの議論が調査後に追加・更新・削除されたため、最新の内容を再確認する必要があります。");
    if (snapshot.truncated) followup.push("", "議論の一部を取得できていないため、調査は未完了です。");
    return followup.join("\n");
  };
  const existingCount = new Set([
    ...priorFindings.filter(item => item.status !== "fixed" || newDiscussion).map(item => item.thread_id),
    ...changedDiscussion.map(item => item.id),
    ...omitted.map(item => item.id),
    ...report.findings.map(item => item.existing_thread_id).filter(Boolean),
    ...knownLinks.map(item => item.key),
  ]).size;
  const body = renderBody(options => {
    const rendered = renderReviewBody({ ...renderOptions, ...options })
      .replace(`指摘 ${report.findings.length}件`, `新しい指摘 ${newFindings.length}件 · 既存の指摘 ${existingCount}件`)
      .replace("<details>", `${followupText(options.narrativeLimit)}\n\n<details>`);
    return `${rendered}\n\n${SUMMARY_MARKER}\n${stateMarker}`;
  });
  for (const request of replyRequests) {
    if (!await current()) return { published };
    await github.rest.pulls.createReplyForReviewComment(request);
    published = true;
  }
  if (reviewRequest) {
    if (!await current()) return { published };
    const { data: review } = await github.rest.pulls.createReview(reviewRequest);
    reviewUrl = review.html_url;
    published = true;
  }
  if (!await current()) return { published };
  if (summary?.body !== body) {
    const { data: updated } = summary
      ? await github.rest.issues.updateComment({ ...context.repo, comment_id: summary.id, body })
      : await github.rest.issues.createComment({ ...issueTarget, body });
    reviewUrl = updated.html_url;
    published = true;
  }
  return published ? { published, event, reviewUrl } : { published: false };
}

// AI出力をコードとして評価せず、意図しないメンション通知も抑制する。
const safe = value => value.replace(/@/g, "@\u200b").replace(/<!--\s*ai-review/gi, "&lt;!-- ai-review");
const findingEvidence = finding => finding.evidence_step_ids.length > 0
  ? `\n\n根拠: 観測 ${finding.evidence_step_ids.join(", ")}（レビュー本文の調査ログを参照）` : "";
const escapeHtml = value => safe(value).replace(/&/g, "&amp;")
  .replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Measure the fully rendered body, including escaping, links and durable markers.
// Remove execution output first, then shorten individual descriptions, never the
// assembled Markdown/HTML or its machine-readable state.
function budgetRenderer(report, core) {
  let logged = false;
  return render => {
    let body = render({ includeLogOutput: true, narrativeLimit: Infinity });
    if (Buffer.byteLength(body, "utf8") <= MAX_BODY_BYTES) return body;
    if (!logged) {
      // JSON escapes repository-controlled newlines before they reach runner logs.
      core.info(`AI review full report: ${JSON.stringify(report)}`);
      for (const record of (report.investigation || report.checks)) {
        core.info(`AI review observation: ${JSON.stringify(record)}`);
      }
      logged = true;
    }
    for (const narrativeLimit of [Infinity, 1000, 500, 250, 100, 50, 25, 0]) {
      body = render({ includeLogOutput: false, narrativeLimit });
      if (Buffer.byteLength(body, "utf8") <= MAX_BODY_BYTES) return body;
    }
    throw new Error("指摘の識別情報だけで投稿本文の上限を超えています。");
  };
}

function narrative(value, limit = Infinity, html = false) {
  const characters = Array.from(value);
  if (characters.length <= limit) return html ? escapeHtml(value) : safe(value);
  // Render excerpts as plain escaped text, so a cut cannot open a Markdown fence
  // or leave partially rendered HTML/link syntax around subsequent findings.
  const excerpt = escapeHtml(characters.slice(0, limit).join(""))
    .replace(/[\\[\]()*_~`]/g, character => `&#${character.charCodeAt(0)};`)
    .replace(/\r\n?|\n/g, "<br>");
  return `<span>${excerpt}</span>…（全文は実行ログ）`;
}

const omissionNote = (limit, runUrl) => Number.isFinite(limit)
  ? `\n\n本文が長いため、一部の説明を短く表示しています。[省略した説明の全文](${runUrl})を確認してください。`
  : "";

// These links come from live GitHub comments on this PR. Relative anchors keep
// every old finding reachable even when the summary contains many threads.
const commentLink = (url, limit) => limit <= 100 && /^https?:\/\/[^#]+#(?:discussion_r|pullrequestreview-)\d+$/.test(url)
  ? url.slice(url.indexOf("#")) : url;

function findingLocation(finding, { context, serverUrl, narrativeLimit = Infinity }) {
  const pr = context.payload.pull_request;
  const repoUrl = `${serverUrl}/${context.repo.owner}/${context.repo.repo}`;
  const location = `<code>${escapeHtml(finding.file)}:L${finding.line}</code>`;
  if (narrativeLimit <= 100) return `${location} · [PRの差分](${repoUrl}/pull/${pr.number}/files)`;
  const path = finding.file.split("/").map(part => encodeURIComponent(part)
    .replace(/[!'()*]/g, ch => `%${ch.charCodeAt(0).toString(16)}`)).join("/");
  const revision = finding.removed ? pr.base.sha : pr.head.sha;
  return `<a href="${escapeHtml(`${repoUrl}/blob/${revision}/${path}#L${finding.line}`)}">${location}</a>`;
}

function placeFindings(findings, files, { renderBody, runUrl }) {
  const removedPaths = new Set(files.filter(file => file.status === "removed")
    .map(file => file.filename));
  const linesByPath = new Map();
  for (const file of files) {
    if (file.status === "removed" || !file.patch) continue;
    const lines = new Set();
    let newLine = null;
    for (const row of file.patch.split("\n")) {
      const hunk = row.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunk) {
        newLine = Number(hunk[1]);
      } else if (newLine !== null && (row.startsWith("+") || row.startsWith(" "))) {
        lines.add(newLine++);
      }
    }
    linesByPath.set(file.filename, lines);
  }

  const comments = [];
  const fallbackFindings = [];
  for (const finding of findings) {
    if (linesByPath.get(finding.file)?.has(finding.line)) {
      comments.push({
        path: finding.file, line: finding.line, side: "RIGHT",
        body: renderBody(({ narrativeLimit }) => `**[${finding.severity}] ${safe(finding.title)}**\n\n` +
          narrative(finding.body, narrativeLimit) + findingEvidence(finding)
            .replace("（レビュー本文の調査ログを参照）", ` · [今回の調査ログ](${runUrl})`) +
          omissionNote(narrativeLimit, runUrl) + (finding.marker ? `\n\n${finding.marker}` : "")),
      });
    } else {
      fallbackFindings.push({ ...finding, removed: removedPaths.has(finding.file) });
    }
  }
  return { comments, fallbackFindings };
}

function renderReviewBody({
  report, event, incomplete, fallbackFindings, inlineCount, context, model,
  serverUrl, marker, commentOnly, includeLogOutput = true, narrativeLimit = Infinity,
}) {
  const pr = context.payload.pull_request;
  const repoUrl = `${serverUrl}/${context.repo.owner}/${context.repo.repo}`;
  const runUrl = `${repoUrl}/actions/runs/${context.runId}`;
  const labels = { APPROVE: "承認", COMMENT: "コメント", REQUEST_CHANGES: "変更をリクエスト" };

  const sections = [
    "## AIコードレビュー", "",
    `**${labels[event]}${incomplete ? " · 調査未完了" : ""}** · 指摘 ${report.findings.length}件`, "",
    incomplete ? "必要な検証が残っています。未確認事項を確認してください。" : narrative(report.summary, narrativeLimit), "",
    omissionNote(narrativeLimit, runUrl),
  ];
  if (commentOnly) sections.push("", "Draftまたは同一BotによるPRのため、コメントとして投稿しています。");
  if (inlineCount > 0) sections.push("", `コード上のインラインコメント ${inlineCount}件を確認してください。`);

  for (const finding of fallbackFindings) {
    sections.push("", `### [${finding.severity}] ${safe(finding.title)}`, "",
      findingLocation(finding, { context, serverUrl, narrativeLimit }),
      "", narrative(finding.body, narrativeLimit) + findingEvidence(finding) + (finding.marker ? `\n\n${finding.marker}` : ""));
  }
  const checks = report.not_run_checks || [];
  if (checks.length > 0) {
    sections.push("", "### 未確認", "",
      ...checks.map(c => `- <code>${narrative(c.command, narrativeLimit, true)}</code>: ${narrative(c.result, narrativeLimit, true)}`));
  } else if (report.limitations.length > 0) {
    sections.push("", "### 未確認", "", ...report.limitations.map(value => `- ${narrative(value, narrativeLimit)}`));
  }

  sections.push("", "<details>", "<summary>調査ログ</summary>", "");
  if (incomplete) sections.push("### 調査メモ", "", narrative(report.summary, narrativeLimit, true), "");
  if (report.schema_version === 2) {
    sections.push("### 評価と根拠", "", narrative(report.verification_rationale, narrativeLimit, true), "");
    for (const assessment of report.assessments) {
      const evidence = assessment.evidence_step_ids.length > 0
        ? `観測 ${assessment.evidence_step_ids.join(", ")}` : "根拠未取得";
      sections.push(`- <strong>${narrative(assessment.question, narrativeLimit, true)}</strong> ` +
        `${narrative(assessment.conclusion, narrativeLimit, true)}（${assessment.resolved ? "確認済み" : "未解決"} · ${evidence}）`);
    }
  } else {
    sections.push("旧形式には根拠付きの評価がないため、自動承認しません。", "");
  }
  if (checks.length > 0 && report.limitations.length > 0) {
    sections.push("", "### 制約の詳細", "", ...report.limitations.map(value => `- ${narrative(value, narrativeLimit, true)}`));
  }
  sections.push("", "### 実行記録", "");
  if (includeLogOutput) {
    for (const [index, record] of (report.investigation || report.checks).entries()) {
      sections.push(`#### 観測 ${index + 1}`, "");
      if (record.purpose) sections.push(escapeHtml(record.purpose), "");
      sections.push("コマンド:", `<pre><code>${escapeHtml(record.command)}</code></pre>`, "",
        "結果:", `<pre><code>${escapeHtml(record.result)}</code></pre>`, "");
    }
  } else {
    sections.push(`記録が長いため、詳細は[実行ログ](${runUrl})を参照してください。`, "");
    for (const check of (report.checks || []).filter(check => check.status !== "passed")) {
      sections.push(`- [${check.status}] <code>${narrative(check.command, narrativeLimit, true)}</code>: ` +
        narrative(check.result, narrativeLimit, true));
    }
  }
  sections.push("</details>", "", "---",
    `[実行ログ](${runUrl}) · 対象: \`${pr.head.sha.slice(0, 7)}\` · モデル: \`${safe(model)}\``,
    "AIによる補助レビューです。通常のCIと人間による確認も実施してください。", marker);
  return sections.join("\n");
}

module.exports = { publishReview };

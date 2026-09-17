"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { publishReview } = require("../publish/index.cjs");

function report(overrides = {}) {
  return {
    schema_version: 1,
    reviewed_head_sha: "head123",
    review_complete: true,
    summary: "調査が完了しました。",
    limitations: [],
    checks: [{ command: "git diff", status: "passed", result: "問題なし" }],
    findings: [],
    ...overrides,
  };
}

function finding(severity = "high") {
  return { severity, title: "不具合", file: "src/example.ts", line: 1, body: "具体的な根拠", evidence_step_ids: [1, 2] };
}

function evidenceReport(overrides = {}) {
  return {
    schema_version: 2,
    reviewed_head_sha: "head123",
    review_complete: true,
    summary: "文書の意味を変えない変更です。",
    limitations: [],
    verification_rationale: "文言のみの変更で、差分の内容から判断できます。",
    assessments: [{
      question: "意味が変わっていないか。", conclusion: "意味は同じです。任意リンターは不要です。",
      evidence_step_ids: [1, 2], resolved: true,
    }],
    investigation: [
      { id: 1, tool: "get_pull_request_diff", purpose: "変更内容を確認する。", command: "git diff", exit_code: 0, result: "@@ -1 +1 @@\n-old wording\n+new wording" },
      { id: 2, tool: "run_command", purpose: "任意ツールの有無を調べる。", command: "command -v linter", exit_code: 1, result: "ツールなし" },
    ],
    not_run_checks: [], findings: [], ...overrides,
  };
}

function harness(value = report(), { latest = {}, previous = [], files = [] } = {}) {
  const submitted = [];
  const apiCalls = [];
  const logs = [];
  const pr = {
    number: 42, head: { sha: "head123" }, base: { sha: "base123" },
    state: "open", draft: false, user: { login: "author" },
  };
  const options = {
    context: { payload: { pull_request: pr }, repo: { owner: "org", repo: "repo" }, runId: 100 },
    core: { info(message) { logs.push(message); }, notice() {} },
    reportJson: JSON.stringify(value), model: "gemini-test", runAttempt: "1",
    serverUrl: "https://github.com",
    github: {
      paginate: async (endpoint) => {
        const isFiles = endpoint === options.github.rest.pulls.listFiles;
        apiCalls.push(isFiles ? "files" : "list");
        return isFiles ? files : previous;
      },
      rest: {
        pulls: {
          listReviews() {},
          listFiles() {},
          get: async () => { apiCalls.push("get"); return { data: { ...pr, ...latest } }; },
          createReview: async (request) => {
            apiCalls.push("create");
            submitted.push(request);
            return { data: { html_url: "https://github.com/org/repo/pull/42#review" } };
          },
        },
      },
    },
  };
  return { run: () => publishReview(options), options, submitted, apiCalls, logs };
}

test("MCPの外部根拠を検証して調査ログに表示する", async () => {
  const value = evidenceReport();
  value.investigation[1] = {
    id: 2, tool: "external_context", purpose: "対象版の公式文書を確認する。",
    command: 'mcp docs/query-docs {"libraryId":"/example/v2"}', exit_code: 0,
    result: "https://docs.example.com/v2: documented behavior",
  };
  const h = harness(value);
  assert.equal((await h.run()).event, "APPROVE");
  assert.ok(h.submitted[0].body.includes("mcp docs/query-docs"));
  assert.ok(h.submitted[0].body.includes("https://docs.example.com/v2"));

  value.assessments[0].evidence_step_ids = [1];
  assert.equal((await harness(value).run()).event, "COMMENT");
  value.investigation[1].tool = "unrecognized_mcp_tool";
  await assert.rejects(harness(value).run(), /investigation.tool/);
});

test("任意ツールの探索失敗ではなく根拠付きの評価で承認し、成功件数は表示しない", async () => {
  const h = harness(evidenceReport());
  assert.equal((await h.run()).event, "APPROVE");
  const body = h.submitted[0].body;
  const visible = body.replace(/<details>[\s\S]*?<\/details>/g, "");
  assert.ok(!visible.includes("成功"));
  assert.ok(!visible.includes("失敗"));
  assert.ok(body.includes("意味は同じです"));
  assert.ok(body.includes("文言のみの変更"));
  assert.ok(visible.includes("文書の意味を変えない変更です"));
  assert.ok(body.includes("command -v linter"));
});

test("全コマンドの成功では承認せず、未解決の疑問や必要な検証を理由にコメントする", async () => {
  for (const changes of [
    { assessments: [] },
    { assessments: [{ question: "互換性は維持されるか。", conclusion: "対象環境を再現できません。", evidence_step_ids: [1], resolved: false }] },
    { not_run_checks: [{ command: "integration test", result: "変更した契約の検証が必要ですが、依存関係がありません。" }] },
    { review_complete: false }, { limitations: ["関連実装を読み切れていません。"] },
    { investigation: [] , assessments: [] },
  ]) {
    const h = harness(evidenceReport({
      investigation: evidenceReport().investigation.map(step => ({ ...step, exit_code: 0 })),
      ...changes,
    }));
    assert.equal((await h.run()).event, "COMMENT");
  }
});

test("観測を解釈せずに完了と申告した場合は終了コードによらず承認しない", async () => {
  for (const exit_code of [0, 1, 127]) {
  const h = harness(evidenceReport({ assessments: [{
    question: "変更は安全か。", conclusion: "差分のみ確認しました。", evidence_step_ids: [1], resolved: true,
  }], investigation: evidenceReport().investigation.map(step => ({ ...step, exit_code })) }));
  assert.equal((await h.run()).event, "COMMENT");
  }
});

test("根拠付きの評価が同じなら終了コードだけで判定を変えない", async () => {
  for (const exit_code of [0, 1, 127]) {
    const h = harness(evidenceReport({
      investigation: evidenceReport().investigation.map(step => step.tool === "run_command" ? { ...step, exit_code } : step),
    }));
    assert.equal((await h.run()).event, "APPROVE");
  }
});

test("重大な指摘でも実在する観測の根拠がなければ投稿前に拒否する", async () => {
  for (const evidence_step_ids of [undefined, [], [3], [1, 1]]) {
    const h = harness(evidenceReport({ findings: [{ ...finding(), evidence_step_ids }] }));
    await assert.rejects(h.run(), /finding.evidence_step_ids/);
    assert.deepEqual(h.apiCalls, []);
  }
});

test("修正要求は具体的な重大指摘だけから決まり、コマンド失敗だけでは要求しない", async () => {
  for (const severity of ["critical", "high", "medium", "low"]) {
    const h = harness(evidenceReport({ findings: [finding(severity)] }));
    assert.equal((await h.run()).event, ["critical", "high"].includes(severity) ? "REQUEST_CHANGES" : "COMMENT");
  }
  const h = harness(evidenceReport({ review_complete: false }));
  assert.equal((await h.run()).event, "COMMENT");
});

test("存在しない根拠・重複ID・根拠のない解決済み評価を投稿前に拒否する", async () => {
  for (const evidence_step_ids of [[3], [1, 1], [], ["1"]]) {
    const h = harness(evidenceReport({ assessments: [{
      ...evidenceReport().assessments[0], evidence_step_ids,
    }] }));
    await assert.rejects(h.run(), /レビューJSONが不正/);
    assert.deepEqual(h.apiCalls, []);
  }
  const h = harness(evidenceReport({ investigation: [evidenceReport().investigation[1]] }));
  await assert.rejects(h.run(), /investigation.id/);
  assert.deepEqual(h.apiCalls, []);
});

test("Unicodeの文字数をPydanticと揃え、上限内の絵文字を含む結果を投稿する", async () => {
  const result = "a".repeat(999) + "🎉";
  const h = harness(report({ checks: [{ command: "test", status: "passed", result }] }));
  const output = await h.run();
  assert.equal(output.published, true);
  assert.equal(output.event, "COMMENT");
  assert.equal(h.submitted[0].commit_id, "head123");
  assert.ok(h.submitted[0].body.includes(result));
});

test("上限を超える文字数や不正なレポートをAPI呼び出し前に拒否する", async () => {
  for (const value of [
    report({ checks: [{ command: "test", status: "passed", result: "🎉".repeat(1001) }] }),
    report({ reviewed_head_sha: "other" }),
    report({ checks: Array(31).fill({ command: "test", status: "passed", result: "ok" }) }),
    report({ findings: [{ ...finding(), file: "../outside" }] }),
    report({ summary: "bad\u0000text" }),
  ]) {
    const h = harness(value);
    await assert.rejects(h.run(), /レビューJSONが不正/);
    assert.deepEqual(h.apiCalls, []);
  }
});

test("旧形式の成功記録が30件あっても根拠付き評価なしでは承認しない", async () => {
  const h = harness(report({ checks: Array(30).fill({ command: "test", status: "passed", result: "ok" }) }));
  assert.equal((await h.run()).event, "COMMENT");
});

test("旧形式では重大な指摘でも自動判定せずコメントにする", async () => {
  for (const severity of ["critical", "high", "medium", "low"]) {
    const h = harness(report({ findings: [finding(severity)] }));
    assert.equal((await h.run()).event, "COMMENT");
  }
  for (const changes of [
    { review_complete: false }, { limitations: ["確認できません"] }, { checks: [] },
    { checks: [{ command: "test", status: "failed", result: "エラー" }] },
    { checks: [{ command: "test", status: "not_run", result: "実行不可" }] },
  ]) {
    const h = harness(report(changes));
    assert.equal((await h.run()).event, "COMMENT");
  }
});

test("Draftと同一BotによるPRには承認や修正要求を投稿しない", async () => {
  for (const latest of [{ draft: true }, { user: { login: "github-actions[bot]" } }]) {
    for (const findings of [[], [finding()]]) {
      const h = harness(evidenceReport({ findings }), { latest });
      assert.equal((await h.run()).event, "COMMENT");
    }
  }
});

test("GitHub App自身のPRはコメントに限定し、他のBotのPRは根拠に基づき判定する", async () => {
  for (const login of ["ai-review[bot]", "AI-Review[bot]", "github-actions[bot]", "author"]) {
    for (const findings of [[], [finding()]]) {
      const h = harness(evidenceReport({ findings }), { latest: { user: { login } } });
      h.options.reviewerLogin = "ai-review[bot]";
      const self = login.toLowerCase() === "ai-review[bot]";
      assert.equal((await h.run()).event, self ? "COMMENT" : findings.length ? "REQUEST_CHANGES" : "APPROVE");
      assert.ok(h.submitted[0].body.includes(self ? "**コメント**" : findings.length ? "**変更をリクエスト**" : "**承認**"));
    }
  }
});

test("Head・Baseの更新またはクローズ後は投稿しない", async () => {
  for (const latest of [{ head: { sha: "new" } }, { base: { sha: "new" } }, { state: "closed" }]) {
    const h = harness(report(), { latest });
    assert.equal((await h.run()).published, false);
    assert.deepEqual(h.submitted, []);
  }
});

test("同一実行の重複投稿を防ぐ", async () => {
  const h = harness(report(), {
    previous: [{ user: { login: "github-actions[bot]" }, body: "<!-- ai-review:100:1 -->" }],
  });
  assert.equal((await h.run()).published, false);
  assert.deepEqual(h.submitted, []);
});

test("指定したGitHub Appによる同一実行のレビューだけを重複と判定する", async () => {
  for (const login of ["ai-review[bot]", "AI-Review[bot]", "github-actions[bot]", "author"]) {
    const h = harness(evidenceReport(), {
      previous: [{ user: { login }, body: "<!-- ai-review:100:1 -->" }],
    });
    h.options.reviewerLogin = "ai-review[bot]";
    const duplicate = login.toLowerCase() === "ai-review[bot]";
    assert.equal((await h.run()).published, !duplicate);
    assert.equal(h.submitted.length, duplicate ? 0 : 1);
  }
});

test("投稿者の設定が不正な場合はAPI呼び出し前に停止する", async () => {
  for (const reviewerLogin of ["", "[bot]", "ai-review[bot]\n", "someone else", "a".repeat(101), null, 42]) {
    const h = harness(evidenceReport());
    h.options.reviewerLogin = reviewerLogin;
    await assert.rejects(h.run(), /reviewer-login/);
    assert.deepEqual(h.apiCalls, []);
  }
});

test("レビュー本文のメンションを抑制する", async () => {
  const h = harness(report({ summary: "@someone を確認" }));
  await h.run();
  assert.ok(h.submitted[0].body.includes("@\u200bsomeone"));
});

test("投稿APIの失敗を呼び出し元へ伝える", async () => {
  const h = harness();
  h.options.github.rest.pulls.createReview = async () => { throw new Error("permission denied"); };
  await assert.rejects(h.run(), /permission denied/);
});

test("旧形式の調査ログも折りたたみ、検証の成功件数を本文に表示しない", async () => {
  const h = harness(report({
    checks: [
      { command: "git diff", status: "passed", result: "RAW_DIFF_CONTENT" },
      { command: "pnpm test", status: "failed", result: "RAW_ERROR_CONTENT" },
    ],
  }));
  await h.run();
  const body = h.submitted[0].body;
  const visible = body.replace(/<details>[\s\S]*?<\/details>/g, "");
  assert.ok(!visible.includes("成功 1 / 失敗 1 / 未実行 0"));
  assert.ok(visible.includes("調査未完了"));
  assert.ok(!visible.includes("RAW_DIFF_CONTENT"));
  assert.ok(!visible.includes("RAW_ERROR_CONTENT"));
  assert.ok(body.includes("RAW_DIFF_CONTENT"));
  assert.ok(body.includes("<summary>調査ログ</summary>"));
});

test("未完了レビューは短い未確認事項を表示し、長い評価と矛盾する完了宣言は折りたたむ", async () => {
  const h = harness(evidenceReport({
    summary: "レビューを完了しています。",
    not_run_checks: [{ command: "pnpm lint && pnpm build", result: "依存関係の取得に失敗したため未実行です。" }],
    limitations: ["ネットワーク接続の検証が必要です。"],
    assessments: Array(5).fill({
      question: "変更した実装と設定の整合性を確認できたか。",
      conclusion: "静的に確認した内容と未確認の内容を区別する長い説明。".repeat(10),
      evidence_step_ids: [1, 2], resolved: true,
    }),
  }));
  const result = await h.run();
  assert.equal(result.event, "COMMENT");
  const body = h.submitted[0].body;
  const visible = body.replace(/<details>[\s\S]*?<\/details>/g, "");
  assert.ok(visible.length < 800);
  assert.ok(visible.includes("pnpm lint"));
  assert.ok(!visible.includes("レビューを完了"));
  assert.ok(!visible.includes("静的に確認した内容"));
  assert.ok(body.includes("静的に確認した内容"));
  assert.ok(body.includes("ネットワーク接続の検証"));
});

test("ログ内のHTMLで折りたたみやレビューの表示を壊せない", async () => {
  const h = harness(report({
    checks: [{ command: "echo '<details>'", status: "passed", result: "</details><h1>fake</h1>" }],
  }));
  await h.run();
  const body = h.submitted[0].body;
  assert.ok(body.includes("&lt;/details&gt;&lt;h1&gt;fake&lt;/h1&gt;"));
  assert.equal((body.match(/<\/details>/g) || []).length, 1);
});

test("差分の新しい行に対応する指摘をインラインコメントにし、本文に重複させない", async () => {
  const value = { ...finding(), line: 11 };
  const h = harness(report({ findings: [value] }), {
    files: [{ filename: "src/example.ts", patch: "@@ -10,2 +10,3 @@\n context\n-old\n+changed\n+added" }],
  });
  await h.run();
  const request = h.submitted[0];
  assert.deepEqual(request.comments, [{
    path: "src/example.ts", line: 11, side: "RIGHT",
    body: "**[high] 不具合**\n\n具体的な根拠",
  }]);
  assert.ok(!request.body.includes("具体的な根拠"));
  assert.ok(request.body.includes("インラインコメント 1件"));
  assert.deepEqual(h.apiCalls, ["list", "files", "get", "create"]);
});

test("差分外・削除ファイル・欠落したpatchの指摘は本文のコードリンクへフォールバックする", async () => {
  for (const files of [
    [],
    [{ filename: "src/example.ts" }],
    [{ filename: "src/example.ts", status: "removed", patch: "@@ -1 +0,0 @@\n-deleted" }],
    [{ filename: "src/example.ts", patch: "@@ -10 +10 @@\n-old\n+new" }],
  ]) {
    const h = harness(report({ findings: [finding()] }), { files });
    await h.run();
    assert.equal(h.submitted[0].comments, undefined);
    assert.ok(h.submitted[0].body.includes("具体的な根拠"));
    const revision = files[0]?.status === "removed" ? "base123" : "head123";
    assert.ok(h.submitted[0].body.includes(`https://github.com/org/repo/blob/${revision}/src/example.ts#L1`));
  }
});

test("エスケープでログが大きくなる場合も投稿上限を守り、実行ログへ誘導する", async () => {
  const h = harness(report({
    checks: Array(30).fill({ command: "test", status: "passed", result: "&".repeat(1000) }),
  }));
  await h.run();
  assert.ok(Buffer.byteLength(h.submitted[0].body, "utf8") <= 60000);
  assert.ok(h.submitted[0].body.includes("記録が長いため"));
  const records = h.logs.filter(line => line.startsWith("AI review observation: "));
  assert.equal(records.length, 30);
  assert.equal(JSON.parse(records[0].slice("AI review observation: ".length)).result, "&".repeat(1000));
});

test("長い未確認事項と指摘は重要な識別情報を残し、全文をログへ退避して投稿する", async t => {
  const value = evidenceReport({
    review_complete: false,
    summary: "日本語の調査メモ🎉".repeat(80),
    findings: Array.from({ length: 5 }, (_, index) => ({
      ...finding(index ? "high" : "critical"), title: `重大な問題${index}🎉`,
      file: `src/問題${index}.ts`, body: "```text\n[open ** _ ~ (x) \\\n" + "@".repeat(2900) + "\n```",
    })),
    limitations: ["認証の検証が未完了です。"],
    not_run_checks: Array.from({ length: 6 }, (_, index) => ({
      command: `未実行${index}: ` + '"'.repeat(450), result: "未確認理由: " + "&".repeat(900),
    })),
  });
  const h = harness(value);
  assert.ok(Buffer.byteLength(h.options.reportJson) < 60000);
  await h.run();
  const body = h.submitted[0].body;
  assert.ok(Buffer.byteLength(body) <= 60000);
  assert.ok(body.includes("変更をリクエスト · 調査未完了"));
  for (const item of value.findings) {
    assert.ok(body.includes(`[${item.severity}] ${item.title}`));
    assert.ok(body.includes(`${item.file}:L${item.line}`));
  }
  for (let index = 0; index < 6; index++) assert.ok(body.includes(`未実行${index}`));
  assert.ok(body.includes("認証の検証が未完了"));
  assert.ok(body.includes("全文"));
  assert.ok(body.includes("https://github.com/org/repo/actions/runs/100"));
  assert.equal((body.match(/```/g) || []).length % 2, 0);
  assert.ok(body.includes("&#91;open &#42;&#42; &#95; &#126; &#40;x&#41; &#92;"));
  const saved = h.logs.find(line => line.startsWith("AI review full report: "));
  assert.deepEqual(JSON.parse(saved.slice("AI review full report: ".length)), value);
  assert.ok(!saved.includes("\n"));
  t.diagnostic(`legacy review: ${Buffer.byteLength(body)} UTF-8 bytes`);
});

function statefulHarness(value = evidenceReport(), { threads = [], roots = [] } = {}) {
  const h = harness(value, { files: [{ filename: "src/example.ts", patch: "@@ -0,0 +1 @@\n+new" }] });
  Object.assign(h.options.context.payload.pull_request, { title: "Example", body: "" });
  const reviews = [], summaries = [], reviewComments = [...roots], replies = [];
  const own = { login: "github-actions[bot]" };
  h.options.reviewContext = JSON.stringify({
    schema_version: 1, pr: { title: "Example", body: "" }, threads, comments: [],
    previous_head_sha: null, context_digest: "digest1", truncated: false,
  });
  const pulls = h.options.github.rest.pulls;
  pulls.listReviewComments = () => {};
  h.options.github.rest.issues = {
    listComments() {},
    createComment: async request => {
      h.apiCalls.push("summary-create");
      const item = { id: 900 + summaries.length, user: own, html_url: "https://github.com/org/repo/pull/42#issuecomment-900", ...request };
      summaries.push(item);
      return { data: item };
    },
    updateComment: async request => {
      h.apiCalls.push("summary-update");
      const item = summaries.find(item => item.id === request.comment_id);
      Object.assign(item, request);
      return { data: item };
    },
  };
  h.options.github.paginate = async endpoint => {
    if (endpoint === pulls.listReviews) return reviews;
    if (endpoint === pulls.listReviewComments) return reviewComments;
    if (endpoint === h.options.github.rest.issues.listComments) return summaries;
    return [{ filename: "src/example.ts", patch: "@@ -0,0 +1 @@\n+new" }];
  };
  pulls.createReview = async request => {
    h.apiCalls.push("create");
    h.submitted.push(request);
    const item = { id: reviews.length + 1000, user: own, state: { APPROVE: "APPROVED", REQUEST_CHANGES: "CHANGES_REQUESTED", COMMENT: "COMMENTED" }[request.event], html_url: "https://github.com/org/repo/pull/42#review", ...request };
    reviews.push(item);
    for (const comment of request.comments || []) reviewComments.push({
      id: reviewComments.length + 2000, user: own, ...comment,
      html_url: "https://github.com/org/repo/pull/42#discussion_r2000",
    });
    return { data: item };
  };
  pulls.createReplyForReviewComment = async request => {
    h.apiCalls.push("reply");
    const item = { id: reviewComments.length + 3000, user: own, in_reply_to_id: request.comment_id, ...request };
    replies.push(item);
    reviewComments.push(item);
    return { data: item };
  };
  h.options.github.graphql = async (_query, { ids }) => ({ nodes: ids.map(id => {
    const thread = threads.find(item => item.id === id);
    return thread && {
      id, isResolved: thread.is_resolved, isOutdated: thread.is_outdated,
      pullRequest: { number: 42, repository: { nameWithOwner: "org/repo" } },
      comments: { nodes: [{ databaseId: String(thread.comment_id) }] },
    };
  }) });
  return { ...h, reviews, summaries, reviewComments, replies };
}

function ownThread() {
  return { id: "THREAD_1", comment_id: 51, path: "src/example.ts", line: 1,
    is_resolved: false, is_outdated: false, author: "github-actions[bot]", is_own: true, comments: [] };
}

function ownRoot(overrides = {}) {
  return { id: 51, path: "src/example.ts", user: { login: "github-actions[bot]" },
    body: "**[high] Earlier finding**", html_url: "https://github.com/org/repo/pull/42#discussion_r51", ...overrides };
}

test("多数の既存指摘とUnicodeを含む要約も上限内で全状態・リンクと機械用状態を保持する", async t => {
  const threads = Array.from({ length: 35 }, (_, index) => ({
    ...ownThread(), id: `THREAD_${index}`, comment_id: 51 + index,
  }));
  const roots = threads.map(thread => ownRoot({ id: thread.comment_id,
    html_url: `https://github.com/org/repo/pull/42#discussion_r${thread.comment_id}` }));
  const value = evidenceReport({ prior_findings: threads.map((thread, index) => ({
    thread_id: thread.id, status: ["still_present", "fixed", "uncertain"][index % 3],
    body: `再評価${index} 日本語🎉\n` + "@".repeat(900), evidence_step_ids: [1],
  })) });
  const h = statefulHarness(value, { threads, roots });
  assert.ok(Buffer.byteLength(h.options.reportJson) < 60000);
  await h.run();
  const bodies = [...h.submitted, ...h.summaries, ...h.replies].map(item => item.body);
  for (const body of bodies) assert.ok(Buffer.byteLength(body) <= 60000);
  const body = h.summaries[0].body;
  for (const [index, thread] of threads.entries()) {
    assert.ok(body.includes(`discussion_r${thread.comment_id}`));
    assert.ok(body.includes(`再評価${index}`));
  }
  for (const status of ["未修正", "修正確認", "未確認"]) assert.ok(body.includes(status));
  assert.ok(body.includes("調査未完了"));
  assert.ok(body.includes("全文"));
  assert.ok(body.includes("<!-- ai-review-summary:v1 -->"));
  const state = JSON.parse(body.match(/<!-- ai-review-state:(\{[^\n]*\}) -->$/)[1]);
  assert.equal(state.review_complete, false);
  const saved = h.logs.find(line => line.startsWith("AI review full report: "));
  assert.deepEqual(JSON.parse(saved.slice("AI review full report: ".length)), value);
  t.diagnostic(`summary: ${Buffer.byteLength(body)}; largest reply: ${Math.max(...h.replies.map(item => Buffer.byteLength(item.body)))} UTF-8 bytes`);
});

test("正式レビューとインラインコメントにもUTF8上限を適用し、耐久マーカーを切らない", async t => {
  const value = evidenceReport({ findings: Array.from({ length: 5 }, (_, index) => ({
    ...finding(), title: `問題${index}🎉`, file: `src/fallback${index}.ts`,
    body: "```text\n" + "@".repeat(2980) + "\n```",
  })) });
  const h = statefulHarness(value);
  await h.run();
  const request = h.submitted[0];
  assert.ok(Buffer.byteLength(request.body) <= 60000);
  assert.ok(request.body.includes("省略した説明の全文"));
  const markers = [...request.body.matchAll(/<!-- ai-review-finding:[a-f0-9]{64} -->/g)];
  assert.equal(markers.length, 5);
  assert.match(request.body, /<!-- ai-review-state:\{[^\n]+\} -->$/);
  const inline = statefulHarness(evidenceReport({ findings: [{ ...finding(), body: "🎉".repeat(3000) }] }));
  await inline.run();
  const comment = inline.submitted[0].comments[0];
  assert.ok(Buffer.byteLength(comment.body) <= 60000);
  assert.match(comment.body, /<!-- ai-review-finding:[a-f0-9]{64} -->$/);
  t.diagnostic(`formal review: ${Buffer.byteLength(request.body)}; inline: ${Buffer.byteLength(comment.body)} UTF-8 bytes`);
});

test("100件の再評価と最長Unicodeパスでも指摘・未解決理由・状態を失わず投稿する", async t => {
  const threads = Array.from({ length: 100 }, (_, index) => ({
    ...ownThread(), id: `THREAD_${index}`, comment_id: 51 + index,
  }));
  const roots = threads.map(thread => ownRoot({ id: thread.comment_id,
    html_url: `https://github.com/org/repo/pull/42#discussion_r${thread.comment_id}` }));
  const value = evidenceReport({
    findings: Array.from({ length: 5 }, (_, index) => ({ ...finding(),
      title: `重大な問題${index}` + "🎉".repeat(190), file: `${index}${"🎉".repeat(499)}`,
      body: "全文に残す根拠: " + "&".repeat(500),
    })),
    prior_findings: threads.map((thread, index) => ({ thread_id: thread.id,
      status: "uncertain", body: `再評価${index}は未確認: ` + "@".repeat(150), evidence_step_ids: [],
    })),
    limitations: ["認証の確認が未完了です。"],
    assessments: [{ ...evidenceReport().assessments[0], resolved: false, conclusion: "権限変更の影響が未確認です。" }],
  });
  const h = statefulHarness(value, { threads, roots });
  assert.ok(Buffer.byteLength(h.options.reportJson) < 60000);
  await h.run();
  const body = h.summaries[0].body;
  const allBodies = [...h.submitted, ...h.summaries, ...h.replies].map(item => item.body);
  for (const text of allBodies) assert.ok(Buffer.byteLength(text) <= 60000);
  for (const item of value.findings) {
    assert.ok(body.includes(item.title));
    assert.ok(body.includes(`${item.file}:L1`));
  }
  assert.ok(body.includes("認証の確認が未完了"));
  assert.ok(body.includes("権限変更の影響が未確認"));
  for (const [index, thread] of threads.entries()) {
    assert.ok(body.includes(`再評価${index}は未確認`));
    assert.ok(body.includes(`#discussion_r${thread.comment_id}`));
  }
  assert.equal(JSON.parse(body.match(/<!-- ai-review-state:(\{[^\n]*\}) -->$/)[1]).review_complete, false);
  // A retry may find every fallback finding already posted and every old thread
  // changed during analysis. Preserve each reason without duplicating warnings.
  h.reviewComments.push(...threads.map(thread => ({
    id: 5000 + thread.comment_id, in_reply_to_id: thread.comment_id,
    user: { login: "human" }, body: "追加の確認事項です。",
  })));
  await h.run();
  const updated = h.summaries[0].body;
  assert.ok(Buffer.byteLength(updated) <= 60000);
  for (const thread of threads) assert.ok(updated.includes(`#discussion_r${thread.comment_id}`));
  assert.ok(updated.includes("調査後に議論が更新されたため"));
  assert.ok(updated.includes("認証の確認が未完了"));
  t.diagnostic(`100-thread summary: ${Buffer.byteLength(body)}; largest body: ${Math.max(...allBodies.map(text => Buffer.byteLength(text)))} UTF-8 bytes`);
  t.diagnostic(`100 changed threads plus existing fallback findings: ${Buffer.byteLength(updated)} UTF-8 bytes`);
});

test("同じHeadの再実行は既存の要約を更新し正式レビューを重複させない", async () => {
  const h = statefulHarness();
  await h.run();
  h.options.context.runId = 101;
  h.options.runAttempt = "2";
  await h.run();
  assert.equal(h.summaries.length, 1);
  assert.equal(h.submitted.length, 1);
  assert.ok(h.summaries[0].body.includes("<!-- ai-review-summary:v1 -->"));
  assert.ok(h.summaries[0].body.includes('"head_sha":"head123"'));
});

test("既存スレッドを再利用し人間の新しい返信があるときだけ同じ説明を返す", async () => {
  const value = evidenceReport({ findings: [{ ...finding(), existing_thread_id: "THREAD_1" }],
    prior_findings: [{ thread_id: "THREAD_1", status: "still_present", body: "問題は引き続き再現します。", evidence_step_ids: [1, 2] }] });
  const h = statefulHarness(value, { threads: [ownThread()], roots: [ownRoot()] });
  await h.run();
  assert.equal(h.submitted[0]?.comments, undefined);
  assert.ok(h.summaries[0].body.includes("discussion_r51"));
  assert.equal(h.replies.length, 1);
  h.options.context.runId++;
  await h.run();
  assert.equal(h.replies.length, 1);
  h.reviewComments.push({ id: 9999, in_reply_to_id: 51, user: { login: "author" }, body: "なぜですか？" });
  const snapshot = JSON.parse(h.options.reviewContext);
  snapshot.threads[0].comments.push({ id: 9999, author: "author", body: "なぜですか？" });
  h.options.reviewContext = JSON.stringify(snapshot);
  h.options.context.runId++;
  await h.run();
  assert.equal(h.replies.length, 2);
});

test("未完了から完了への回復と新しいHeadの承認を投稿する", async () => {
  const h = statefulHarness(evidenceReport({ review_complete: false }));
  await h.run();
  h.options.reportJson = JSON.stringify(evidenceReport());
  h.options.runAttempt = "2";
  await h.run();
  assert.deepEqual(h.submitted.map(item => item.event), ["COMMENT", "APPROVE"]);
  h.options.context.payload.pull_request.head.sha = "head456";
  h.options.reportJson = JSON.stringify(evidenceReport({ reviewed_head_sha: "head456" }));
  await h.run();
  assert.equal(h.submitted.at(-1).commit_id, "head456");
  assert.equal(h.submitted.length, 3);
  assert.equal(h.summaries.length, 1);
  h.options.context.payload.pull_request.base.sha = "base456";
  await h.run();
  assert.equal(h.submitted.length, 4);
});

test("他者のスレッドや偽のスレッド対応へ返信せず投稿前に拒否する", async () => {
  for (const invalid of ["foreign", "binding", "missing"]) {
    const value = evidenceReport({ prior_findings: [{ thread_id: "THREAD_1", status: "fixed", body: "修正を確認しました。", evidence_step_ids: [1] }] });
    const h = statefulHarness(value, { threads: [ownThread()], roots: invalid === "missing" ? [] : [ownRoot(invalid === "foreign" ? { user: { login: "other" } } : {})] });
    if (invalid === "binding") h.options.github.graphql = async () => ({ nodes: [{ id: "THREAD_1", comments: { nodes: [{ databaseId: 99 }] } }] });
    await assert.rejects(h.run(), /thread|スレッド/);
    assert.equal(h.replies.length, 0);
    assert.equal(h.summaries.length, 0);
    assert.equal(h.submitted.length, 0);
  }
});

test("既存の指摘を省略しただけでは承認しない", async () => {
  const h = statefulHarness(evidenceReport(), { threads: [ownThread()], roots: [ownRoot()] });
  await h.run();
  assert.equal(h.submitted[0].event, "COMMENT");
  assert.ok(h.summaries[0].body.includes("再評価"));
});

test("レビュー投稿後に要約更新が失敗しても再試行で指摘を重複投稿しない", async () => {
  const h = statefulHarness(evidenceReport({ findings: [finding()] }));
  const create = h.options.github.rest.issues.createComment;
  h.options.github.rest.issues.createComment = async () => { throw new Error("temporary failure"); };
  await assert.rejects(h.run(), /temporary failure/);
  assert.equal(h.submitted.length, 1);
  h.options.github.rest.issues.createComment = create;
  h.options.runAttempt = "2";
  await h.run();
  assert.equal(h.submitted.length, 1);
  assert.equal(h.summaries.length, 1);
  assert.equal(h.reviewComments.length, 1);
});

test("調査後の人間の返信には未読のまま返答せず承認を保留する", async () => {
  const h = statefulHarness(evidenceReport({ prior_findings: [
    { thread_id: "THREAD_1", status: "fixed", body: "修正を確認しました。", evidence_step_ids: [1] },
  ] }), { threads: [ownThread()], roots: [ownRoot()] });
  h.reviewComments.push({ id: 80, in_reply_to_id: 51, user: { login: "author" }, body: "別の条件ではまだ再現します。" });
  await h.run();
  assert.equal(h.replies.length, 0);
  assert.equal(h.submitted[0].event, "COMMENT");
  assert.ok(h.summaries[0].body.includes("新しい返信"));
  assert.ok(!h.summaries[0].body.includes("[修正確認]"));
  assert.ok(h.summaries[0].body.includes("既存の指摘 1件"));
});

test("修正後に同じ問題が再発したときは過去の返信と同じ文面でも更新する", async () => {
  const prior = { thread_id: "THREAD_1", status: "still_present", body: "問題を確認しました。", evidence_step_ids: [1] };
  const h = statefulHarness(evidenceReport({ prior_findings: [prior] }), { threads: [ownThread()], roots: [ownRoot()] });
  await h.run();
  h.options.reportJson = JSON.stringify(evidenceReport({ prior_findings: [{ ...prior, status: "fixed", body: "修正を確認しました。" }] }));
  await h.run();
  h.options.reportJson = JSON.stringify(evidenceReport({ prior_findings: [prior] }));
  await h.run();
  assert.equal(h.replies.length, 3);
});

test("切り詰められた議論と不正な過去指摘の根拠では承認しない", async () => {
  const h = statefulHarness();
  h.options.reviewContext = JSON.stringify({ ...JSON.parse(h.options.reviewContext), truncated: true });
  await h.run();
  assert.equal(h.submitted[0].event, "COMMENT");
  const invalid = statefulHarness(evidenceReport({ prior_findings: [
    { thread_id: "THREAD_1", status: "fixed", body: "修正しました。", evidence_step_ids: [99] },
  ] }));
  await assert.rejects(invalid.run(), /prior_findings.evidence/);
  assert.equal(invalid.submitted.length, 0);
});

test("Dismissされたレビューを新しいレビューの重複とは扱わない", async () => {
  const h = statefulHarness();
  await h.run();
  h.reviews[0].state = "DISMISSED";
  h.options.context.runId++;
  await h.run();
  assert.equal(h.submitted.length, 2);
});

test("継続レビューでも古いHead・Baseへ返信や要約を書き込まない", async () => {
  for (const change of [{ head: { sha: "changed" } }, { base: { sha: "changed" } }, { state: "closed" }]) {
    const h = statefulHarness(evidenceReport({ prior_findings: [
      { thread_id: "THREAD_1", status: "fixed", body: "修正しました。", evidence_step_ids: [1] },
    ] }), { threads: [ownThread()], roots: [ownRoot()] });
    const get = h.options.github.rest.pulls.get;
    h.options.github.rest.pulls.get = async () => ({ data: { ...(await get()).data, ...change } });
    assert.equal((await h.run()).published, false);
    assert.equal(h.replies.length, 0);
    assert.equal(h.summaries.length, 0);
    assert.equal(h.submitted.length, 0);
  }
});

test("他者が要約マーカーをコピーしても編集対象にしない", async () => {
  const h = statefulHarness();
  h.summaries.push({ id: 99, user: { login: "author" }, body: "<!-- ai-review-summary:v1 -->" });
  await h.run();
  assert.equal(h.summaries.length, 2);
  assert.equal(h.summaries[0].body, "<!-- ai-review-summary:v1 -->");
});

test("Draftでは継続レビューもコメントに限定し公開後は承認に更新する", async () => {
  const h = statefulHarness();
  h.options.context.payload.pull_request.draft = true;
  await h.run();
  assert.equal(h.submitted[0].event, "COMMENT");
  h.options.context.payload.pull_request.draft = false;
  await h.run();
  assert.equal(h.submitted[1].event, "APPROVE");
  assert.equal(h.summaries.length, 1);
});

test("PRイベント以外でも調査時のPR番号とHead・Baseを照合して投稿する", async () => {
  const h = statefulHarness(evidenceReport({ reviewed_head_sha: "a".repeat(40) }));
  const live = h.options.context.payload.pull_request;
  live.head.sha = "a".repeat(40);
  live.base.sha = "b".repeat(40);
  h.options.context.payload = { issue: { number: 42 } };
  Object.assign(h.options, { pullRequestNumber: "42", headSha: live.head.sha, baseSha: live.base.sha });
  await h.run();
  assert.equal(h.submitted[0].pull_number, 42);
  assert.equal(h.submitted[0].commit_id, "a".repeat(40));
  assert.equal(h.options.context.payload.pull_request, undefined);
});

test("明示したPR番号にはHead・Baseが必要で変更済みなら投稿しない", async () => {
  for (const change of [{ headSha: "" }, { baseSha: "" }, { pullRequestNumber: "42x" }]) {
    const h = statefulHarness();
    Object.assign(h.options, { pullRequestNumber: "42", headSha: "a".repeat(40), baseSha: "b".repeat(40) }, change);
    await assert.rejects(h.run(), /head-shaとbase-sha/);
    assert.equal(h.submitted.length, 0);
  }
  const h = statefulHarness();
  Object.assign(h.options, { pullRequestNumber: "42", headSha: "a".repeat(40), baseSha: "b".repeat(40) });
  assert.equal((await h.run()).published, false);
  assert.equal(h.summaries.length, 0);
});

test("未調査の過去指摘は根拠なしのuncertainとして報告できるが承認しない", async () => {
  const prior = { thread_id: "THREAD_1", status: "uncertain", body: "調査時間が足りず未確認です。", evidence_step_ids: [] };
  const h = statefulHarness(evidenceReport({ review_complete: false, prior_findings: [prior] }),
    { threads: [ownThread()], roots: [ownRoot()] });
  await h.run();
  assert.equal(h.submitted[0].event, "COMMENT");
  assert.ok(h.replies[0].body.includes("根拠未取得"));
  for (const status of ["fixed", "still_present"]) {
    h.options.reportJson = JSON.stringify(evidenceReport({ prior_findings: [{ ...prior, status }] }));
    await assert.rejects(h.run(), /prior_findings.evidence/);
  }
});

test("調査後の一般コメントや他者のスレッドの変更でも承認を保留する", async () => {
  for (const kind of ["issue", "review"]) {
    const h = statefulHarness();
    const comment = { id: 888, user: { login: "author" }, body: "受け入れ条件を追加しました。" };
    if (kind === "issue") h.summaries.push(comment);
    else h.reviewComments.push(comment);
    await h.run();
    assert.equal(h.submitted[0].event, "COMMENT");
    assert.ok(h.summaries.at(-1).body.includes("最新の内容を再確認"));
  }
});

test("64ビットの文字列スレッドIDをRESTの数値IDと正確に照合する", async () => {
  const comment_id = 4294967296;
  const h = statefulHarness(evidenceReport({ prior_findings: [
    { thread_id: "THREAD_1", status: "fixed", body: "修正しました。", evidence_step_ids: [1] },
  ] }), { threads: [{ ...ownThread(), comment_id }], roots: [ownRoot({ id: comment_id })] });
  await h.run();
  assert.equal(h.replies[0].comment_id, comment_id);
});

test("同じ状態の言い換えは返信せず同じIDの人間の返信が編集されたら返答する", async () => {
  const prior = { thread_id: "THREAD_1", status: "still_present", body: "空の入力で失敗します。", evidence_step_ids: [1] };
  const human = { id: 80, in_reply_to_id: 51, user: { login: "author" }, body: "空の入力も対応しますか？" };
  const thread = { ...ownThread(), comments: [{ id: 80, author: "author", body: human.body }] };
  const h = statefulHarness(evidenceReport({ prior_findings: [prior] }), { threads: [thread], roots: [ownRoot(), human] });
  await h.run();
  h.options.context.runId++;
  h.options.reportJson = JSON.stringify(evidenceReport({ prior_findings: [{ ...prior, body: "入力が空の場合は引き続きエラーになります。" }] }));
  await h.run();
  assert.equal(h.replies.length, 1);
  human.body = "空の入力では0を返すことにしました。";
  const snapshot = JSON.parse(h.options.reviewContext);
  snapshot.threads[0].comments[0].body = human.body;
  h.options.reviewContext = JSON.stringify(snapshot);
  h.options.context.runId++;
  await h.run();
  assert.equal(h.replies.length, 2);
});

test("ファイル一覧と議論だけを読んだレビューは完了と申告しても承認しない", async () => {
  const investigation = [
    { ...evidenceReport().investigation[0], command: "git diff --numstat", result: "1\t1\tsrc/example.ts" },
    { ...evidenceReport().investigation[1], tool: "get_review_context", command: "get_review_context", exit_code: 0, result: "修正したとの返信です。" },
  ];
  const h = harness(evidenceReport({ investigation }));
  assert.equal((await h.run()).event, "COMMENT");
  for (const status of ["fixed", "still_present"]) {
    const invalid = statefulHarness(evidenceReport({ investigation, prior_findings: [
      { thread_id: "THREAD_1", status, body: "確認しました。", evidence_step_ids: [1, 2] },
    ] }), { threads: [ownThread()], roots: [ownRoot()] });
    await assert.rejects(invalid.run(), /prior_findings.code_evidence/);
    assert.equal(invalid.replies.length, 0);
  }
});

test("100件までの調査記録と全種類の根拠参照を受け入れ上限超過を拒否する", async () => {
  const investigation = Array.from({ length: 100 }, (_, index) => ({
    id: index + 1, tool: index ? "read_file" : "get_pull_request_diff", purpose: "Inspect source.",
    command: "[omitted]", result: "[omitted]", exit_code: 0, code_evidence: true,
  }));
  const evidence_step_ids = investigation.map(step => step.id);
  const value = evidenceReport({ investigation, assessments: [
    { ...evidenceReport().assessments[0], evidence_step_ids },
  ] });
  assert.equal((await harness(value).run()).event, "APPROVE");
  assert.equal((await harness({ ...value, findings: [{ ...finding(), evidence_step_ids }] }).run()).event, "REQUEST_CHANGES");
  const prior = statefulHarness({ ...value, prior_findings: [
    { thread_id: "THREAD_1", status: "fixed", body: "修正しました。", evidence_step_ids },
  ] }, { threads: [ownThread()], roots: [ownRoot()] });
  assert.equal((await prior.run()).event, "APPROVE");
  const overLimit = harness({ ...value, investigation: [...investigation, { ...investigation[0], id: 101 }] });
  await assert.rejects(overLimit.run(), /investigation/);
  assert.equal(overLimit.apiCalls.length, 0);
});

test("圧縮された観測でもオーケストレーターのコード根拠フラグを検証する", async () => {
  for (const override of [
    { code_evidence: false }, { code_evidence: true, exit_code: 1 },
    { code_evidence: true, tool: "get_review_context" },
  ]) {
    const value = evidenceReport({ investigation: [
      { ...evidenceReport().investigation[0], ...override }, evidenceReport().investigation[1],
    ] });
    assert.equal((await harness(value).run()).event, "COMMENT");
  }
  for (const code_evidence of ["true", 1, null]) {
    const h = harness(evidenceReport({ investigation: [
      { ...evidenceReport().investigation[0], code_evidence }, evidenceReport().investigation[1],
    ] }));
    await assert.rejects(h.run(), /code_evidence/);
    assert.equal(h.apiCalls.length, 0);
  }
});

test("調査中にPRのタイトルや説明が変更された場合は返信も承認も投稿しない", async () => {
  for (const changes of [{ title: "Different requirement" }, { body: "Use a different behavior." }]) {
    const h = statefulHarness(evidenceReport({ prior_findings: [
      { thread_id: "THREAD_1", status: "fixed", body: "修正しました。", evidence_step_ids: [1] },
    ] }), { threads: [ownThread()], roots: [ownRoot()] });
    const get = h.options.github.rest.pulls.get;
    h.options.github.rest.pulls.get = async () => ({ data: { ...(await get()).data, ...changes } });
    assert.equal((await h.run()).published, false);
    assert.equal(h.submitted.length, 0);
    assert.equal(h.replies.length, 0);
    assert.equal(h.summaries.length, 0);
  }
});

test("レビュー方針のdigestを保存し旧contextには方針を捏造しない", async () => {
  for (const policy_digest of [undefined, "d".repeat(64)]) {
    const h = statefulHarness();
    const snapshot = JSON.parse(h.options.reviewContext);
    if (policy_digest !== undefined) snapshot.policy_digest = policy_digest;
    h.options.reviewContext = JSON.stringify(snapshot);
    await h.run();
    const state = JSON.parse(h.summaries[0].body.match(/<!-- ai-review-state:(\{[^\n]*\}) -->$/)[1]);
    assert.equal(state.policy_digest, policy_digest);
    assert.equal(Object.hasOwn(state, "policy_digest"), policy_digest !== undefined);
  }
  for (const policy_digest of [null, "", "invalid", "D".repeat(64)]) {
    const h = statefulHarness();
    h.options.reviewContext = JSON.stringify({ ...JSON.parse(h.options.reviewContext), policy_digest });
    await assert.rejects(h.run(), /policy_digest/);
    assert.equal(h.submitted.length, 0);
    assert.equal(h.summaries.length, 0);
  }
});

test("取得後にActionの実装が変わった場合はGitHub APIを呼ぶ前に投稿を停止する", async () => {
  const { implementationRevision } = require("../context/index.cjs");
  for (const source_digest of [null, "invalid", "A".repeat(64), "0".repeat(64)]) {
    const h = statefulHarness();
    h.options.reviewContext = JSON.stringify({ ...JSON.parse(h.options.reviewContext), source_digest });
    await assert.rejects(h.run(), /source_digest|implementation changed/);
    assert.deepEqual(h.apiCalls, []);
    assert.equal(h.submitted.length + h.summaries.length + h.replies.length, 0);
  }
  const valid = statefulHarness();
  valid.options.reviewContext = JSON.stringify({
    ...JSON.parse(valid.options.reviewContext), source_digest: implementationRevision(),
  });
  assert.equal((await valid.run()).published, true);

  const explicit = statefulHarness();
  Object.assign(explicit.options, { pullRequestNumber: "42", headSha: "a".repeat(40), baseSha: "b".repeat(40),
    reviewContext: JSON.stringify({ ...JSON.parse(explicit.options.reviewContext), source_digest: "0".repeat(64) }),
  });
  await assert.rejects(explicit.run(), /implementation changed/);
  assert.deepEqual(explicit.apiCalls, []);
});

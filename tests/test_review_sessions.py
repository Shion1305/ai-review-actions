from __future__ import annotations

import io
import json
import subprocess
import tempfile
import unittest
from contextlib import redirect_stdout
from dataclasses import replace
from pathlib import Path

import test_review
from pydantic_ai.messages import ModelResponse, RetryPromptPart, ToolCallPart, ToolReturnPart
from pydantic_ai.models.function import FunctionModel
from test_review import CheckoutSandbox, FakeSandbox, review


class ReviewSessionTest(unittest.TestCase):
    def test_working_notes_replace_old_notes_and_require_real_evidence_ids(self):
        tools = review.ReviewTools(
            FakeSandbox(review.CommandResult(0, "source", "")), "base", "head"
        )
        with redirect_stdout(io.StringIO()):
            tools.read_file("app.py")
        tools.save_review_notes("Possible empty-input failure; verify caller.", [1])
        tools.save_review_notes("Caller guarantees a nonempty list; check second branch.", [1])
        self.assertNotIn("Possible empty-input", tools.review_notes)
        self.assertEqual(json.loads(tools.review_notes)["evidence_step_ids"], [1])
        self.assertEqual(len(tools.steps), 1)
        for summary, ids in [("unobserved", [99]), ("duplicates", [1, 1]), ("大" * 2000, [1])]:
            with self.subTest(ids=ids), self.assertRaises(review.ModelRetry):
                tools.save_review_notes(summary, ids)

    def test_archived_observations_are_paged_without_reexecuting_commands(self):
        sandbox = FakeSandbox(review.CommandResult(0, "header\n" + "中" * 7000 + "\nLAST", ""))
        tools = review.ReviewTools(sandbox, "base", "head")
        with redirect_stdout(io.StringIO()):
            first = tools.run_command("build", "Inspect the build result.")
        self.assertIn("truncated", first)
        calls = list(sandbox.calls)
        index = json.loads(tools.read_observation())
        self.assertEqual(index["observations"][0]["step_id"], 1)
        self.assertEqual(index["observations"][0]["tool"], "run_command")
        collected = []
        start_char = 0
        while start_char is not None:
            result = tools.read_observation(1, start_char=start_char)
            self.assertTrue(result.startswith("[step_id=1]"))
            page = json.loads(result.split("\n", 1)[1])
            self.assertTrue(page["historical"])
            self.assertLess(len(result.encode()), 6100)
            collected.append(page["result"])
            start_char = page["next_char"]
        self.assertIn("中" * 7000, "".join(collected))
        self.assertIn("LAST", "".join(collected))
        self.assertEqual(sandbox.calls, calls)
        self.assertEqual(len(tools.steps), 1)
        with self.assertRaises(ValueError):
            tools.read_observation(99)
        with self.assertRaises(ValueError):
            tools.read_observation(1, start_char=-1)

    def test_model_recalls_evidence_after_it_leaves_the_conversation_window(self):
        class Sandbox(CheckoutSandbox):
            def execute(self, command, timeout_seconds=120):
                if command[:2] == ["sed", "-n"]:
                    self.calls.append((command, timeout_seconds))
                    body = "earlier-evidence-marker" if "old.py" in command else "recent evidence"
                    return review.CommandResult(0, body, "")
                return super().execute(command, timeout_seconds)

        turn = 0
        sandbox = Sandbox()
        source_calls_before_recall = 0

        def respond(messages, info):
            nonlocal turn, source_calls_before_recall
            turn += 1
            if turn == 1:
                return ModelResponse([ToolCallPart("get_pull_request_diff", {})])
            if turn <= 11:
                path = "old.py" if turn == 2 else "recent.py"
                return ModelResponse([ToolCallPart("read_file", {"path": path})])
            if turn == 12:
                self.assertNotIn("earlier-evidence-marker", str(messages))
                source_calls_before_recall = len(sandbox.calls)
                return ModelResponse([ToolCallPart("read_observation", {"step_id": 2})])
            self.assertIn("earlier-evidence-marker", str(messages[-1]))
            self.assertEqual(len(sandbox.calls), source_calls_before_recall)
            return ModelResponse(
                [
                    ToolCallPart(
                        info.output_tools[0].name,
                        {
                            "review_complete": False,
                            "summary": "Archived evidence recalled.",
                            "limitations": [
                                "This fixture intentionally leaves the review incomplete."
                            ],
                            "findings": [],
                        },
                    )
                ]
            )

        with redirect_stdout(io.StringIO()):
            result = review.review_pull_request(
                test_review.ReviewPromptTest().config(), sandbox, model=FunctionModel(respond)
            )
        self.assertEqual(len(result.investigation), 11)
        self.assertFalse(result.review_complete)

    def test_more_than_thirty_small_tool_calls_can_complete(self):
        class SourceSandbox(CheckoutSandbox):
            def execute(self, command, timeout_seconds=120):
                if command[:2] == ["sed", "-n"]:
                    return review.CommandResult(0, "return checked_value", "")
                return super().execute(command, timeout_seconds)

        turns = []

        def respond(_messages, info):
            turns.append(1)
            if len(turns) == 1:
                return ModelResponse([ToolCallPart("get_pull_request_diff", {})])
            if len(turns) <= 36:
                return ModelResponse([ToolCallPart("read_file", {"path": "app.py"})])
            return ModelResponse(
                [
                    ToolCallPart(
                        info.output_tools[0].name,
                        {
                            "review_complete": True,
                            "summary": "Checked paged observations.",
                            "limitations": [],
                            "verification_rationale": "Inspected relevant code pages.",
                            "findings": [],
                            "assessments": [
                                {
                                    "question": "Are changes valid?",
                                    "conclusion": "Checked the source.",
                                    "evidence_step_ids": list(range(1, 37)),
                                    "resolved": True,
                                }
                            ],
                        },
                    )
                ]
            )

        with redirect_stdout(io.StringIO()):
            report = review.review_pull_request(
                test_review.ReviewPromptTest().config(),
                SourceSandbox(),
                model=FunctionModel(respond),
            )
        self.assertTrue(report.review_complete)
        self.assertEqual(len(report.investigation), 36)

    def test_configured_tool_ceiling_stops_at_that_limit_without_approval(self):
        def respond(messages, _info):
            has_returns = any(isinstance(p, ToolReturnPart) for m in messages for p in m.parts)
            return ModelResponse(
                [
                    ToolCallPart(
                        "read_file" if has_returns else "get_pull_request_diff",
                        {"path": "app.py"} if has_returns else {},
                    )
                ]
            )

        config = replace(
            test_review.ReviewPromptTest().config(), tool_call_limit=34, investigation_tool_limit=30
        )
        with redirect_stdout(io.StringIO()):
            report = review.review_pull_request(
                config, CheckoutSandbox(), model=FunctionModel(respond)
            )
        self.assertFalse(report.review_complete)
        self.assertEqual(len(report.investigation), 34)
        self.assertTrue(report.limitations)

    def test_diff_starts_with_file_inventory_not_entire_lockfile(self):
        class Sandbox(CheckoutSandbox):
            def execute(self, command, timeout_seconds=120):
                self.calls.append((command, timeout_seconds))
                if "--numstat" in " ".join(command):
                    return review.CommandResult(0, "2\t1\tapp.py\n9000\t8000\tpnpm-lock.yaml\n", "")
                return review.CommandResult(0, "huge lockfile diff\n" * 9000, "")

        tools = review.ReviewTools(Sandbox(), "base", "head")
        with redirect_stdout(io.StringIO()):
            result = tools.get_pull_request_diff()
        self.assertIn("pnpm-lock.yaml", result)
        self.assertNotIn("huge lockfile diff", result)

    def test_real_git_inventory_and_patch_pages_cover_middle_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)

            def git(*args):
                return subprocess.run(
                    ["git", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", *args],
                    cwd=root,
                    text=True,
                    capture_output=True,
                    check=True,
                ).stdout.strip()

            git("init", "-q")
            git(
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.com",
                "commit",
                "--allow-empty",
                "-qm",
                "base",
            )
            base = git("rev-parse", "HEAD")
            for index in range(200):
                folder = root / f"packages/service_{index:04}" / ("nested_" * 8)
                folder.mkdir(parents=True)
                (folder / "app.py").write_text("line\n" * 100, encoding="utf-8")
            git("add", ".")
            git(
                "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "head"
            )
            head = git("rev-parse", "HEAD")

            class Sandbox:
                def execute(self, command, timeout_seconds=120):
                    result = subprocess.run(
                        command, cwd=root, text=True, capture_output=True, timeout=timeout_seconds
                    )
                    return review.CommandResult(result.returncode, result.stdout, result.stderr)

            tools = review.ReviewTools(Sandbox(), base, head)
            path = f"packages/service_0090/{'nested_' * 8}/app.py"
            with redirect_stdout(io.StringIO()):
                first = tools.get_pull_request_diff(start_line=1, end_line=20)
                middle = tools.get_pull_request_diff(start_line=81, end_line=100)
                patch = tools.get_pull_request_diff(path=path, start_line=30, end_line=40)
                past_end = tools.get_pull_request_diff(path=path, start_line=200, end_line=210)
            self.assertNotIn("service_0090", first)
            self.assertIn("service_0090", middle)
            self.assertRegex(middle, r"\[total inventory lines\]\s+200")
            self.assertEqual(patch.count("+line"), 11)
            self.assertIn("[total patch lines]", patch)
            self.assertEqual(tools.code_evidence_step_ids, {3})
            self.assertNotIn("+line", past_end)
            invalid = review.ReviewTools(Sandbox(), "missing-revision", head)
            with redirect_stdout(io.StringIO()):
                invalid.get_pull_request_diff(path=path)
            self.assertNotEqual(invalid.steps[0].exit_code, 0)
            self.assertEqual(invalid.code_evidence_step_ids, set())

    def test_inventory_and_reply_cannot_certify_previous_finding_as_fixed(self):
        context = {
            "threads": [
                {
                    "id": "T1",
                    "is_own": True,
                    "is_resolved": False,
                    "comments": [{"body": "Fixed now."}],
                }
            ]
        }
        config = replace(test_review.ReviewPromptTest().config(), review_context=context)
        rejections = []

        def respond(messages, info):
            returns = [p for m in messages for p in m.parts if isinstance(p, ToolReturnPart)]
            retries = [p for m in messages for p in m.parts if isinstance(p, RetryPromptPart)]
            if not returns:
                return ModelResponse([ToolCallPart("get_pull_request_diff", {})])
            if len(returns) == 1:
                return ModelResponse([ToolCallPart("get_review_context", {"thread_id": "T1"})])
            if retries:
                rejections.append(str(retries[-1].content))
            return ModelResponse(
                [
                    ToolCallPart(
                        info.output_tools[0].name,
                        {
                            "review_complete": not bool(retries),
                            "summary": "Checked discussion.",
                            "limitations": ["Code remains unverified."] if retries else [],
                            "verification_rationale": "Read discussion and file list.",
                            "assessments": [
                                {
                                    "question": "Is the fix verified?",
                                    "conclusion": "See the reply.",
                                    "evidence_step_ids": [1, 2],
                                    "resolved": not bool(retries),
                                }
                            ],
                            "findings": [],
                            "prior_findings": [
                                {
                                    "thread_id": "T1",
                                    "status": "uncertain" if retries else "fixed",
                                    "body": "A fix is claimed.",
                                    "evidence_step_ids": [2],
                                }
                            ],
                        },
                    )
                ]
            )

        with redirect_stdout(io.StringIO()):
            report = review.review_pull_request(
                config, CheckoutSandbox(), model=FunctionModel(respond)
            )
        self.assertTrue(rejections)
        self.assertFalse(report.review_complete)
        self.assertEqual(report.prior_findings[0].status, "uncertain")

    def test_inventory_alone_does_not_complete_review(self):
        def respond(messages, info):
            if not any(isinstance(p, ToolReturnPart) for m in messages for p in m.parts):
                return ModelResponse([ToolCallPart("get_pull_request_diff", {})])
            return ModelResponse(
                [
                    ToolCallPart(
                        info.output_tools[0].name,
                        {
                            "review_complete": True,
                            "summary": "Reviewed file names.",
                            "limitations": [],
                            "verification_rationale": "Read the file list.",
                            "findings": [],
                            "assessments": [
                                {
                                    "question": "Are changes valid?",
                                    "conclusion": "Files look fine.",
                                    "evidence_step_ids": [1],
                                    "resolved": True,
                                }
                            ],
                        },
                    )
                ]
            )

        with redirect_stdout(io.StringIO()):
            report = review.review_pull_request(
                test_review.ReviewPromptTest().config(),
                CheckoutSandbox(),
                model=FunctionModel(respond),
            )
        self.assertFalse(report.review_complete)

    def test_prior_status_requires_successful_nonempty_code_inspection(self):
        context = {
            "threads": [
                {
                    "id": "T1",
                    "is_own": True,
                    "is_resolved": False,
                    "comments": [{"body": "Please verify the fix."}],
                }
            ]
        }
        config = replace(test_review.ReviewPromptTest().config(), review_context=context)
        for status in ("fixed", "still_present"):
            for result in [
                review.CommandResult(0, "return validate_input(value)", ""),
                review.CommandResult(1, "partial output", "read failed"),
                review.CommandResult(0, "", ""),
            ]:

                class SourceSandbox(CheckoutSandbox):
                    def execute(self, command, timeout_seconds=120):
                        if command[:2] == ["sed", "-n"]:
                            return result
                        return super().execute(command, timeout_seconds)

                def respond(messages, info):
                    returns = [
                        p for m in messages for p in m.parts if isinstance(p, ToolReturnPart)
                    ]
                    retried = any(isinstance(p, RetryPromptPart) for m in messages for p in m.parts)
                    if not returns:
                        return ModelResponse([ToolCallPart("get_pull_request_diff", {})])
                    if len(returns) == 1:
                        return ModelResponse(
                            [ToolCallPart("get_review_context", {"thread_id": "T1"})]
                        )
                    if len(returns) == 2:
                        return ModelResponse([ToolCallPart("read_file", {"path": "app.py"})])
                    return ModelResponse(
                        [
                            ToolCallPart(
                                info.output_tools[0].name,
                                {
                                    "review_complete": not retried,
                                    "summary": "Verified the old concern.",
                                    "limitations": ["Code could not be inspected."]
                                    if retried
                                    else [],
                                    "verification_rationale": "Checked source and discussion.",
                                    "assessments": [
                                        {
                                            "question": "Does the concern remain?",
                                            "conclusion": "Checked source.",
                                            "evidence_step_ids": [1, 2, 3],
                                            "resolved": not retried,
                                        }
                                    ],
                                    "findings": [],
                                    "prior_findings": [
                                        {
                                            "thread_id": "T1",
                                            "status": "uncertain" if retried else status,
                                            "body": "Checked against the current code.",
                                            "evidence_step_ids": [2, 3],
                                        }
                                    ],
                                },
                            )
                        ]
                    )

                with self.subTest(status=status, result=result), redirect_stdout(io.StringIO()):
                    report = review.review_pull_request(
                        config, SourceSandbox(), model=FunctionModel(respond)
                    )
                    has_code = result.exit_code == 0 and bool(result.stdout)
                    self.assertEqual(report.review_complete, has_code)
                    self.assertEqual(
                        report.prior_findings[0].status, status if has_code else "uncertain"
                    )

    def test_tool_results_are_byte_bounded_before_entering_history(self):
        tools = review.ReviewTools(
            FakeSandbox(review.CommandResult(0, "START " + "大" * 100_000 + " END", "")),
            "base",
            "head",
        )
        with redirect_stdout(io.StringIO()):
            result = tools.run_command("build", "Inspect the build failure.")
        self.assertLessEqual(len(result.encode()), 6100)
        self.assertIn("START", result)
        self.assertIn("END", result)
        self.assertIn("truncated", result)

    def test_discussion_replies_are_available_without_treating_outdated_as_fixed(self):
        context = {
            "schema_version": 1,
            "pr": {"title": "Test", "body": "Requirements"},
            "threads": [
                {
                    "id": "T1",
                    "comment_id": 1,
                    "path": "app.py",
                    "line": None,
                    "author": "review[bot]",
                    "is_own": True,
                    "is_resolved": False,
                    "is_outdated": True,
                    "comments": [{"id": 2, "author": "user", "body": "Fixed in abc.", "url": ""}],
                }
            ],
            "comments": [],
            "context_digest": "abc",
            "truncated": False,
        }
        config = replace(test_review.ReviewPromptTest().config(), review_context=context)
        observed = []

        def respond(messages, info):
            returns = [p for m in messages for p in m.parts if isinstance(p, ToolReturnPart)]
            if not returns:
                return ModelResponse([ToolCallPart("get_pull_request_diff", {})])
            if len(returns) == 1:
                return ModelResponse([ToolCallPart("get_review_context", {"thread_id": "T1"})])
            observed.append(str(returns[-1].content))
            return ModelResponse(
                [
                    ToolCallPart(
                        info.output_tools[0].name,
                        {
                            "review_complete": False,
                            "summary": "The claimed fix needs verification.",
                            "limitations": ["The previous concern remains unverified."],
                            "findings": [],
                            "prior_findings": [
                                {
                                    "thread_id": "T1",
                                    "status": "uncertain",
                                    "body": "A reply reports a fix; verify the implementation.",
                                    "evidence_step_ids": [2],
                                }
                            ],
                        },
                    )
                ]
            )

        with redirect_stdout(io.StringIO()):
            report = review.review_pull_request(
                config, CheckoutSandbox(), model=FunctionModel(respond)
            )
        self.assertIn("Fixed in abc.", observed[0])
        self.assertFalse(report.review_complete)
        self.assertEqual(report.prior_findings[0].status, "uncertain")

    def test_nonancestor_incremental_baseline_falls_back_to_full_pr(self):
        prior = "a" * 40

        class Sandbox(CheckoutSandbox):
            def execute(self, command, timeout_seconds=120):
                if command[:3] == ["git", "merge-base", "--is-ancestor"]:
                    return review.CommandResult(1, "", "")
                return super().execute(command, timeout_seconds)

        config = replace(test_review.ReviewPromptTest().config(), review_base_sha=prior)
        self.assertEqual(review.select_review_base(config, Sandbox()), config.base_sha)

    def test_malformed_context_is_rejected_before_model_use(self):
        for context in [
            {"threads": [{"id": "T1"}, {"id": "T1"}]},
            {"pr": []},
            {"pr": {"body": None}},
            {"comments": {}},
            {"comments": [{"body": 123}]},
            {"threads": [{"id": "T1", "comments": ["not a comment"]}]},
        ]:
            with self.subTest(context=context), self.assertRaises(ValueError):
                review.parse_review_context(json.dumps(context))

    def test_context_pages_expose_description_threads_replies_and_middle_comment_text(self):
        context = {
            "pr": {"title": "Test", "body": "a" * 1000 + "remaining requirements"},
            "threads": [
                {
                    "id": f"T{i}",
                    "comments": [
                        {"body": "root"},
                        {"body": "🙂" * 900 + "middle of reply" + "🙂" * 900},
                    ],
                }
                for i in range(7)
            ],
            "comments": [{"body": "earlier comment"}, {"body": "latest comment"}],
        }
        tools = review.ReviewTools(CheckoutSandbox(), "base", "head", review_context=context)

        def page(**args):
            with redirect_stdout(io.StringIO()):
                rendered = tools.get_review_context(**args)
            self.assertLessEqual(len(rendered.encode()), 6000)
            return json.loads(rendered.split("\n", 2)[2])

        self.assertEqual(page()["next_index"], 5)
        self.assertEqual([t["id"] for t in page(start_index=5)["threads"]], ["T5", "T6"])
        self.assertEqual(page(section="description")["next_index"], 1000)
        self.assertEqual(
            page(section="description", start_index=1000)["body"], "remaining requirements"
        )
        self.assertEqual(
            page(section="comments", start_index=1)["comments"][0]["body"], "latest comment"
        )
        self.assertEqual(page(thread_id="T1", start_index=1)["next_body_start"], 900)
        reply = page(thread_id="T1", start_index=1, body_start=900)
        self.assertTrue(reply["comments"][0]["body"].startswith("middle of reply"))
        self.assertEqual(reply["comment_count"], 2)


if __name__ == "__main__":
    unittest.main()

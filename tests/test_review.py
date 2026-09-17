from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from pydantic import ValidationError
from pydantic_ai.messages import ModelResponse, RetryPromptPart, ToolCallPart, ToolReturnPart
from pydantic_ai.models.function import FunctionModel
from pydantic_ai.models.test import TestModel

SCRIPT = Path(__file__).parents[1] / "src" / "review.py"
sys.path.insert(0, str(SCRIPT.parent))
SPEC = importlib.util.spec_from_file_location("review", SCRIPT)
assert SPEC and SPEC.loader
review = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = review
SPEC.loader.exec_module(review)


class FakeSandbox:
    def __init__(self, result: object) -> None:
        self.result = result
        self.calls: list[tuple[list[str], int]] = []

    def execute(self, command: list[str], timeout_seconds: int = 120):
        self.calls.append((command, timeout_seconds))
        return self.result


class CheckoutSandbox(FakeSandbox):
    def __init__(self, head_sha: str = "head456") -> None:
        super().__init__(review.CommandResult(exit_code=0, stdout="", stderr=""))
        self.head_sha = head_sha

    def execute(self, command: list[str], timeout_seconds: int = 120):
        self.calls.append((command, timeout_seconds))
        if command == ["git", "rev-parse", "HEAD"]:
            return review.CommandResult(exit_code=0, stdout=self.head_sha, stderr="")
        return review.CommandResult(exit_code=0, stdout="", stderr="")


class ReviewReportTest(unittest.TestCase):
    def test_rejects_limitations_that_the_publisher_cannot_accept(self) -> None:
        for value in [" ", "bad\x00text"]:
            with self.subTest(value=value), self.assertRaises(ValidationError):
                review.ReviewDraft(
                    review_complete=False,
                    summary="検証が必要です。",
                    limitations=[value],
                    findings=[],
                )

    def test_model_output_is_concise(self) -> None:
        with self.assertRaises(ValidationError):
            review.ReviewDraft(
                review_complete=False, summary="長" * 241, limitations=[], findings=[]
            )
        with self.assertRaises(ValidationError):
            review.Assessment(
                question="変更に回帰はあるか。",
                conclusion="長" * 241,
                evidence_step_ids=[1],
                resolved=True,
            )

    def test_rejects_a_finding_outside_the_repository(self) -> None:
        with self.assertRaises(ValidationError):
            review.Finding(
                severity="high",
                title="unsafe path",
                file="../secret.txt",
                line=1,
                body="details",
            )

    def test_writes_a_valid_multiline_github_output(self) -> None:
        report = review.ReviewReport(
            reviewed_head_sha="abc123",
            review_complete=False,
            summary="first line\nsecond line",
            limitations=["not enough time"],
            investigation=[],
            verification_rationale="not enough time",
            assessments=[],
            not_run_checks=[],
            findings=[],
        )

        with tempfile.TemporaryDirectory() as directory:
            output_path = Path(directory) / "github-output"
            review.write_github_output(report, output_path)
            output = output_path.read_text(encoding="utf-8")

        first_line, payload, last_line = output.split("\n", 2)
        delimiter = first_line.removeprefix("report<<")
        self.assertEqual(last_line, f"{delimiter}\n")
        self.assertEqual(json.loads(payload), report.model_dump(mode="json"))

    def test_large_observation_logs_do_not_discard_review_conclusions(self) -> None:
        report = review.ReviewReport(
            reviewed_head_sha="abc123",
            review_complete=True,
            summary="変更内容を確認しました。",
            limitations=[],
            verification_rationale="変更箇所を検証しました。",
            not_run_checks=[],
            assessments=[
                review.Assessment(
                    question="変更した条件で正常に動くか。",
                    conclusion="境界条件を確認しました。",
                    evidence_step_ids=[1, 100],
                    resolved=True,
                )
            ],
            investigation=[
                review.InvestigationStep(
                    id=index + 1,
                    tool="read_file",
                    purpose="確認" * 200,
                    command="調査" * 1_000,
                    exit_code=0,
                    result="調" * 900,
                    code_evidence=True,
                )
                for index in range(100)
            ],
            findings=[
                review.Finding(
                    severity="low",
                    title="境界条件",
                    file="example.ts",
                    line=1,
                    body="指摘の根拠と修正案",
                    evidence_step_ids=[1, 100],
                )
            ],
        )
        with tempfile.TemporaryDirectory() as directory:
            output_path = Path(directory) / "github-output"
            review.write_github_output(report, output_path)
            payload = output_path.read_text(encoding="utf-8").split("\n")[1]
        value = json.loads(payload)
        self.assertLessEqual(len(payload.encode("utf-8")), 40_000)
        self.assertEqual(value["findings"], report.model_dump()["findings"])
        self.assertEqual(value["assessments"], report.model_dump()["assessments"])
        self.assertEqual([step["id"] for step in value["investigation"]], list(range(1, 101)))
        self.assertTrue(all(step["code_evidence"] for step in value["investigation"]))
        for step in value["investigation"]:
            self.assertTrue(all(step[field].strip() for field in ("purpose", "command", "result")))
        self.assertIn("実行ログ", value["investigation"][0]["result"])


class ReviewPromptTest(unittest.TestCase):
    def config(self) -> review.ReviewConfig:
        return review.ReviewConfig(
            repository="owner/repository",
            pull_request_number=42,
            base_sha="base123",
            head_sha="head456",
            model="gemini-test",
            api_key="secret",
            source_dir=Path("/checkout"),
            sandbox_image="node:test",
        )

    def test_identifies_the_target_and_reserves_the_tool_budget(self) -> None:
        prompt = review.build_review_prompt(self.config())

        self.assertIn("owner/repository", prompt)
        self.assertIn("PR number: 42", prompt)
        self.assertIn("Base SHA: base123", prompt)
        self.assertIn("Head SHA: head456", prompt)
        self.assertIn("Write all user-facing review text in 日本語", prompt)
        self.assertIn("at most 80 investigation tool calls", prompt)
        self.assertIn("review_complete=false", prompt)
        self.assertTrue(review.SYSTEM_INSTRUCTIONS.isascii())
        english_prompt = review.build_review_prompt(
            replace(self.config(), review_language="English")
        )
        self.assertIn("Write all user-facing review text in English", english_prompt)
        self.assertTrue(english_prompt.isascii())
        public_prompt = review.build_review_prompt(replace(self.config(), sandbox_network="public"))
        self.assertIn("Public outbound HTTP/HTTPS is available", public_prompt)
        self.assertIn("frozen lockfile", public_prompt)
        self.assertNotIn("lack of network access", public_prompt)
        self.assertIn("Outbound network access is disabled", prompt)

    def test_next_investigation_step_uses_the_previous_sandbox_output(self) -> None:
        class InvestigationSandbox(CheckoutSandbox):
            def execute(self, command: list[str], timeout_seconds: int = 120):
                if " diff " in " ".join(command):
                    return review.CommandResult(0, "changed-file: discovered.py", "")
                if command[:2] == ["sed", "-n"]:
                    return review.CommandResult(0, "reproduction: python3 reproduce.py", "")
                if command == ["sh", "-lc", "python3 reproduce.py"]:
                    return review.CommandResult(0, "base=correct; head=regression", "")
                return super().execute(command, timeout_seconds)

        turns = []

        def respond(messages, info):
            returns = [
                part
                for message in messages
                for part in message.parts
                if isinstance(part, ToolReturnPart)
            ]
            turns.append(len(returns))
            if not returns:
                return ModelResponse([ToolCallPart("get_pull_request_diff", {})])
            content = str(returns[-1].content)
            if len(returns) == 1:
                self.assertIn("changed-file: discovered.py", content)
                path = content.split("changed-file: ")[1].strip()
                return ModelResponse([ToolCallPart("read_file", {"path": path})])
            if len(returns) == 2:
                self.assertIn("reproduction: python3 reproduce.py", content)
                command = content.split("reproduction: ")[1].strip()
                return ModelResponse(
                    [
                        ToolCallPart(
                            "run_command",
                            {
                                "command": command,
                                "purpose": "ファイルから得た再現手順で回帰を検証する。",
                            },
                        )
                    ]
                )
            self.assertIn("base=correct; head=regression", content)
            return ModelResponse(
                [
                    ToolCallPart(
                        info.output_tools[0].name,
                        {
                            "review_complete": True,
                            "summary": "差分から対象を特定し、再現結果を確認しました。",
                            "limitations": [],
                            "verification_rationale": "関連実装と再現で確認しました。",
                            "assessments": [
                                {
                                    "question": "変更で回帰が起きるか。",
                                    "conclusion": "Baseで正常、Headで回帰することを再現しました。",
                                    "evidence_step_ids": [1, 2, 3],
                                    "resolved": True,
                                }
                            ],
                            "findings": [
                                {
                                    "severity": "high",
                                    "title": "再現した回帰",
                                    "file": "discovered.py",
                                    "line": 1,
                                    "body": "Baseでは正常、Headで回帰することを再現しました。",
                                    "evidence_step_ids": [1, 2, 3],
                                }
                            ],
                        },
                    )
                ]
            )

        report = review.review_pull_request(
            self.config(), InvestigationSandbox(), model=FunctionModel(respond)
        )
        self.assertEqual(turns, [0, 1, 2, 3])
        self.assertEqual(len(report.findings), 1)
        self.assertTrue(report.review_complete)

    def test_exploratory_probe_is_not_treated_as_required_verification(self) -> None:
        class ProbeSandbox(CheckoutSandbox):
            def execute(self, command: list[str], timeout_seconds: int = 120):
                if " diff " in " ".join(command):
                    return review.CommandResult(0, "@@ -1 +1 @@\n-old wording\n+new wording", "")
                if command[:2] == ["sh", "-lc"]:
                    return review.CommandResult(1, "", "optional linter is unavailable")
                return super().execute(command, timeout_seconds)

        def respond(messages, info):
            returns = [
                part
                for message in messages
                for part in message.parts
                if isinstance(part, ToolReturnPart)
            ]
            if not returns:
                return ModelResponse([ToolCallPart("get_pull_request_diff", {"path": "README.md"})])
            if len(returns) == 1:
                return ModelResponse(
                    [
                        ToolCallPart(
                            "run_command",
                            {
                                "command": "command -v optional-linter",
                                "purpose": "任意の文書リンターが利用できるか確認する。",
                            },
                        )
                    ]
                )
            self.assertIn("optional linter is unavailable", str(returns[-1].content))
            return ModelResponse(
                [
                    ToolCallPart(
                        info.output_tools[0].name,
                        {
                            "review_complete": True,
                            "summary": "文書の変更を確認しました。",
                            "limitations": [],
                            "findings": [],
                            "verification_rationale": "文言だけの変更を差分で確認しました。",
                            "assessments": [
                                {
                                    "question": "変更により文書の意味が変わっていないか。",
                                    "conclusion": "意味の変更はなく、任意ツールは不要です。",
                                    "evidence_step_ids": [1, 2],
                                    "resolved": True,
                                }
                            ],
                        },
                    )
                ]
            )

        report = review.review_pull_request(
            self.config(), ProbeSandbox(), model=FunctionModel(respond)
        )
        self.assertTrue(report.review_complete)
        self.assertEqual(report.not_run_checks, [])
        self.assertEqual(report.investigation[1].exit_code, 1)
        self.assertEqual(report.assessments[0].evidence_step_ids, [1, 2])

    def test_a_review_cannot_be_complete_without_recorded_investigation(self) -> None:
        model = TestModel(
            call_tools=[],
            custom_output_args={
                "review_complete": True,
                "summary": "問題は見つかりませんでした。",
                "limitations": [],
                "findings": [],
            },
        )
        sandbox = CheckoutSandbox()

        report = review.review_pull_request(self.config(), sandbox, model=model)

        self.assertFalse(report.review_complete)
        self.assertEqual(report.reviewed_head_sha, "head456")
        self.assertIn("調査ツール", report.limitations[0])

    def test_successful_commands_alone_do_not_complete_a_review(self) -> None:
        model = TestModel(
            call_tools=["get_pull_request_diff"],
            custom_output_args={
                "review_complete": True,
                "summary": "コマンドは成功しました。",
                "limitations": [],
                "findings": [],
            },
        )
        report = review.review_pull_request(self.config(), CheckoutSandbox(), model=model)
        self.assertTrue(report.investigation)
        self.assertTrue(all(step.exit_code == 0 for step in report.investigation))
        self.assertFalse(report.review_complete)

    def test_invalid_evidence_is_returned_to_the_model_for_correction(self) -> None:
        class PatchSandbox(CheckoutSandbox):
            def execute(self, command: list[str], timeout_seconds: int = 120):
                if " diff " in " ".join(command):
                    return review.CommandResult(0, "@@ -1 +1 @@\n-old wording\n+new wording", "")
                return super().execute(command, timeout_seconds)

        def respond(messages, info):
            returns = [
                part
                for message in messages
                for part in message.parts
                if isinstance(part, ToolReturnPart)
            ]
            if not returns:
                return ModelResponse([ToolCallPart("get_pull_request_diff", {"path": "README.md"})])
            retries = [
                part
                for message in messages
                for part in message.parts
                if isinstance(part, RetryPromptPart)
            ]
            if retries:
                self.assertIn("observed step_ids", str(retries[-1].content))
            return ModelResponse(
                [
                    ToolCallPart(
                        info.output_tools[0].name,
                        {
                            "review_complete": True,
                            "summary": "変更内容を確認しました。",
                            "limitations": [],
                            "findings": [],
                            "verification_rationale": "文書の差分で判断できます。",
                            "assessments": [
                                {
                                    "question": "文書の意味が変わるか。",
                                    "conclusion": "表記のみの変更です。",
                                    "evidence_step_ids": [1] if retries else [2],
                                    "resolved": True,
                                }
                            ],
                        },
                    )
                ]
            )

        report = review.review_pull_request(
            self.config(), PatchSandbox(), model=FunctionModel(respond)
        )
        self.assertTrue(report.review_complete)
        self.assertEqual(report.assessments[0].evidence_step_ids, [1])

    def test_budget_exhaustion_preserves_observations_without_approval(self) -> None:
        def respond(messages, info):
            returns = [
                part
                for message in messages
                for part in message.parts
                if isinstance(part, ToolReturnPart)
            ]
            return ModelResponse(
                [
                    ToolCallPart(
                        "read_file" if returns else "get_pull_request_diff",
                        {"path": "README.md"} if returns else {},
                    )
                ]
            )

        report = review.review_pull_request(
            replace(self.config(), tool_call_limit=1, investigation_tool_limit=1),
            CheckoutSandbox(),
            model=FunctionModel(respond),
        )
        self.assertFalse(report.review_complete)
        self.assertEqual(len(report.investigation), 1)
        self.assertTrue(report.limitations)
        self.assertEqual(report.assessments, [])

    def test_inconsistent_completion_is_returned_to_the_model(self) -> None:
        def respond(messages, info):
            returns = [
                part
                for message in messages
                for part in message.parts
                if isinstance(part, ToolReturnPart)
            ]
            if not returns:
                return ModelResponse([ToolCallPart("get_pull_request_diff", {})])
            retries = [
                part
                for message in messages
                for part in message.parts
                if isinstance(part, RetryPromptPart)
            ]
            if retries:
                self.assertIn("review_complete=false", str(retries[-1].content))
            return ModelResponse(
                [
                    ToolCallPart(
                        info.output_tools[0].name,
                        {
                            "review_complete": not bool(retries),
                            "summary": "ビルドが未検証です。",
                            "limitations": [],
                            "findings": [],
                            "not_run_checks": [
                                {
                                    "command": "pnpm build",
                                    "result": "依存関係の取得に失敗しました。",
                                }
                            ],
                            "verification_rationale": "差分を確認しました。",
                            "assessments": [
                                {
                                    "question": "ビルドできるか。",
                                    "conclusion": "未検証です。",
                                    "evidence_step_ids": [1],
                                    "resolved": False,
                                }
                            ],
                        },
                    )
                ]
            )

        report = review.review_pull_request(
            self.config(), CheckoutSandbox(), model=FunctionModel(respond)
        )
        self.assertFalse(report.review_complete)

    def test_rejects_a_checkout_at_a_different_head(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "does not match head-sha"):
            review.review_pull_request(
                self.config(),
                CheckoutSandbox(head_sha="different"),
                model=TestModel(call_tools=[]),
            )

    def test_preserves_required_checks_that_were_not_run(self) -> None:
        model = TestModel(
            call_tools=[],
            custom_output_args={
                "review_complete": False,
                "summary": "依存関係がないため検証できませんでした。",
                "limitations": ["依存関係がありません。"],
                "not_run_checks": [
                    {"command": "pnpm test", "result": "node_modulesがありません。"}
                ],
                "findings": [],
            },
        )

        report = review.review_pull_request(self.config(), CheckoutSandbox(), model=model)

        self.assertFalse(report.review_complete)
        self.assertEqual(report.not_run_checks[-1].command, "pnpm test")


class ReviewConfigTest(unittest.TestCase):
    def test_rejects_unrestricted_network_modes(self) -> None:
        for network in ["host", "bridge", "", "invalid"]:
            with self.assertRaisesRegex(ValueError, "network must be none or public"):
                review.DockerSandbox(Path("."), "node:test", network=network)

    def test_rejects_limits_above_the_action_ceiling(self) -> None:
        environment = {
            "REVIEW_REPOSITORY": "owner/repository",
            "REVIEW_PULL_REQUEST_NUMBER": "42",
            "REVIEW_BASE_SHA": "base123",
            "REVIEW_HEAD_SHA": "head456",
            "REVIEW_MODEL": "gemini-test",
            "GEMINI_API_KEY": "secret",
            "REVIEW_SOURCE_DIRECTORY": "/checkout",
            "REVIEW_SANDBOX_IMAGE": "node:test",
            "REVIEW_LANGUAGE": "日本語",
            "REVIEW_REQUEST_LIMIT": "241",
            "REVIEW_TOOL_CALL_LIMIT": "30",
            "REVIEW_INVESTIGATION_TOOL_LIMIT": "24",
        }

        with patch.dict(os.environ, environment, clear=True):
            with self.assertRaisesRegex(ValueError, "between 2 and 240"):
                review.ReviewConfig.from_env()


class ReviewToolsTest(unittest.TestCase):
    def test_diff_tool_uses_the_configured_commits_and_records_the_observation(self) -> None:
        sandbox = FakeSandbox(review.CommandResult(exit_code=0, stdout="diff output", stderr=""))
        tools = review.ReviewTools(sandbox, base_sha="base123", head_sha="head456")

        result = tools.get_pull_request_diff()

        command, timeout = sandbox.calls[0]
        self.assertEqual(command[:2], ["sh", "-lc"])
        self.assertEqual(timeout, 120)
        self.assertIn(
            "git --literal-pathspecs --no-pager diff --no-ext-diff --no-textconv "
            "--numstat base123...head456",
            command[2],
        )
        self.assertIn("sed -n 1,200p", command[2])
        self.assertIn("[total inventory lines]", command[2])
        self.assertEqual(result, "[step_id=1]\n[exit_code=0]\ndiff output")
        self.assertEqual(tools.steps[0].exit_code, 0)
        self.assertIn("base123...head456", tools.steps[0].command)

    def test_file_tools_reject_paths_outside_the_workspace(self) -> None:
        sandbox = FakeSandbox(review.CommandResult(exit_code=0, stdout="unexpected", stderr=""))
        tools = review.ReviewTools(sandbox, base_sha="base123", head_sha="head456")

        with self.assertRaises(ValueError):
            tools.read_file("../secret.txt")

        self.assertEqual(sandbox.calls, [])


@unittest.skipUnless(os.environ.get("RUN_DOCKER_TESTS") == "1", "Docker test disabled")
class DockerSandboxTest(unittest.TestCase):
    def test_copies_the_repository_without_exposing_secrets_or_host_writes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory)
            (source / "marker.txt").write_text("from checkout", encoding="utf-8")
            os.environ["GEMINI_API_KEY"] = "must-not-enter-sandbox"

            with review.DockerSandbox(
                source,
                image=(
                    "alpine:3.22@sha256:"
                    "14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce"
                ),
            ) as sandbox:
                result = sandbox.execute(
                    [
                        "sh",
                        "-lc",
                        'cat marker.txt && test -z "${GEMINI_API_KEY:-}" && touch generated.txt',
                    ]
                )

            self.assertEqual(result.exit_code, 0, result.stderr)
            self.assertIn("from checkout", result.stdout)
            self.assertFalse((source / "generated.txt").exists())


if __name__ == "__main__":
    unittest.main()

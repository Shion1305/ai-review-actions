from __future__ import annotations

import io
import json
import sys
import unittest
from contextlib import redirect_stdout
from dataclasses import replace
from pathlib import Path

import httpx2
from google.genai.types import HttpRetryOptions
from pydantic import ValidationError
from pydantic_ai import Agent, UsageLimits
from pydantic_ai.capabilities import ProcessHistory
from pydantic_ai.exceptions import ModelHTTPError, UsageLimitExceeded
from pydantic_ai.messages import (
    InstructionPart,
    ModelMessage,
    ModelMessagesTypeAdapter,
    ModelRequest,
    ModelResponse,
    TextPart,
    ThinkingPart,
    ToolCallPart,
    ToolReturnPart,
    UserPromptPart,
)
from pydantic_ai.models import ModelRequestParameters
from pydantic_ai.models.function import FunctionModel
from pydantic_ai.models.google import GoogleModel, GoogleModelSettings
from pydantic_ai.models.wrapper import WrapperModel
from pydantic_ai.providers.google import GoogleProvider
from pydantic_ai.settings import ModelSettings
from pydantic_ai.tools import ToolDefinition
from pydantic_ai.usage import RequestUsage

sys.path.insert(0, str(Path(__file__).parents[1] / "src"))
from model_io import (  # noqa: E402
    BoundedReviewModel,
    ReviewGoogleJsonSchemaTransformer,
    compact_history,
    request_input_bytes,
)


class FakeClock:
    def __init__(self) -> None:
        self.time = 0.0
        self.sleeps: list[float] = []

    def now(self) -> float:
        return self.time

    async def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.time += seconds


class HistoryTest(unittest.TestCase):
    def test_duplicate_instructions_keep_latest_distinct_policy_without_mutating_history(self):
        messages: list[ModelMessage] = [
            ModelRequest(parts=[UserPromptPart("Review")], instructions="policy A"),
            ModelResponse(parts=[TextPart("First")]),
            ModelRequest(parts=[UserPromptPart("Continue")], instructions="policy B"),
            ModelResponse(parts=[TextPart("Second")]),
            ModelRequest(parts=[UserPromptPart("Continue")], instructions="policy A"),
        ]
        original = ModelMessagesTypeAdapter.dump_json(messages)
        compacted = compact_history(messages)
        requests = [m for m in compacted if isinstance(m, ModelRequest)]
        self.assertIsNone(requests[0].instructions)
        self.assertEqual(requests[1].instructions, "policy B")
        self.assertEqual(requests[2].instructions, "policy A")
        self.assertEqual(ModelMessagesTypeAdapter.dump_json(messages), original)
        self.assertEqual(compact_history([messages[0]]), [messages[0]])

    def test_related_pages_remain_complete_while_history_fits_budget(self) -> None:
        messages: list[ModelMessage] = [ModelRequest(parts=[UserPromptPart("Review")])]
        for index in range(8):
            messages.extend(
                [
                    ModelResponse(
                        parts=[
                            ToolCallPart("read_file", {"start_line": index * 30 + 1}, str(index))
                        ]
                    ),
                    ModelRequest(
                        parts=[
                            ToolReturnPart(
                                "read_file",
                                f"[step_id={index + 1}]\n" + "related source line\n" * 100,
                                str(index),
                            )
                        ]
                    ),
                ]
            )
        self.assertLess(len(ModelMessagesTypeAdapter.dump_json(messages)), 64000)
        self.assertEqual(compact_history(messages), messages)

    def test_smaller_history_budget_evicts_whole_cycles_without_shortening_retained_pages(self):
        messages: list[ModelMessage] = [ModelRequest(parts=[UserPromptPart("Review")])]
        for index in range(10):
            messages.extend(
                [
                    ModelResponse(parts=[ToolCallPart("read_file", {}, str(index))]),
                    ModelRequest(
                        parts=[
                            ToolReturnPart(
                                "read_file", f"[step_id={index + 1}] " + "x" * 2000, str(index)
                            )
                        ]
                    ),
                ]
            )
        compacted = compact_history(messages, message_budget_bytes=12000)
        self.assertLessEqual(len(ModelMessagesTypeAdapter.dump_json(compacted)), 12000)
        retained = [m for m in compacted if isinstance(m, ModelResponse)]
        self.assertGreater(len(retained), 1)
        self.assertLess(len(retained), 10)
        for message in compacted:
            for part in message.parts:
                if isinstance(part, ToolReturnPart):
                    original = messages[2 + int(part.tool_call_id) * 2]
                    self.assertEqual(part, original.parts[0])

    def test_working_notes_are_byte_bounded_user_context(self) -> None:
        initial = ModelRequest(parts=[UserPromptPart("Review")], instructions="fixed policy")
        compacted = compact_history([initial], review_notes="仮説" * 10_000)
        self.assertEqual(compacted[0], initial)
        self.assertEqual(len(compacted), 2)
        note_message = compacted[1]
        self.assertTrue(note_message.metadata and note_message.metadata.get("review_working_notes"))
        self.assertIsInstance(note_message, ModelRequest)
        assert isinstance(note_message, ModelRequest)
        self.assertIsNone(note_message.instructions)
        assert isinstance(note_message.parts[0], UserPromptPart)
        content = note_message.parts[0].content
        assert isinstance(content, str)
        self.assertLessEqual(len(content.encode("utf-8")), 6000)
        self.assertIn("model-authored", content)
        self.assertIn("not evidence", content)
        self.assertIn("untrusted", content)
        self.assertEqual(compact_history(compacted, review_notes=""), [initial])

    def test_pending_tool_call_is_retained_until_its_later_return(self) -> None:
        messages: list[ModelMessage] = [
            ModelRequest(parts=[UserPromptPart("Review")]),
            ModelResponse(parts=[ToolCallPart("delayed_source", {}, "pending")]),
            ModelRequest(parts=[UserPromptPart("The delayed result is pending.")]),
        ]
        for index in range(5):
            messages.extend(
                [
                    ModelResponse(parts=[ToolCallPart("read_file", {}, str(index))]),
                    ModelRequest(
                        parts=[
                            ToolReturnPart("read_file", f"[step_id={index + 1}] source", str(index))
                        ]
                    ),
                ]
            )
        compacted = compact_history(messages, message_budget_bytes=1000)
        calls = [p.tool_call_id for m in compacted for p in m.parts if isinstance(p, ToolCallPart)]
        self.assertIn("pending", calls)
        messages.append(ModelRequest(parts=[ToolReturnPart("delayed_source", "source", "pending")]))
        compacted = compact_history(messages, message_budget_bytes=1000)
        calls = [p.tool_call_id for m in compacted for p in m.parts if isinstance(p, ToolCallPart)]
        self.assertIn("pending", calls)

    def test_recalled_observation_is_not_archived_as_a_new_step(self) -> None:
        messages: list[ModelMessage] = [ModelRequest(parts=[UserPromptPart("Review")])]
        for index in range(6):
            tool_name = "read_observation" if index == 1 else "read_file"
            messages.extend(
                [
                    ModelResponse(parts=[ToolCallPart(tool_name, {}, str(index))]),
                    ModelRequest(
                        parts=[ToolReturnPart(tool_name, "[step_id=1] source", str(index))]
                    ),
                ]
            )
        compacted = compact_history(messages, message_budget_bytes=2000)
        index_message = compacted[1]
        assert isinstance(index_message.parts[0], UserPromptPart)
        assert isinstance(index_message.parts[0].content, str)
        index = json.loads(index_message.parts[0].content.split("\n", 1)[1])
        self.assertEqual(index["archived_count"], 1)
        self.assertEqual([entry["tool"] for entry in index["observations"]], ["read_file"])

    def test_compaction_bounds_utf8_without_mutating_or_breaking_pairs(self) -> None:
        initial = ModelRequest(
            parts=[UserPromptPart("Review this change")], instructions="fixed policy"
        )
        messages: list[ModelMessage] = [initial]
        for index in range(5):
            messages.extend(
                [
                    ModelResponse(
                        parts=[
                            ThinkingPart("reasoning", signature=f"signature-{index}"),
                            ToolCallPart("read_file", {"path": "src/app.py"}, str(index)),
                        ]
                    ),
                    ModelRequest(
                        parts=[
                            ToolReturnPart(
                                "read_file",
                                f"[step_id={index + 1}]\nOLD_OUTPUT_{index}\n" + "変更" * 20000,
                                str(index),
                            )
                        ]
                    ),
                ]
            )
        original = ModelMessagesTypeAdapter.dump_json(messages)
        compacted = compact_history(messages, message_budget_bytes=30000)
        self.assertEqual(ModelMessagesTypeAdapter.dump_json(messages), original)
        self.assertEqual(compacted[0], initial)
        self.assertEqual(len(compacted), 10)
        index_message = compacted[1]
        self.assertIsInstance(index_message, ModelRequest)
        self.assertTrue(all(isinstance(p, UserPromptPart) for p in index_message.parts))
        index_json = ModelMessagesTypeAdapter.dump_json([index_message])
        self.assertIn(b"read_observation", index_json)
        self.assertNotIn(b"OLD_OUTPUT_0", index_json)
        self.assertNotIn(b"signature-0", index_json)
        for index in range(1, 5):
            response, request = compacted[index * 2 : index * 2 + 2]
            self.assertEqual(response.parts, messages[index * 2 + 1].parts)
            result = request.parts[0]
            assert isinstance(result, ToolReturnPart)
            assert isinstance(result.content, str)
            self.assertEqual(result.tool_call_id, str(index))
            self.assertIn(f"[step_id={index + 1}]", result.content)
            self.assertLessEqual(len(result.content.encode("utf-8")), 6000)
            self.assertGreater(len(result.content.encode("utf-8")), 5900)
        self.assertEqual(compact_history(compacted, message_budget_bytes=30000), compacted)


class ModelIOTest(unittest.IsolatedAsyncioTestCase):
    def model(self, function, clock=None, **kwargs):
        clock = clock or FakeClock()
        return BoundedReviewModel(FunctionModel(function), sleep=clock.sleep, **kwargs)

    async def test_instruction_deduplication_does_not_change_google_wire_request(self):
        wire_requests = []

        def handler(request):
            wire_requests.append(json.loads(request.content))
            return httpx2.Response(
                200,
                json={
                    "candidates": [
                        {
                            "content": {"role": "model", "parts": [{"text": "done"}]},
                            "finishReason": "STOP",
                        }
                    ]
                },
            )

        messages: list[ModelMessage] = [
            ModelRequest(parts=[UserPromptPart("Review")], instructions="fixed policy"),
            ModelResponse(parts=[ToolCallPart("read_file", {"path": "app.py"}, "call-1")]),
            ModelRequest(
                parts=[ToolReturnPart("read_file", "[step_id=1] source", "call-1")],
                instructions="fixed policy",
            ),
        ]
        async with httpx2.AsyncClient(transport=httpx2.MockTransport(handler)) as client:
            model = GoogleModel(
                "gemini-3.8-flash",
                provider=GoogleProvider(api_key="test-only-key", http_client=client),
            )
            # Normal Agent requests supply instruction_parts; direct model calls
            # can instead use the SDK's fallback to the latest request instructions.
            for instructions in ([InstructionPart("fixed policy")], None):
                parameters = ModelRequestParameters(instruction_parts=instructions)
                await model.request(messages, None, parameters)
                await model.request(compact_history(messages), None, parameters)
                self.assertEqual(wire_requests[-2], wire_requests[-1])
                self.assertEqual(
                    wire_requests[-1]["systemInstruction"]["parts"], [{"text": "fixed policy"}]
                )

    def test_real_review_prompt_retains_more_pages_without_repeated_instruction_bookkeeping(self):
        import test_review

        review = test_review.review
        metrics = []

        class SourceSandbox(test_review.CheckoutSandbox):
            def execute(self, command, timeout_seconds=120):
                if command[:2] == ["sed", "-n"]:
                    self.calls.append((command, timeout_seconds))
                    return review.CommandResult(0, "def checked(value): return value\n" * 125, "")
                return super().execute(command, timeout_seconds)

        class Capture(WrapperModel):
            async def request(self, messages, model_settings, model_request_parameters):
                metrics.append(
                    {
                        "history_bytes": len(ModelMessagesTypeAdapter.dump_json(messages)),
                        "full_bytes": request_input_bytes(
                            messages, model_settings, model_request_parameters
                        ),
                        "cycles": sum(isinstance(m, ModelResponse) for m in messages),
                        "instructions": [
                            m.instructions
                            for m in messages
                            if isinstance(m, ModelRequest) and m.instructions is not None
                        ],
                    }
                )
                return await self.wrapped.request(
                    messages, model_settings, model_request_parameters
                )

        def respond(_messages, info):
            turn = len(metrics)
            if turn <= 12:
                return ModelResponse(
                    [
                        ToolCallPart(
                            "read_file",
                            {
                                "path": "source.py",
                                "start_line": 1 + (turn - 1) * 125,
                                "end_line": turn * 125,
                            },
                        )
                    ]
                )
            return ModelResponse(
                [
                    ToolCallPart(
                        info.output_tools[0].name,
                        {
                            "review_complete": False,
                            "summary": "Diagnostic complete.",
                            "limitations": ["Synthetic diagnostic does not complete a review."],
                            "findings": [],
                        },
                    )
                ]
            )

        config = replace(
            test_review.ReviewPromptTest().config(),
            review_context={
                "description": "Synthetic requirements.",
                "threads": [],
                "comments": [],
            },
        )
        with redirect_stdout(io.StringIO()):
            result = review.review_pull_request(
                config, SourceSandbox(), model=Capture(FunctionModel(respond))
            )
        self.assertEqual(len(result.investigation), 12)
        self.assertEqual(len(metrics), 13)
        self.assertGreaterEqual(metrics[-1]["cycles"], 8)
        for request in metrics:
            self.assertLessEqual(request["history_bytes"], 64000)
            self.assertLessEqual(request["full_bytes"], 96000)
            self.assertEqual(request["instructions"], [review.SYSTEM_INSTRUCTIONS.strip()])

    async def test_google_wire_schema_simplifies_array_bounds_without_relaxing_local_limits(self):
        from review import ReviewDraft

        requests = []
        output = {
            "review_complete": False,
            "summary": "Inspection is incomplete.",
            "limitations": ["No source inspected."],
            "findings": [],
        }

        def handler(request):
            requests.append(json.loads(request.content))
            return httpx2.Response(
                200,
                json={
                    "candidates": [
                        {
                            "content": {
                                "role": "model",
                                "parts": [
                                    {"functionCall": {"name": "final_result", "args": output}}
                                ],
                            },
                            "finishReason": "STOP",
                        }
                    ],
                    "usageMetadata": {
                        "promptTokenCount": 10,
                        "candidatesTokenCount": 8,
                        "totalTokenCount": 18,
                    },
                },
            )

        async with httpx2.AsyncClient(transport=httpx2.MockTransport(handler)) as client:
            model = GoogleModel(
                "gemini-3.8-flash",
                provider=GoogleProvider(
                    api_key="test-only-key",
                    http_client=client,
                    retry_options=HttpRetryOptions(attempts=1),
                ),
                profile={"json_schema_transformer": ReviewGoogleJsonSchemaTransformer},
            )
            self.assertTrue(model.profile.get("google_supports_tool_combination"))
            self.assertTrue(model.profile.get("google_supports_thinking_level"))
            agent = Agent(
                BoundedReviewModel(model),
                output_type=ReviewDraft,
                model_settings=GoogleModelSettings(temperature=0.1, max_tokens=8192),
            )
            result = await agent.run("Return an incomplete review without inventing evidence.")
        self.assertEqual(result.output.summary, output["summary"])
        self.assertEqual(len(requests), 1)
        definitions = [d for tool in requests[0]["tools"] for d in tool["functionDeclarations"]]
        schema = next(
            d["parameters_json_schema"] for d in definitions if d["name"] == "final_result"
        )

        def keys(value):
            if isinstance(value, dict):
                return set(value) | set().union(*(keys(v) for v in value.values()))
            if isinstance(value, list):
                return set().union(*(keys(v) for v in value))
            return set()

        self.assertNotIn("maxItems", keys(schema))
        self.assertIn("minItems", keys(schema))
        self.assertIn("required", keys(schema))
        self.assertIn("enum", keys(schema))
        self.assertEqual(requests[0]["generationConfig"]["maxOutputTokens"], 8192)
        self.assertEqual(requests[0]["toolConfig"]["functionCallingConfig"]["mode"], "ANY")
        invalid = {
            **output,
            "assessments": [
                {
                    "question": "Check the change",
                    "conclusion": "Pending",
                    "resolved": False,
                    "evidence_step_ids": [1] * 101,
                }
            ],
        }
        with self.assertRaises(ValidationError) as caught:
            ReviewDraft.model_validate(invalid)
        self.assertEqual(caught.exception.errors()[0]["type"], "too_long")

    async def test_real_agent_compacts_repeated_large_results(self) -> None:
        request_sizes = []
        tool_runs = []

        def respond(messages, _info):
            request_sizes.append(len(ModelMessagesTypeAdapter.dump_json(messages)))
            if len(request_sizes) <= 8:
                return ModelResponse(parts=[ToolCallPart("inspect_source", {})])
            return ModelResponse(parts=[TextPart("Finished")])

        agent = Agent(self.model(respond), capabilities=[ProcessHistory(compact_history)])

        @agent.tool_plain
        def inspect_source() -> str:
            tool_runs.append(1)
            return f"[step_id={len(tool_runs)}]\n" + "build artifact source " * 5000

        result = await agent.run("Review the change")
        self.assertEqual(result.output, "Finished")
        self.assertEqual(len(tool_runs), 8)
        self.assertLessEqual(max(request_sizes), 64000)

    async def test_updated_working_notes_replace_previous_notes_across_forty_turns(self) -> None:
        working_notes = [""]
        tool_runs = []
        request_sizes = []

        def process(messages):
            return compact_history(messages, review_notes=working_notes[0])

        def respond(messages, _info):
            request_sizes.append(len(ModelMessagesTypeAdapter.dump_json(messages)))
            self.assertLessEqual(request_sizes[-1], 64000)
            notes = [
                p.content
                for m in messages
                for p in m.parts
                if isinstance(p, UserPromptPart)
                and isinstance(p.content, str)
                and p.content.startswith("Review working notes")
            ]
            self.assertEqual(len(notes), int(bool(tool_runs)))
            if notes:
                self.assertIn(working_notes[0], notes[0])
                if len(tool_runs) > 1:
                    self.assertNotIn(f"working-summary-{len(tool_runs) - 1};", notes[0])
            if len(tool_runs) < 40:
                return ModelResponse(parts=[ToolCallPart("inspect_source", {})])
            return ModelResponse(parts=[TextPart("Finished")])

        agent = Agent(self.model(respond), capabilities=[ProcessHistory(process)])

        @agent.tool_plain
        def inspect_source() -> str:
            tool_runs.append(1)
            working_notes[0] = f"working-summary-{len(tool_runs)}; check the remaining caller."
            return f"[step_id={len(tool_runs)}]\n" + "raw source " * 10_000

        result = await agent.run("Review", usage_limits=UsageLimits(request_limit=45))
        self.assertEqual(result.output, "Finished")
        self.assertEqual(len(tool_runs), 40)
        self.assertLessEqual(max(request_sizes), 64000)

    async def test_long_investigation_keeps_bounded_recent_cycles_and_archived_index(self) -> None:
        request_sizes = []
        tool_runs = []
        requests = []

        def respond(messages, _info):
            requests.append(messages)
            request_sizes.append(len(ModelMessagesTypeAdapter.dump_json(messages)))
            responses = [m for m in messages if isinstance(m, ModelResponse)]
            self.assertLessEqual(request_sizes[-1], 64000)
            calls = {
                p.tool_call_id for m in responses for p in m.parts if isinstance(p, ToolCallPart)
            }
            for message in messages:
                for part in message.parts:
                    if isinstance(part, ToolReturnPart):
                        self.assertIn(part.tool_call_id, calls)
            if len(requests) <= 100:
                return ModelResponse(
                    parts=[
                        TextPart("planning " * 500),
                        ThinkingPart("reasoning", signature=f"signature-{len(requests)}"),
                        ToolCallPart("inspect_source", {"path": "src/app.py"}),
                    ]
                )
            return ModelResponse(parts=[TextPart("Finished")])

        agent = Agent(
            self.model(respond),
            instructions="policy " * 300,
            capabilities=[ProcessHistory(compact_history)],
        )

        @agent.tool_plain
        def inspect_source(path: str) -> str:
            tool_runs.append(path)
            return f"[step_id={len(tool_runs)}]\n" + "discarded raw observation " * 5000

        result = await agent.run(
            "Review the change", usage_limits=UsageLimits(request_limit=120, tool_calls_limit=100)
        )
        self.assertEqual(result.output, "Finished")
        self.assertEqual(len(tool_runs), 100)
        self.assertLessEqual(max(request_sizes), 64000)
        self.assertLess(abs(request_sizes[-1] - request_sizes[-20]), 1000)
        final_messages = requests[-1]
        indexes = [
            p.content
            for m in final_messages
            for p in m.parts
            if isinstance(p, UserPromptPart)
            and isinstance(p.content, str)
            and p.content.startswith("Archived observation index")
        ]
        self.assertEqual(len(indexes), 1)
        index = indexes[0]
        self.assertLessEqual(len(index.encode()), 6000)
        retained_count = sum(isinstance(m, ModelResponse) for m in final_messages)
        self.assertIn(f'"archived_count":{100 - retained_count}', index)
        self.assertIn(f'"last_step_id":{100 - retained_count}', index)
        self.assertNotIn("discarded raw observation", index)
        self.assertGreater(json.loads(index.split("\n", 1)[1])["omitted_index_entries"], 0)

    async def test_429_retries_identical_request_without_reexecuting_tools(self) -> None:
        clock = FakeClock()
        calls = []
        tool_runs = []

        def respond(messages, _info):
            calls.append(ModelMessagesTypeAdapter.dump_json(messages))
            if len(calls) == 1:
                return ModelResponse(parts=[ToolCallPart("inspect_source", {})])
            if len(calls) == 2:
                raise ModelHTTPError(
                    429,
                    "fake",
                    {
                        "error": {
                            "details": [
                                {
                                    "@type": "type.googleapis.com/google.rpc.RetryInfo",
                                    "retryDelay": "12.5s",
                                }
                            ]
                        }
                    },
                )
            return ModelResponse(parts=[TextPart("Finished")])

        agent = Agent(self.model(respond, clock))

        @agent.tool_plain
        def inspect_source() -> str:
            tool_runs.append(1)
            return "source"

        result = await agent.run("Review")
        self.assertEqual(result.output, "Finished")
        self.assertEqual(tool_runs, [1])
        self.assertEqual(calls[1], calls[2])
        self.assertEqual(clock.sleeps, [12.5])

    async def test_successful_sequential_requests_have_no_artificial_wait(self):
        clock = FakeClock()
        calls = []

        def respond(_messages, _info):
            calls.append(clock.now())
            return ModelResponse(parts=[TextPart("done")])

        model = self.model(respond, clock)
        messages: list[ModelMessage] = [ModelRequest(parts=[UserPromptPart("source " * 8000)])]
        for _ in range(12):
            await model.request(messages, None, ModelRequestParameters())
        self.assertEqual(len(calls), 12)
        self.assertEqual(clock.sleeps, [])
        self.assertEqual(calls, [0.0] * 12)

    async def test_oversized_schema_or_instructions_rejected_before_network(self) -> None:
        calls = []

        def respond(messages, _info):
            calls.append(messages)
            return ModelResponse(parts=[TextPart("unexpected")])

        model = self.model(respond, max_input_bytes=1000)
        messages: list[ModelMessage] = [ModelRequest(parts=[UserPromptPart("hello")])]
        for parameters in [
            ModelRequestParameters(
                function_tools=[ToolDefinition(name="large", description="x" * 2000)]
            ),
            ModelRequestParameters(),
        ]:
            with self.subTest(parameters=parameters), self.assertRaises(UsageLimitExceeded):
                request_messages = (
                    messages
                    if parameters.function_tools
                    else [ModelRequest(parts=[UserPromptPart("hello")], instructions="x" * 2000)]
                )
                await model.request(request_messages, None, parameters)
        self.assertEqual(calls, [])

    async def test_retry_after_is_honored_without_other_waits(self) -> None:
        clock = FakeClock()
        calls = []
        messages: list[ModelMessage] = [ModelRequest(parts=[UserPromptPart("hello")])]
        parameters = ModelRequestParameters()
        size = request_input_bytes(messages, None, parameters)

        def respond(_messages, _info):
            calls.append(clock.now())
            if len(calls) == 1:
                raise ModelHTTPError(429, "fake", headers={"Retry-After": "7"})
            return ModelResponse(parts=[TextPart("done")])

        model = self.model(respond, clock, max_input_bytes=size)
        with self.assertLogs("model_io", level="INFO") as logs:
            await model.request(messages, None, parameters)
        self.assertEqual(calls, [0.0, 7.0])
        self.assertEqual(clock.sleeps, [7.0])
        self.assertIn("Model retry delay_seconds=7.000", "\n".join(logs.output))

    async def test_settings_output_schema_and_instruction_parts_count_toward_budget(self) -> None:
        calls = []

        def respond(messages, _info):
            calls.append(messages)
            return ModelResponse(parts=[TextPart("unexpected")])

        cases: list[tuple[ModelSettings | None, ModelRequestParameters]] = [
            ({"extra_body": {"system": "x" * 2000}}, ModelRequestParameters()),
            (None, ModelRequestParameters(instruction_parts=[InstructionPart("x" * 2000)])),
            (
                None,
                ModelRequestParameters(
                    output_tools=[ToolDefinition(name="report", description="x" * 2000)]
                ),
            ),
        ]
        model = self.model(respond, max_input_bytes=1000)
        for settings, parameters in cases:
            with self.subTest(parameters=parameters), self.assertRaises(UsageLimitExceeded):
                await model.request(
                    [ModelRequest(parts=[UserPromptPart("hi")])], settings, parameters
                )
        self.assertEqual(calls, [])

    async def test_usage_logs_report_bytes_and_actual_tokens_without_request_content(self) -> None:
        def respond(_messages, _info):
            return ModelResponse(
                parts=[TextPart("done")],
                usage=RequestUsage(input_tokens=11, output_tokens=4, cache_read_tokens=7),
            )

        with self.assertLogs("model_io", level="INFO") as logs:
            await Agent(self.model(respond)).run("private-source-should-never-appear-in-logs")
        output = "\n".join(logs.output)
        self.assertIn("serialized_input_bytes=", output)
        self.assertIn("input_tokens=11 output_tokens=4 cache_read_tokens=7", output)
        self.assertNotIn("private-source", output)

    async def test_response_tool_names_are_logged_without_arguments_or_reasoning(self):
        def respond(_messages, _info):
            return ModelResponse(
                parts=[
                    TextPart("private-prose"),
                    ThinkingPart("private-reasoning", signature="private-signature"),
                    ToolCallPart("read_observation", {"content": "private-argument"}),
                    ToolCallPart("save_review_notes", {"summary": "private-notes"}),
                    ToolCallPart("escaped\nname", {}),
                ]
            )

        model = self.model(respond)
        with self.assertLogs("model_io", level="INFO") as logs:
            for _ in range(2):
                await model.request(
                    [ModelRequest(parts=[UserPromptPart("private-prompt")])],
                    None,
                    ModelRequestParameters(),
                )
        output = "\n".join(logs.output)
        self.assertIn(
            'tool_names=["read_observation", "save_review_notes", "escaped\\nname"]', output
        )
        self.assertNotIn("private-", output)

    async def test_exhausted_429_becomes_safe_usage_limit(self) -> None:
        calls = []

        def respond(_messages, _info):
            calls.append(1)
            raise ModelHTTPError(429, "fake", {"secret": "do-not-leak"})

        with self.assertRaises(UsageLimitExceeded) as caught:
            await Agent(self.model(respond)).run("Review")
        self.assertEqual(len(calls), 3)
        self.assertNotIn("do-not-leak", str(caught.exception))

    async def test_long_retry_after_stops_without_ignoring_provider_delay(self) -> None:
        clock = FakeClock()
        calls = []

        def respond(_messages, _info):
            calls.append(1)
            raise ModelHTTPError(429, "fake", headers={"Retry-After": "600"})

        with self.assertRaises(UsageLimitExceeded):
            await Agent(self.model(respond, clock)).run("Review")
        self.assertEqual(calls, [1])
        self.assertEqual(clock.sleeps, [])

    async def test_retry_waits_share_one_bounded_total(self):
        clock = FakeClock()
        calls = []

        def respond(_messages, _info):
            calls.append(1)
            raise ModelHTTPError(429, "fake", headers={"Retry-After": "100"})

        with self.assertRaises(UsageLimitExceeded):
            await Agent(self.model(respond, clock)).run("Review")
        self.assertEqual(calls, [1, 1])
        self.assertEqual(clock.sleeps, [100.0])

    async def test_only_transient_provider_failures_are_retried(self) -> None:
        for status in [400, 401, 403, 404, 500, 502, 503]:
            calls = []

            def respond(_messages, _info):
                calls.append(1)
                raise ModelHTTPError(status, "fake")

            with self.subTest(status=status), self.assertRaises(ModelHTTPError):
                await Agent(self.model(respond)).run("Review")
            self.assertEqual(len(calls), 3 if status in {502, 503} else 1)


if __name__ == "__main__":
    unittest.main()

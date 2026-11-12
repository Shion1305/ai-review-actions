# Model and Provider Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add opt-in, ordered Google/OpenAI model fallback while preserving the existing Gemini-only action interface.

**Architecture:** Parse provider-qualified fallback identifiers into immutable configuration, construct one bounded Pydantic AI model per entry, and compose them with Pydantic AI's `FallbackModel` using a narrow transient-error predicate. Provider exhaustion is surfaced as an action failure with a sanitized GitHub Actions Summary; valid review reports retain their existing semantics.

**Tech Stack:** Python 3.11+, Pydantic AI 2.43, GitHub composite actions, unittest, Node test runner, uv, Ruff, ty.

**Spec:** `docs/superpowers/specs/2026-11-13-model-provider-fallback-design.md`

## Global Constraints

- Existing `model` and `gemini-api-key` inputs remain backward compatible.
- Fallback is opt-in; the default `fallback-models` value is `[]`.
- The first version supports Google and OpenAI only and never hard-codes a fallback model.
- Only HTTP 429, HTTP 5xx, and provider/network timeouts trigger fallback.
- Credentials, prompts, source, response bodies, and API error bodies must not be logged or written to the Actions Summary.
- At most five fallback models may be configured.

## Review Focus

- A provider-looking string with whitespace or an unknown prefix must fail before constructing any client; pin this in Task 1 configuration tests.
- Repeating the primary model under an explicit `google:` prefix must be recognized as a duplicate; pin this in Task 1 configuration tests.
- An OpenAI fallback without a key must not silently use ambient credentials; pin this in Task 2 factory tests.
- A timeout wrapped by a provider exception group must still be classified narrowly without accepting arbitrary exceptions; pin direct timeout and unrelated-exception cases in Task 2.
- Summary rendering must not include provider response bodies that may contain echoed input; pin a secret-bearing error-body case in Task 3.

---

### Task 1: Parse and validate fallback configuration

**Files:**
- Modify: `src/review.py`
- Modify: `tests/test_review.py`

**Interfaces:**
- Produces: `ModelSpec(provider: Literal["google", "openai"], name: str)`.
- Produces: `parse_fallback_models(raw: str, primary_model: str) -> tuple[ModelSpec, ...]`.
- Produces: `ReviewConfig.fallback_models: tuple[ModelSpec, ...]` and `ReviewConfig.openai_api_key: str`.

- [ ] **Step 1: Write failing configuration tests**

Add focused tests for an empty list, unqualified Google, explicit Google, OpenAI, malformed/non-array JSON, empty names, unknown providers, more than five entries, duplicate fallbacks, and a primary model duplicated as `google:<name>`.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `PYDANTIC_AI_NO_BANNER=1 UV_CACHE_DIR=/private/tmp/ai-review-actions-uv-cache uv run --frozen python -m unittest tests.test_review.ReviewConfigTest`

Expected: FAIL because the parser and configuration fields do not exist.

- [ ] **Step 3: Implement the parser and configuration fields**

Implement the exact interfaces above. Read `REVIEW_FALLBACK_MODELS` with default `[]` and `OPENAI_API_KEY` with default `""`; normalize Google prefixes for duplicate comparison without changing the caller-visible order.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run the command from Step 2 and expect PASS.

- [ ] **Step 5: Commit**

```bash
git add src/review.py tests/test_review.py
git commit -m "feat: parse fallback model configuration"
```

### Task 2: Build a provider-aware fallback model

**Files:**
- Modify: `pyproject.toml`
- Modify: `uv.lock`
- Modify: `src/model_io.py`
- Modify: `src/review.py`
- Modify: `tests/test_model_io.py`
- Modify: `tests/test_review.py`

**Interfaces:**
- Consumes: `ModelSpec` and the new `ReviewConfig` fields from Task 1.
- Produces: `is_transient_model_error(error: Exception) -> bool` in `src/model_io.py`.
- Produces: `build_review_model(config: ReviewConfig) -> Model[Any]` in `src/review.py`.

- [ ] **Step 1: Write failing classification and factory tests**

Assert fallback eligibility for 429, every representative 5xx status, and timeout; assert rejection for 400, 401, 403, unrelated exceptions, and `UsageLimitExceeded`. Assert Google-only compatibility, ordered Google/OpenAI construction, explicit key use, and failure when an OpenAI fallback lacks a key.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `PYDANTIC_AI_NO_BANNER=1 UV_CACHE_DIR=/private/tmp/ai-review-actions-uv-cache uv run --frozen python -m unittest tests.test_model_io tests.test_review`

Expected: FAIL because the predicate and factory do not exist.

- [ ] **Step 3: Add the OpenAI Pydantic AI extra**

Change the dependency to `pydantic-ai-slim[google,mcp,openai]==2.43.0` and refresh `uv.lock` with `uv lock`.

- [ ] **Step 4: Implement transient classification and model construction**

Create provider-specific models with explicit keys, wrap each in `BoundedReviewModel`, and return the sole model directly or an ordered `FallbackModel` using `is_transient_model_error`. Stop converting an exhausted 429 to `UsageLimitExceeded`; let the original `ModelHTTPError` reach the fallback layer. Use generic `ModelSettings` for agent settings.

- [ ] **Step 5: Add an end-to-end fallback request test**

Use function models or minimal model doubles to prove the same request reaches the second model after a transient first-model failure, succeeds without rerunning a completed tool call, and does not call the second model for a permanent failure.

- [ ] **Step 6: Run focused and full Python tests and verify GREEN**

Run the command from Step 2, then:

`PYDANTIC_AI_NO_BANNER=1 UV_CACHE_DIR=/private/tmp/ai-review-actions-uv-cache uv run --frozen python -m unittest discover -s tests`

Expected: all tests PASS, with only existing Docker-dependent skips.

- [ ] **Step 7: Commit**

```bash
git add pyproject.toml uv.lock src/model_io.py src/review.py tests/test_model_io.py tests/test_review.py
git commit -m "feat: fall back across model providers"
```

### Task 3: Surface exhausted fallback failures safely

**Files:**
- Modify: `src/review.py`
- Modify: `tests/test_review.py`

**Interfaces:**
- Consumes: ordered model specs and Pydantic AI's grouped fallback exception.
- Produces: `write_failure_summary(path: Path | None, models: Sequence[str], error: BaseException) -> None`.

- [ ] **Step 1: Write failing summary tests**

Assert that grouped failures render ordered model names and sanitized status/class labels, omit error bodies containing a sentinel secret, state that no report was produced, and do nothing when the summary path is absent.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `PYDANTIC_AI_NO_BANNER=1 UV_CACHE_DIR=/private/tmp/ai-review-actions-uv-cache uv run --frozen python -m unittest tests.test_review.FailureSummaryTest`

Expected: FAIL because `write_failure_summary` does not exist.

- [ ] **Step 3: Implement summary writing and main failure handling**

Catch only around the review execution, write the sanitized summary using `GITHUB_STEP_SUMMARY` when present, clear both provider keys from the environment before model construction, and re-raise the original failure so the action fails.

- [ ] **Step 4: Run focused and full Python tests and verify GREEN**

Run the focused command and the full Python command from Task 2 Step 6; expect PASS.

- [ ] **Step 5: Commit**

```bash
git add src/review.py tests/test_review.py
git commit -m "feat: summarize fallback exhaustion"
```

### Task 4: Wire the action inputs and document usage

**Files:**
- Modify: `action.yml`
- Modify: `tests/test_action_guard.cjs`
- Modify: `README.md`
- Modify: `docs/review-architecture.md`

**Interfaces:**
- Consumes: `REVIEW_FALLBACK_MODELS` and `OPENAI_API_KEY` expected by `ReviewConfig`.
- Produces: optional `fallback-models` and `openai-api-key` composite-action inputs.

- [ ] **Step 1: Write a failing action metadata test**

Assert both inputs exist with safe empty defaults, map to the exact environment variable names, and do not alter the required status of the existing Gemini key.

- [ ] **Step 2: Run the Node test and verify RED**

Run: `node --test tests/test_action_guard.cjs`

Expected: FAIL because the new inputs are absent.

- [ ] **Step 3: Add action inputs and environment wiring**

Add the two optional inputs and pass them only to the review step. Preserve all existing defaults and input names.

- [ ] **Step 4: Document single-model and fallback configurations**

Update README input tables and examples, then document parsing, transient-error rules, provider construction, exhaustion behavior, and caller-owned cost controls in the architecture guide.

- [ ] **Step 5: Run Node and Python suites and verify GREEN**

Run:

`node --test tests/test_*.cjs`

`PYDANTIC_AI_NO_BANNER=1 UV_CACHE_DIR=/private/tmp/ai-review-actions-uv-cache uv run --frozen python -m unittest discover -s tests`

Expected: both suites PASS.

- [ ] **Step 6: Commit**

```bash
git add action.yml tests/test_action_guard.cjs README.md docs/review-architecture.md
git commit -m "docs: explain model provider fallback"
```

### Task 5: Verify the complete change and prepare the upstream PR

**Files:**
- Verify all modified files.

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces: a pushed feature branch and PR targeting `Shion1305/ai-review-actions:main` linked to issue #6.

- [ ] **Step 1: Run formatting and lint checks**

Run:

`UV_CACHE_DIR=/private/tmp/ai-review-actions-uv-cache uv run --frozen ruff format --check .`

`UV_CACHE_DIR=/private/tmp/ai-review-actions-uv-cache uv run --frozen ruff check .`

- [ ] **Step 2: Run type checking**

Run: `UV_CACHE_DIR=/private/tmp/ai-review-actions-uv-cache uv run --frozen ty check src tests`

- [ ] **Step 3: Run all non-Docker tests**

Run:

`PYDANTIC_AI_NO_BANNER=1 UV_CACHE_DIR=/private/tmp/ai-review-actions-uv-cache uv run --frozen python -m unittest discover -s tests`

`node --test tests/test_*.cjs`

- [ ] **Step 4: Run Docker checks when the local daemon is available**

Run the three Docker-related CI commands from `.github/workflows/ci.yml`. If the daemon is unavailable, report these checks as not run instead of claiming full CI parity.

- [ ] **Step 5: Review the diff against the spec and issue**

Confirm every acceptance criterion has code or test evidence and that no Lumos-specific model, budget, repository, or workflow assumption entered production files.

- [ ] **Step 6: Push and open the upstream PR**

Push `feat/model-provider-fallback` to `tomoyahiroe/ai-review-actions`, then open a PR to `Shion1305/ai-review-actions:main` with `Closes #6`, a behavior summary, compatibility note, and verification evidence.

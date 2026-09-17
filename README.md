# AI Review Actions

`ynufes-tech/ai-review-actions`は、[Pydantic AI](https://github.com/pydantic/pydantic-ai)
経由のGeminiを使ってPull RequestをレビューするGitHub Actionです。モデルによるcheckoutの
調査やコマンド実行は、Gemini APIキーを保持するオーケストレーターではなく、使い捨ての
Dockerサンドボックス内で行います。

議論の取得には`ynufes-tech/ai-review-actions/context`、調査には
`ynufes-tech/ai-review-actions`、検証と投稿には`ynufes-tech/ai-review-actions/publish`を
使用します。モデルAPIキーを持つ調査ジョブと、`pull-requests: write`権限を持つ投稿ジョブを
分離してください。差分・会話履歴への入力上限を設け、既存の指摘と返信を踏まえて要約を更新します。

設計の根拠、CodeRabbitの公開仕様との比較、制約は[レビューの設計](docs/review-architecture.md)にまとめています。

## 使い方

checkoutにはBaseとHeadの両方のコミットが必要です。現在は開発段階のため、
3つのActionは`main`を参照し、実行時に最新の実装を取得します。

```yaml
name: AI PR Review
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review, edited]
permissions: {}
# ai-review-actionsは開発段階のため、mainを参照して常に最新の実装を適用する。
jobs:
  prepare:
    runs-on: ubuntu-latest
    if: >-
      github.event.pull_request.head.repo.full_name == github.repository &&
      !github.event.pull_request.draft &&
      github.event.pull_request.user.login != 'dependabot[bot]' &&
      github.actor != 'dependabot[bot]'
    permissions:
      contents: read
      pull-requests: read
    outputs:
      context: ${{ steps.context.outputs.context }}
      review-base-sha: ${{ steps.context.outputs.review-base-sha }}
      head-sha: ${{ steps.context.outputs.head-sha }}
      base-sha: ${{ steps.context.outputs.base-sha }}
      skip-review: ${{ steps.context.outputs.skip-review }}
    steps:
      - id: context
        uses: ynufes-tech/ai-review-actions/context@main
        with:
          pull-request-number: ${{ github.event.pull_request.number }}
          review-profile: model=gemini-3.8-flash;language=ja;network=none;budgets=default;mcp=none;policy=1

  analyze:
    needs: prepare
    if: needs.prepare.outputs.skip-review != 'true'
    runs-on: ubuntu-latest
    timeout-minutes: 20
    concurrency:
      group: ai-review-analyze-${{ github.workflow }}-${{ github.event.pull_request.number }}
      cancel-in-progress: true
    permissions:
      contents: read
    outputs:
      report: ${{ steps.review.outputs.report }}

    steps:
      - uses: actions/checkout@v6
        with:
          ref: ${{ needs.prepare.outputs.head-sha }}
          fetch-depth: 0
          persist-credentials: false
          path: source

      - id: review
        uses: ynufes-tech/ai-review-actions@main
        with:
          gemini-api-key: ${{ secrets.GEMINI_API_KEY }}
          repository: ${{ github.repository }}
          pull-request-number: ${{ github.event.pull_request.number }}
          base-sha: ${{ needs.prepare.outputs.base-sha }}
          head-sha: ${{ needs.prepare.outputs.head-sha }}
          review-base-sha: ${{ needs.prepare.outputs.review-base-sha }}
          review-context: ${{ needs.prepare.outputs.context }}
          source-directory: source

  publish:
    needs: [prepare, analyze]
    runs-on: ubuntu-latest
    timeout-minutes: 3
    concurrency:
      group: ai-review-publish-${{ github.workflow }}-${{ github.event.pull_request.number }}
      cancel-in-progress: false
    permissions:
      pull-requests: write
    steps:
      - uses: ynufes-tech/ai-review-actions/publish@main
        with:
          report: ${{ needs.analyze.outputs.report }}
          review-context: ${{ needs.prepare.outputs.context }}
          pull-request-number: ${{ github.event.pull_request.number }}
          head-sha: ${{ needs.prepare.outputs.head-sha }}
          base-sha: ${{ needs.prepare.outputs.base-sha }}
```

3つのActionは同じ参照を使用してください。GitHub Appを使う場合は、`context`と`publish`の
両方に同じ`reviewer-login`を指定します。上の例はpush等で動く最小構成です。
`review-profile`はモデル・レビュー方針・上限・MCP等を識別する秘密情報を含まない文字列です。
設定を変更したら更新してください。取得したAction実装の内容ハッシュと併せて、古い条件の完了結果を再利用しないために使います。
`main`の名前が同じでも実装が変わると、前回の完了結果を再利用せずPR全体を調査します。
返信イベントや手動実行を追加する際の対象判定・権限・競合制御は[イベントの設計](docs/review-architecture.md#イベントと権限)を参照してください。

モデルが生成するレビュー文の既定言語は日本語です。モデル生成文を別の言語にする場合は
`review-language`を指定してください。投稿側の見出し、Actionが補う制約・通知、
組み込みツールの固定説明文は日本語です。この設定はモデルが生成する部分に適用されます。
内部のシステムプロンプト、調査指示、ツール説明、モデルへの修正要求は英語です。
モデル生成文の言語は独立して指定し、JSONのキー・列挙値・コード・コマンドは翻訳しません。

## 出力

`report`出力は次の形式のJSONオブジェクトです。

```json
{
  "schema_version": 2,
  "reviewed_head_sha": "コミットSHA",
  "review_complete": true,
  "summary": "レビューの要約",
  "limitations": [],
  "verification_rationale": "変更した分岐のコードを読み、対象条件の再現で回帰を確認しました。",
  "assessments": [
    {
      "question": "空の入力でも正常に処理できるか。",
      "conclusion": "空の入力で例外になる回帰を確認したため、指摘に記載しました。",
      "evidence_step_ids": [1, 2],
      "resolved": true
    }
  ],
  "investigation": [
    {
      "id": 1,
      "tool": "get_pull_request_diff",
      "purpose": "PRの変更内容を確認する。",
      "command": "git diff base...head",
      "exit_code": 0,
      "result": "変更された分岐の差分"
    },
    {
      "id": 2,
      "tool": "run_command",
      "purpose": "変更した分岐が空の入力に対応しているか、再現で確認する。",
      "command": "node reproduce.mjs",
      "exit_code": 1,
      "result": "空の入力で例外が発生した再現結果"
    }
  ],
  "not_run_checks": [],
  "findings": [
    {
      "severity": "high",
      "title": "指摘のタイトル",
      "file": "relative/path.ts",
      "line": 10,
      "body": "問題、影響、根拠、修正案",
      "evidence_step_ids": [1, 2]
    }
  ]
}
```

Actionはcheckoutが指定されたHead SHAと一致することを検証し、`reviewed_head_sha`を自身で
設定します。`investigation`はツールの実行結果から記録する観測ログであり、合否の採点表では
ありません。コマンドの成功件数・終了コードからレビューの良否を決めません。

`assessments`は変更に関わる疑問と、観測事実に基づく短い結論です。`evidence_step_ids`は
実行済みの観測IDだけを参照でき、解決済みの評価には根拠が必要です。`resolved`は
「不具合がない」ではなく「判断に必要な調査を終えた」を表します。再現した回帰も評価は
解決済みにでき、その問題自体は`findings`へ記載します。
各findingにも、判断に使った観測IDを`evidence_step_ids`で指定する必要があります。

`verification_rationale`には選んだ検証方法が適切な理由を記載します。静的調査で判断できる
変更では、実行テストがなくても構いません。必要なのに代替手段でも補えていない検証だけを
`not_run_checks`へ理由付きで記録します。任意ツールの不足は、それ自体では未完了の理由にしません。

文字列の上限はUnicodeコードポイント数で数えます。絵文字を含む場合も、調査側と投稿側の
上限判定は一致します。

## レビューの投稿

`publish` Actionは`pull_request`イベントのコンテキストと`report`入力を使用します。
他のイベントでは`pull-request-number`と、調査時の`head-sha`・`base-sha`を渡します。
投稿前に実際のPRと照合するため、調査中にコミットが変わった結果は投稿されません。
checkoutやGemini APIキーは不要です。`github-token`の既定値は`${{ github.token }}`です。
モデルを変更する場合は、調査Actionと投稿Actionの両方へ同じ`model`を指定してください。
投稿本文の見出しと判定理由は日本語です。

### GitHub App名義で投稿する場合

GitHub Appにリポジトリ権限の`Pull requests: Read and write`を付与し、レビュー対象の
リポジトリへインストールしてください。checkoutは調査ジョブの`GITHUB_TOKEN`を使うため、
投稿用Appに`Contents`や`Actions`の書き込み権限は不要です。
利用側リポジトリのSettings → Secrets and variables → Actionsで、次を登録します。

| 種類 | 名前 | 内容 |
| --- | --- | --- |
| Variable | `AI_REVIEW_APP_CLIENT_ID` | GitHub AppのClient ID |
| Secret | `AI_REVIEW_APP_PRIVATE_KEY` | PEM形式の秘密鍵全体。改行を含めて登録 |
| Secret | `GEMINI_API_KEY` | 調査ジョブで使用するGemini APIキー |

GitHub FreeのprivateリポジトリではOrg Secrets・Variablesを利用できないため、上記は
Repository Secrets・Variablesとして登録してください。秘密鍵をリポジトリへコミットしないでください。

投稿ジョブを次のように変更します。調査ジョブへAppの秘密鍵やトークンを渡さず、投稿ジョブでは
checkoutやモデル生成コマンドの実行を行いません。

```yaml
  publish:
    needs: [prepare, analyze]
    runs-on: ubuntu-latest
    timeout-minutes: 3
    permissions: {}
    steps:
      - name: PR投稿用トークンを発行
        id: app-token
        uses: actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1 # v3.2.0
        with:
          client-id: ${{ vars.AI_REVIEW_APP_CLIENT_ID }}
          private-key: ${{ secrets.AI_REVIEW_APP_PRIVATE_KEY }}
          owner: ${{ github.repository_owner }}
          repositories: ${{ github.event.repository.name }}
          permission-pull-requests: write

      - name: GitHub App名義でレビューを投稿
        uses: ynufes-tech/ai-review-actions/publish@main
        with:
          report: ${{ needs.analyze.outputs.report }}
          github-token: ${{ steps.app-token.outputs.token }}
          reviewer-login: ${{ format('{0}[bot]', steps.app-token.outputs.app-slug) }}
          review-context: ${{ needs.prepare.outputs.context }}
          pull-request-number: ${{ github.event.pull_request.number }}
          head-sha: ${{ needs.prepare.outputs.head-sha }}
          base-sha: ${{ needs.prepare.outputs.base-sha }}
```

トークンの対象はこのリポジトリだけ、権限はPR操作だけに制限し、ジョブ終了時に失効させます。
`reviewer-login`には投稿トークンと同じアカウントを指定してください。既定値は
`github-actions[bot]`で、重複投稿の判定と自己承認の防止に使用します。
Appのインストール先や権限、秘密鍵が正しくない場合は失敗させ、別のトークンへ自動で切り替えません。
詳細は[公式トークン発行Action](https://github.com/actions/create-github-app-token)と
[Repository Secrets・Variablesの制約](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets#creating-secrets-for-an-organization)を参照してください。

### 表示と判定

本文には短い要約、指摘、未確認の検証だけを表示します。
コマンドの成功・失敗件数は表示しません。
詳しい評価と根拠、調査コマンド、実行結果は「調査ログ」に折りたたみます。
未完了の場合はモデルの完了宣言を本文へ出さず、検証が残ることを固定文で示します。
要約と各評価の結論は240文字以内に制限し、同じ未確認事項を複数の節へ言い換えて並べないよう指示します。
ログはHTMLとして解釈されないコード表示にします。
要約・正式なレビュー・インライン指摘・返信は、エスケープと状態マーカーの付加後に
60,000 UTF-8バイト以内かを確認します。超過時は、まず調査ログを実行ログへのリンクへ
置き換え、それでも大きい場合は説明文を省略表示にします。全文のレポートをJSON形式で
実行ログへ保存し、抜粋であることと確認先を表示します。
判定、未完了の状態、指摘の重大度・タイトル・場所、既存スレッドへのリンクを残し、
Markdownの途中や再実行用の状態マーカーを機械的に切り落としません。

GitHubのPR差分に対応する指摘は、該当行へのインラインコメントとして投稿します。
差分外の行やpatchを取得できないファイルの指摘は、コードへのリンク付きで本文に残します。
削除されたファイルへのリンクにはBaseコミットを使用します。
同じ指摘の全文を本文とインラインコメントへ重複して掲載しません。

指摘は、そのプロジェクトやフレームワークに不慣れな人にも理由が伝わるように説明します。
タイトルには具体的な問題を書き、本文では「どの入力・状況で起きるか」「期待する動作と実際の動作」
「コードがその動作を引き起こす理由」「影響」「具体的な修正方法と、それで直る理由」をつなげます。
必要な専門用語やAPIの動作は短く補足し、調査ログを開かなくても指摘の要点を理解できるようにします。
単純な問題は数文で説明し、複雑な問題は3,000文字の上限内で段落を増やせます。
日本語では「です・ます」調を使い、書き手の能力ではなくコードの動作について説明します。

たとえば「空でなければ先頭要素を返し、空の一覧には`None`を返す」という仕様の関数が、
空かどうかの判定より先に`items[0]`を読む場合は、次のように説明します。
これは架空のコード・仕様による文体の例です。

> `items`が空の場合、`items[0]`（先頭要素の取得）で`IndexError`が発生し、仕様の`None`を返せません。
> 空の一覧には先頭要素がないため、その後の空チェックまで処理が進まないことが原因です。
>
> `if not items: return None`を先頭要素の取得より前に置いてください。空の入力を先に処理すれば、
> 要素があるときだけ`items[0]`を実行できます。修正後は、`[]`で`None`、`["a"]`で`"a"`が返るかを確認してください。

説明や修正案は観測したコード・仕様を根拠にし、説明用の例や提案した確認を実行済みの結果と区別します。
根拠が足りない疑問は指摘として断定せず、評価や制約へ記録します。

JSONの構造・文字数・対象SHAを検証した後、コードで判定します。

- `critical`または`high`の指摘がある場合は`REQUEST_CHANGES`
- その他の指摘、未解決の疑問、必要なのに未実行の検証、制約、根拠付きの評価の不足がある場合は`COMMENT`
- 指摘と未解決の懸念がなく、根拠付きの評価と調査が完了した場合は`APPROVE`
- Draftと`reviewer-login`で指定した投稿アカウント自身が作成したPRでは常に`COMMENT`

差分の調査ツールを呼び出していない調査、観測を引用していない解決済み評価は承認できません。
完了を申告するには、終了コードによらず全観測の意味を評価または指摘に含める必要があります。
たとえば検索の一致なし、
任意ツールの不足、既存テストの失敗と今回の回帰を区別します。終了コード自体を合否の根拠にはしません。
ただし、参照先IDが正しくても、モデルによる結論の正しさまで機械的に保証できるわけではありません。
通常のCIや人間のレビューを置き換えるものではありません。

投稿直前にHead・BaseのSHAとPRが開いていることを確認し、古い結果は投稿しません。
同一実行・試行のレビューがすでにある場合も投稿を省略します。AI出力は本文としてのみ扱い、
コードとして評価せず、メンション通知を抑制します。JSONの検証やAPI操作の失敗はジョブの
失敗として返します。既定の`GITHUB_TOKEN`で承認を使う場合は、リポジトリ設定で
GitHub ActionsによるPR承認を許可してください。GitHub App名義の場合は上記のApp設定を使用します。

出力は`published`（投稿・更新時に`true`）、`event`（判定）、`review-url`（レビューまたは要約URL）です。
投稿を省略した場合、`published`は`false`、残りの出力は空文字です。

### 既存の指摘と返信を扱う

`context`のJSONを調査と投稿の両方の`review-context`へ渡すと、要約コメントを毎回更新します。
正式なPR Reviewは新しい指摘、判定の変化、新しいコミットへの承認が必要な場合に投稿します。
同じ指摘は既存のスレッドに結び付け、状態と人間からの返信に変化がない再評価は返信を省略します。

`context`はPR説明、最大20スレッドの元コメントと直近5件の返信、一般コメント最大10件を
合計30KB以内で取得します。モデルは`get_review_context`で必要な箇所をページ単位で読みます。
省略があれば`truncated: true`となり、自動承認と完了済みスキップを禁止します。

`findings[].existing_thread_id`は既存の指摘を表します。`prior_findings`は各スレッドについて
`thread_id`、`status`（`still_present`・`fixed`・`uncertain`）、`body`、`evidence_step_ids`を返します。
投稿側はスレッドの所属PR・元コメント・投稿者をGitHubで再確認します。
「修正しました」という返信やoutdatedフラグだけでは修正済みにできず、現在のコードの根拠が必要です。
未確認・未評価の指摘が残る場合や、調査中に議論が変わった場合は承認しません。

完了したレビューのHeadを次回の差分基点に使います。Base変更や祖先関係の不成立時は全体比較へ戻り、
古い未解決の指摘も再調査します。同じHead・Base・議論・Draft状態・Action実装の内容ハッシュ・
`review-profile`の完了済みレビューは省略します。
`context`の`full-review: "true"`で、スキップと前回Headの再利用を無効にできます。

既存スレッドの自動resolveや過去の変更要求の自動dismissはしません。`COMMENT`に変わっても
GitHub上の過去の変更要求は残るため、解消後の承認または人間の操作が必要です。
議論の永続的な学習や別PRへの引き継ぎは行いません。
`review-context`を省略した場合は従来の実行ごとの投稿方式で動作します。

## v1からの移行

調査Actionと投稿Actionを、v2形式に対応した同じ参照（現在は`main`）へ更新してください。入力名・ジョブ分離・
調査コンテナの権限削除とジョブ分離は維持しています。JSON出力は`schema_version: 2`となり、旧`checks`を
`investigation`、`assessments`、`verification_rationale`、`not_run_checks`へ置き換えています。
独自にJSONを読む処理がある場合は対応が必要です。

v2の投稿Actionは旧形式も読み取れますが、指摘と評価に観測の参照がないため、自動承認や
変更要求はせずコメントとして投稿します。既存のv1タグは変更しません。

## 観測に応じた反復調査

Pydantic AIは「モデルがツールを選ぶ → サンドボックスで実行 → 実際の出力をモデルへ返す →
次の調査を選ぶ」を最終レポートまで繰り返します。コマンド一覧を一度生成して実行するだけの
構成ではありません。同じworkspaceを操作するツールは直列実行します。

ファイルの閲覧・一覧・文字列検索には専用ツールを使うよう指示しています。モデルが
`cat`や`sed`などのシェルコマンドを書く必要はありません。

| 操作 | ツール | 指定例 |
| --- | --- | --- |
| 変更ファイルの一覧 | `get_pull_request_diff` | `start_line=1, end_line=100` |
| 特定ファイルの差分 | `get_pull_request_diff` | `path="src/app.py", start_line=1, end_line=200` |
| PR説明・議論 | `get_review_context` | `section="description"` または `thread_id="...", start_index=1` |
| 過去の観測を取り出す | `read_observation` | `step_id=3, start_char=1000`（省略時は索引） |
| 作業メモを更新する | `save_review_notes` | `summary="調査済みの結論と残る疑問", evidence_step_ids=[1, 3]` |
| ファイルを読む | `read_file` | `path="src/app.py", start_line=1, end_line=200` |
| ファイルの所在を調べる | `list_directory` | `path="src", depth=2` |
| 文字列を検索する | `search_text` | `pattern="handle_request", path="src"` |

`read_file`の行番号は1始まりで、開始行と終了行を含めて一度に400行まで取得できます。
続きは`start_line=401, end_line=800`のように両方の行番号を指定します。
内部ではDocker内の`sed`等を使い、テストや生成物と同じworkspaceを調べます。
そのため、専用ツールを使った場合も調査ログの`command`には内部の実行コマンドが残ります。

`run_command`では調べたい疑問とコマンドを選んだ理由を`purpose`として指定します。
テスト・再現・依存関係の準備など、専用ツールで対応できない操作に使用します。
モデルは利用可能なツール・依存関係・制約を考慮して、実行が必要か、静的調査や代替手段で
判断できるかを評価します。出力を見てから関連ファイルを読む、再現条件を絞る、Baseと比較するなど、
観測に応じて次の操作を選ぶよう指示しています。

各観測は`AI investigation:`という接頭辞のJSONとして実行ログに記録します。本文には短い抜粋を
残し、ログにはサンドボックスの出力上限内の結果を記録します。最終的なモデルリクエスト数も
ログに記録しますが、これは調査の追跡用であり、品質の点数ではありません。
テストでは、前の出力で初めて分かるファイルと再現コマンドを次のモデル応答が選ぶこと、
任意ツールの失敗と必要な未解決の検証を区別することを確認しています。
JSONが40 KBを超える場合は観測のコマンド・目的・結果の抜粋だけを短縮し、観測ID、指摘、
評価は保持します。指摘や評価自体が大きすぎる場合は、内容を捨てて投稿せず明示的に失敗します。

## MCPによる文書・Issueの参照

`mcp-servers`を指定すると、モデルが外部の文書やIssueを専用のMCPツールで参照できます。
コードは既存の`read_file`等で読み、外部情報と照合します。既定では外部MCP接続はありません。

次の例は[Context7](https://github.com/upstash/context7)のライブラリ文書検索と、
[GitHub MCP](https://github.com/github/github-mcp-server)のPR・Issue参照を有効にします。
調査Actionと`publish`は、この機能に対応した同じ参照（現在は`main`）を使用してください。

```yaml
with:
  # ほかの必須入力は省略
  mcp-servers: |
    [
      {
        "name": "docs",
        "url": "https://mcp.context7.com/mcp",
        "description": "Find library documentation. Resolve the library first, then check the installed version and source URL.",
        "allowed_tools": ["resolve-library-id", "query-docs"]
      },
      {
        "name": "github",
        "url": "https://api.githubcopilot.com/mcp/",
        "description": "Read the target PR and linked issues to compare requirements with the implementation. Search the target repository first.",
        "allowed_tools": ["pull_request_read", "issue_read", "search_issues"]
      }
    ]
  mcp-headers: ${{ secrets.AI_REVIEW_MCP_HEADERS }}
```

Repository Secretの`AI_REVIEW_MCP_HEADERS`には、次の形式のJSONを登録します。
認証情報は例の文字列を実際の値へ置き換えてください。

```json
{
  "docs": {
    "Authorization": "Bearer CONTEXT7_API_KEY"
  },
  "github": {
    "Authorization": "Bearer GITHUB_MCP_READ_TOKEN",
    "X-MCP-Readonly": "true",
    "X-MCP-Tools": "pull_request_read,issue_read,search_issues"
  }
}
```

GitHubには、対象リポジトリのIssues・Pull requestsを読める調査専用のトークンを使用します。
投稿用トークンとは分けてください。GitHub公式のリモートMCPはPAT認証を案内しています。
認証・利用条件は[リモートMCPの公式説明](https://github.com/github/github-mcp-server#remote-github-mcp-server)、
ヘッダーの設定は[リモートサーバーの設定資料](https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md)
で確認してください。Context7だけを使う場合は、両方のJSONから`github`の設定を外せます。

### 調査と根拠

モデルへは`mcp_docs_query-docs`のようにサーバー名を付けたツールを公開します。
ライブラリの識別・文書検索・PRやIssueの取得を、直前の結果を見ながら選びます。
ローカルのpackage metadataやlockfileで対象バージョンを確認し、外部文書の出典と適用範囲を
確認するよう指示しています。Context7の検索結果すべてが公式文書とは限りません。
PRの説明から関連Issueをたどり、その要件・受け入れ条件と実装を照合します。

取得結果は`investigation`の`tool: "external_context"`として、コード調査と同じ観測IDで
記録します。`command`には`mcp サーバー名/ツール名 引数JSON`を記載します。
`exit_code`はMCP呼び出しの成功を`0`、失敗を`1`で表す互換用の値で、シェルの終了コードではありません。
引用した観測IDと出典URLを評価・指摘へ記載するよう指示し、投稿側も外部の観測IDを検証します。

MCP呼び出しは既存の調査回数上限を共有し、1回30秒、結果は約20,000文字に制限します。
ツール呼び出しの失敗も観測として返し、モデルが代替手段や未確認事項を判断できます。
設定不備、初期接続・ツール一覧取得の失敗、指定したツールの欠落は、ジョブを明示的に失敗させます。

### 接続設定の扱い

接続先は信頼するワークフローのAction入力で指定し、レビュー対象の設定ファイルからは読みません。
HTTPSのStreamable HTTPに対応します。stdioでのプログラム起動、設定中の環境変数展開、
URL内の認証情報・クエリ・フラグメントには対応しません。
サーバーは最大4個、許可ツールは各8個・合計16個です。

`allowed_tools`には管理者が読み取り用途を確認したツール名だけを列挙してください。
一覧にないツールと、サーバーが`readOnlyHint: false`と明示したツールは公開しません。
注釈だけでは実際の動作を保証できないため、接続先自体とトークンの権限も限定します。
サーバーからの初期指示はシステム指示に取り込まず、文書・Issue本文も調査資料として扱います。

MCPはオーケストレーターから接続するため、`sandbox-network: none`でも利用できます。
サンドボックスのネットワーク設定は引き続きコンテナ内のコマンドに適用されます。
MCPの認証ヘッダーをモデルの引数やコンテナへ渡しません。
設定した認証情報がツール定義に含まれている場合は、モデルへ渡す前に処理を停止します。
応答・エラー内の認証情報はマスキングし、MCP接続中は生の応答を含み得るSDKの通信ログを抑止します。
モデルが選んだ検索文・リポジトリ名・Issue番号等は接続先へ送られるため、利用を認めるサーバーだけを設定してください。
ソースコードや差分を検索文として送らないよう指示しています。

## 使用上限

| 入力 | 既定値 | 対象 |
| --- | --- | --- |
| `model-input-byte-limit` | 96,000 | 1要求の履歴・指示・ツール定義・設定を直列化したバイト数 |
| `model-input-bytes-per-minute` | 384,000 | このプロセスの直近60秒の入力バイト予算。失敗した試行も含む |
| `model-output-token-limit` | 8,192 | 1応答の出力トークン上限 |

入力のバイト数はGoogleのトークン数やHTTP通信量とは異なります。成功した応答の実際の
input/output/cacheトークン数もログに記録し、運用時の調整に使います。
モデルへ渡すツール出力は約6KBに制限します。通常の入力には最初の依頼、直近4往復の会話と
小さな調査索引を残し、古い会話・出力は除外します。観測は別のメモリに保持し、
`read_observation`で必要な結果だけをページ単位で取得できます。
短い作業メモには結論・指摘候補・未確認の疑問を残し、毎回置き換えます。メモも根拠IDと
サイズを検証し、確定した証拠としては扱いません。
巨大な差分は全件投入せず、ファイル一覧から必要な差分を最大400行ずつ読みます。

要求間隔は最低5秒とし、429・502・503は最大3試行まで再送します。`Retry-After`とGoogleの
`RetryInfo`を尊重し、SDK内部の重複リトライは無効化します。再送ではツールを再実行しません。
待機は1要求で合計180秒までです。入力・待機予算の超過や429の継続時は未完了レポートを返し、
承認しません。認証エラー等は通常の失敗として扱います。

この予算は1実行内の制御です。Geminiの制限はAPIキー単位ではなくプロジェクト単位なので、
他のPRやアプリと同時実行すれば429は起こり得ます。[Googleのレート制限](https://ai.google.dev/gemini-api/docs/rate-limits)
を確認し、必要なら全利用者をまたぐキューやプロジェクトの分離を別途設計してください。

既定値では、モデルリクエストを120回、ツール呼び出しを100回まで許可します。モデルには
調査ツールを80回までに抑えるよう指示し、検証済みの最終結果を生成する余力を残します。
これは入力トークン量や品質の基準ではなく、循環する調査を止める補助的な上限です。
短いページ読み取りと大量出力のコマンドを回数だけで等価に扱わず、入力バイト・送信量と
ワークフローのタイムアウトも別に制御します。
先にPydantic AIの使用上限へ到達した場合は、調査結果をすべて破棄せず未完了のレポートを返します。

`request-limit`（最大240）、`tool-call-limit`（最大100）、`investigation-tool-limit`
（ツール上限以下）で調整できます。100回でも完了を保証するものではなく、大きなPRでは
入力予算・実行時間・調査範囲に応じて未完了となります。

モデルや依存パッケージのバージョンについて、学習済み知識だけによる存在・互換性の断定は
指摘から除外するよう指示します。必要な外部情報を確認できない場合は制約へ記録します。

## サンドボックス

オーケストレーターはGitHub Actionsホスト上で動作し、この処理だけに`GEMINI_API_KEY`を渡します。
リポジトリ用ツールは、次の制約を設定したDockerコンテナで実行します。

- 既定ではネットワーク接続なし。`sandbox-network: public`で公開HTTP(S)通信を許可
- Linux capabilityをすべて削除し、`no-new-privileges`を有効化
- CPU、メモリ、プロセス数、コマンド実行時間を制限
- checkoutは読み取り専用でマウント
- テストと生成物には非公開の書き込み可能な`tmpfs`コピーを使用
- GitHubやGeminiの認証情報をコンテナへ渡さない

既定イメージは`sandbox/Dockerfile`から構築します。digestへ固定した`node:22-bookworm`に
pnpm 12.3.4とactionlint 1.7.12を同梱し、actionlintの配布物はSHA-256も検証します。
パッケージマネージャ用のホーム・キャッシュは、書き込みと実行が可能な専用tmpfsに配置します。
読み取り専用のルートや`noexec`の`/tmp`へキャッシュを作って失敗することを防ぎます。

依存関係や外部Actionの仕様を調べる場合は、調査Actionに次を追加します。

```yaml
with:
  # ほかの必須入力は省略
  sandbox-network: public
```

`public`では専用Dockerネットワークを作成し、公開IPv4宛てのTCP 80・443とコンテナ内の
ループバック通信を許可します。ホスト、プライベート網、メタデータサービス等の宛先と外向きIPv6は拒否します。
DNSはDockerの内部リゾルバーを使います。信頼する短命の補助コンテナだけに`NET_ADMIN`を付けて
ネットワークルールを設定し、終了後にモデルへ調査ツールを公開します。調査コンテナ自身に
`NET_ADMIN`は付与しません。設定に失敗した場合は処理を中止し、無制限の通信へ切り替えません。

モデルは`package.json`やlockfileを確認し、必要な場合に`pnpm install --frozen-lockfile`などを
サンドボックス内で実行します。依存関係の取得、lifecycle script、lint、buildはホスト上で実行しません。
外部仕様は公式ドキュメントや固定リビジョンのソースで調べるよう指示します。
`none`の場合は追加のパッケージ・プロジェクト指定のパッケージマネージャ等を取得できません。

注意: `public`は宛先ドメインの許可リストではありません。悪意のあるコード・依存関係が公開サーバーへ
checkoutの内容を送信するリスクは残ります。秘密鍵をコンテナへ渡さないこととは別のリスクなので、
対象PRと依存関係を信頼できる場合に限って有効化してください。厳密な機密性が必要な対象は`none`を使用します。

事前構築済みの独自イメージは`sandbox-image`で指定できます。`public`で使う場合は
`sh`、`iptables`、`ip6tables`が必要です。イメージは信頼できる供給元のdigestへ固定してください。

指定したAction参照のコードは、権限を持つオーケストレーター内で実行されます。現在の`main`参照は
このリポジトリへの更新を信頼して取り込む設定です。fork由来のワークフローへSecretを渡さず、
レビュー対象のcheckoutでは`persist-credentials: false`を使用してください。

## 開発

```bash
uv sync --frozen
uv run ruff format --check .
uv run ruff check .
uv run ty check src tests
uv run python -m unittest discover -s tests
node --test tests/test_*.cjs
RUN_DOCKER_TESTS=1 uv run python tests/test_review.py DockerSandboxTest
docker build --tag ai-review-sandbox:dev sandbox
RUN_DOCKER_TESTS=1 uv run python tests/test_environment.py
```

投稿処理のテストにはNode.js 22以降、Dockerテストには起動中のDockerデーモンが必要です。

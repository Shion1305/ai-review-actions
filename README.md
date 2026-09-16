# AI Review Actions

`ynufes-tech/ai-review-actions`は、[Pydantic AI](https://github.com/pydantic/pydantic-ai)
経由のGeminiを使ってPull RequestをレビューするGitHub Actionです。モデルによるcheckoutの
調査やコマンド実行は、Gemini APIキーを保持するオーケストレーターではなく、使い捨ての
Dockerサンドボックス内で行います。

調査には`ynufes-tech/ai-review-actions`、検証と正式なPR Reviewの投稿には
`ynufes-tech/ai-review-actions/publish`を使用します。モデルAPIキーを持つ調査ジョブと、
`pull-requests: write`権限を持つ投稿ジョブを分離して利用してください。

## 使い方

checkoutにはBaseとHeadの両方のコミットが必要です。次の例のActionリビジョンは説明用です。
本番ワークフローでは、検証済みの完全なコミットSHAへ固定してください。

```yaml
name: AI PR Review
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review, converted_to_draft]
permissions: {}
concurrency:
  group: ai-review-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  analyze:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    if: >-
      github.event.pull_request.head.repo.full_name == github.repository &&
      github.event.pull_request.user.login != 'dependabot[bot]' &&
      github.actor != 'dependabot[bot]'
    permissions:
      contents: read
    outputs:
      report: ${{ steps.review.outputs.report }}

    steps:
      - uses: actions/checkout@v6
        with:
          ref: ${{ github.event.pull_request.head.sha }}
          fetch-depth: 0
          persist-credentials: false
          path: source

      - id: review
        uses: ynufes-tech/ai-review-actions@v2
        with:
          gemini-api-key: ${{ secrets.GEMINI_API_KEY }}
          repository: ${{ github.repository }}
          pull-request-number: ${{ github.event.pull_request.number }}
          base-sha: ${{ github.event.pull_request.base.sha }}
          head-sha: ${{ github.event.pull_request.head.sha }}
          source-directory: source

  publish:
    needs: analyze
    runs-on: ubuntu-latest
    timeout-minutes: 3
    permissions:
      pull-requests: write
    steps:
      - uses: ynufes-tech/ai-review-actions/publish@v2
        with:
          report: ${{ needs.analyze.outputs.report }}
```

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
    needs: analyze
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
        uses: ynufes-tech/ai-review-actions/publish@v2
        with:
          report: ${{ needs.analyze.outputs.report }}
          github-token: ${{ steps.app-token.outputs.token }}
          reviewer-login: ${{ format('{0}[bot]', steps.app-token.outputs.app-slug) }}
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
表示用のエスケープで本文サイズが上限を超える場合は、各記録をJSON形式で実行ログへ明示的に
出力し、本文の詳細をその実行ログへのリンクへ置き換えます。

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

出力は`published`（新規投稿時に`true`）、`event`（判定）、`review-url`（投稿URL）です。
投稿を省略した場合、`published`は`false`、残りの出力は空文字です。

## v1からの移行

調査Actionと投稿Actionを同じv2のコミットSHAへ更新してください。入力名・ジョブ分離・
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
調査Actionと`publish`は、この機能に対応した同じコミットSHAへ更新してください。

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

既定値では、モデルリクエストを80回、ツール呼び出しを30回まで許可します。モデルには
調査ツールを24回までに抑えるよう指示し、検証済みの最終結果を生成する余力を残します。
先にPydantic AIの使用上限へ到達した場合は、調査結果をすべて破棄せず未完了のレポートを返します。

`request-limit`、`tool-call-limit`、`investigation-tool-limit`では、これらの上限を引き下げられます。

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

指定したActionリビジョンのコードは、権限を持つオーケストレーター内で実行されます。信頼できる
コミットへ固定し、fork由来のワークフローへSecretを渡さず、レビュー対象のcheckoutでは
`persist-credentials: false`を使用してください。

## 開発

```bash
uv sync --frozen
uv run ruff format --check .
uv run ruff check .
uv run ty check src tests
uv run python -m unittest discover -s tests
node --test tests/test_publish.cjs
RUN_DOCKER_TESTS=1 uv run python tests/test_review.py DockerSandboxTest
docker build --tag ai-review-sandbox:dev sandbox
RUN_DOCKER_TESTS=1 uv run python tests/test_environment.py
```

投稿処理のテストにはNode.js 22以降、Dockerテストには起動中のDockerデーモンが必要です。

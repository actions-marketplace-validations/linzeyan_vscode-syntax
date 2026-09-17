// The corpus the mermaid differential runs through both renderers.
//
// Three groups, and the split is by what a difference would mean:
//
//   * `diagram` — one fence per mermaid diagram type. A difference here means
//     one side draws something the other cannot, which is a coverage gap.
//   * `markdown` — what counts as a diagram fence at all. A difference here is
//     in the markdown-it layer, and it is the one a document notices when the
//     editor updates and poly stands down.
//   * `content` — escaping, failure and configuration. A difference here is a
//     defect in the half poly wrote, since both sides hand the same string to
//     the same library.
//
// Sources are mermaid's own documented examples, cut to the smallest thing that
// still exercises the diagram's parser.

/**
 * ```mermaid fences, one per diagram type mermaid 11 ships.
 *
 * The list is not hand-picked: it is every id mermaid 11.17 registers -- read
 * out of `registerLazyLoadedDiagrams` in its own bundle -- plus `zenuml`, which
 * only the built-in registers. Two of them share a header and differ only in
 * the renderer the detector picks (`graph` vs `flowchart`, `stateDiagram` vs
 * `stateDiagram-v2`), so both spellings are here. Sources are mermaid's own
 * demos and syntax docs at the tag poly pins, cut to the smallest thing that
 * still exercises the diagram's parser.
 */
const DIAGRAMS = {
  flowchart: "graph TD\n  A[Start] --> B{OK?}\n  B -->|yes| C[Done]\n  B -->|no| A",
  "flowchart-v2": "flowchart LR\n  id1(Round) --> id2([Stadium]) --> id3[[Subroutine]]",
  sequence: "sequenceDiagram\n  Alice->>John: Hello John\n  John-->>Alice: Great!",
  class: "classDiagram\n  Animal <|-- Duck\n  Animal : +int age\n  class Duck{\n    +String beakColor\n  }",
  state: "stateDiagram-v2\n  [*] --> Still\n  Still --> Moving\n  Moving --> [*]",
  // The v1 renderer, which is still registered and still reachable by header.
  "state-v1": "stateDiagram\n  [*] --> Still\n  Still --> Moving\n  Moving --> [*]",
  er: "erDiagram\n  CUSTOMER ||--o{ ORDER : places\n  ORDER ||--|{ LINE-ITEM : contains",
  journey: "journey\n  title My day\n  section Go to work\n    Make tea: 5: Me\n    Drive: 3: Me",
  gantt: "gantt\n  title A Gantt\n  dateFormat YYYY-MM-DD\n  section S\n    Task :a1, 2024-01-01, 30d",
  pie: 'pie title Pets\n  "Dogs" : 386\n  "Cats" : 85',
  quadrant: "quadrantChart\n  title Reach and engagement\n  x-axis Low Reach --> High Reach\n  y-axis Low --> High\n  Campaign A: [0.3, 0.6]",
  requirement: "requirementDiagram\n  requirement test_req {\n    id: 1\n    text: the test text.\n    risk: high\n    verifymethod: test\n  }",
  // Commit ids are spelled out: mermaid generates random ones otherwise, and
  // two sides drawing the same graph would then differ on every run.
  gitgraph: 'gitGraph\n  commit id: "one"\n  branch develop\n  commit id: "two"\n  checkout main\n  merge develop',
  c4: "C4Context\n  title System Context\n  Person(customerA, \"Banking Customer A\")",
  mindmap: "mindmap\n  root((mindmap))\n    Origins\n      Long history\n    Research",
  timeline: "timeline\n  title History\n  2002 : LinkedIn\n  2004 : Facebook",
  sankey: "sankey-beta\n\nAgricultural waste,Bio-conversion,124.729",
  xychart: 'xychart-beta\n  title "Sales"\n  x-axis [jan, feb, mar]\n  y-axis "Revenue" 0 --> 10000\n  bar [5000, 6000, 7500]',
  block: "block-beta\n  columns 3\n  a b c\n  d e f",
  packet: "packet-beta\n0-15: \"Source Port\"\n16-31: \"Destination Port\"",
  kanban: "kanban\n  Todo\n    [Create Sample]\n  Done\n    [Ship it]",
  architecture: "architecture-beta\n  group api(cloud)[API]\n  service db(database)[Database] in api\n  service server(server)[Server] in api\n  db:L -- R:server",
  radar: "radar-beta\n  axis a[\"A\"], b[\"B\"], c[\"C\"]\n  curve x[\"X\"]{3, 4, 5}",
  treemap: "treemap-beta\n\"Section 1\"\n  \"Leaf 1.1\": 12\n  \"Leaf 1.2\": 24",
  info: "info",
  swimlane: "swimlane-beta LR\n  subgraph Customer\n    request[Request service]\n  end\n\n"
    + "  subgraph Support\n    triage[Triage request]\n  end\n\n  request --> triage",
  treeview: "treeView-beta\n\"docs\"\n    \"build\"\n    \"source\"\n        \"static\"",
  eventmodeling: "eventmodeling\n\ntf 01 ui CartUI\ntf 02 cmd AddItem\ntf 03 evt ItemAdded",
  ishikawa: "ishikawa-beta\n  Blurry Photo\n  Process\n    Out of focus\n  Equipment\n    Dirty lens",
  venn: "venn-beta\n  title Basic Venn\n  set A\n  set B\n  union A,B[\"AB\"]",
  wardley: "wardley-beta\ntitle Tea Shop\nanchor Business [0.95, 0.63]\ncomponent Cup of Tea [0.79, 0.61]",
  cynefin: "cynefin-beta\ntitle Incident Response\n\ncomplex\n\"Investigate root cause\"\n\n"
    + "complicated\n\"Expert review needed\"",
  railroad: "railroad-beta\ntitle Expression Grammar\n\nexpression = sequence(\n"
    + "  nonterminal(\"term\"),\n  zeroOrMore(terminal(\"+\"))\n) ;\nterm = oneOrMore(terminal(\"1\")) ;",
  "railroad-ebnf": "railroad-ebnf-beta\ntitle \"Digit Definition\"\n\ndigit = \"0\" | \"1\" | \"2\" ;",
  "railroad-abnf": "railroad-abnf-beta\ntitle \"Phone Number\"\n\nphone = [ \"+\" country ] subscriber ;\n"
    + "country = 1*DIGIT ;\nsubscriber = 1*( DIGIT / \"-\" ) ;",
  "railroad-peg": "railroad-peg-beta\ntitle \"Calculator\"\n\nExpression <- Term (\"+\" Term)* ;\n"
    + "Term <- Digit+ ;\nDigit <- \"0\" / \"1\" / \"2\" ;",
  // Not mermaid's: the built-in registers `@mermaid-js/mermaid-zenuml` as an
  // external diagram, so it draws a type poly has no parser for. Here to
  // measure that gap rather than to assume it is small.
  zenuml: "zenuml\nA.method() {\n  B.method()\n}",
};

/** The fence itself: which info strings and which markdown shapes count. */
const MARKDOWN = {
  plain: "```mermaid\ngraph TD\n  A --> B\n```",
  uppercase: "```Mermaid\ngraph TD\n  A --> B\n```",
  "info-attributes": '```mermaid {caption="flow"}\ngraph TD\n  A --> B\n```',
  // mermaid's own documentation fences source it is *talking about* this way.
  "mermaid-example": "```mermaid-example\ngraph TD\n  A --> B\n```",
  "not-mermaid": "```mermaidjs\ngraph TD\n  A --> B\n```",
  "other-language": "```rust\nfn main() {}\n```",
  tildes: "~~~mermaid\ngraph TD\n  A --> B\n~~~",
  "four-tildes-in-list": "- item\n\n  ```mermaid\n  graph TD\n    A --> B\n  ```",
  "in-blockquote": "> ```mermaid\n> graph TD\n>   A --> B\n> ```",
  "indented-code-block": "    ```mermaid\n    graph TD\n      A --> B\n    ```",
  // The container syntax the built-in supports beside fences.
  "directive-container": ":::mermaid\ngraph TD\n  A --> B\n:::",
  "container-unclosed": ":::mermaid\ngraph TD\n  A --> B",
  "container-longer-close": "::::mermaid\ngraph TD\n  A --> B\n::::",
  "container-short-close": "::::mermaid\ngraph TD\n  A --> B\n:::",
  "container-not-mermaid": ":::note\nplain text\n:::",
  // The fence matches `\\bmermaid\\b`, the container matches the first word
  // exactly -- upstream's asymmetry, which only a case like this notices.
  "container-mermaid-example": ":::mermaid-example\ngraph TD\n  A --> B\n:::",
  "container-in-list": "- item\n\n  :::mermaid\n  graph TD\n    A --> B\n  :::",
  empty: "```mermaid\n```",
  "whitespace-only": "```mermaid\n   \n```",
  "two-in-one-document": "```mermaid\ngraph TD\n  A --> B\n```\n\n```mermaid\nsequenceDiagram\n  A->>B: hi\n```",
  "same-source-twice": "```mermaid\ngraph TD\n  A --> B\n```\n\n```mermaid\ngraph TD\n  A --> B\n```",
};

/** What is inside the fence, where the two sides could diverge on their own. */
const CONTENT = {
  "html-in-label": '```mermaid\ngraph TD\n  A["<script>alert(1)</script>"] --> B\n```',
  "ampersand-in-label": '```mermaid\ngraph TD\n  A["Tom & Jerry"] --> B\n```',
  "entity-in-label": '```mermaid\ngraph TD\n  A["&amp; &lt; &gt;"] --> B\n```',
  "markup-in-label": '```mermaid\ngraph TD\n  A["<b>bold</b>"] --> B\n```',
  "cjk-label": '```mermaid\ngraph TD\n  A["繁體中文"] --> B["日本語"]\n```',
  "emoji-label": '```mermaid\ngraph TD\n  A["🚀 ship"] --> B\n```',
  "backtick-in-label": "```mermaid\ngraph TD\n  A[\"a `code` b\"] --> B\n```",
  "syntax-error": "```mermaid\ngraph TD\n  A[Start -->\n```",
  "unknown-diagram-type": "```mermaid\nnosuchdiagram\n  A --> B\n```",
  "init-directive-theme": '```mermaid\n%%{init: {"theme": "forest"}}%%\ngraph TD\n  A --> B\n```',
  "init-directive-elk": '```mermaid\n%%{init: {"layout": "elk"}}%%\ngraph TD\n  A --> B\n```',
  "flowchart-elk-header": "```mermaid\nflowchart-elk TD\n  A --> B\n```",
  // The built-in's other extra layout, registered beside elk.
  "init-directive-tidy-tree": '```mermaid\n%%{init: {"layout": "tidy-tree"}}%%\ngraph TD\n  A --> B\n```',
  "click-handler": '```mermaid\ngraph TD\n  A --> B\n  click A "https://example.com" "tooltip"\n```',
  "html-label": '```mermaid\n%%{init: {"flowchart": {"htmlLabels": true}}}%%\ngraph TD\n  A["line<br/>break"] --> B\n```',
  "large-source": `\`\`\`mermaid\ngraph TD\n${
    Array.from({ length: 400 }, (_, i) => `  n${i} --> n${i + 1}`).join("\n")
  }\n\`\`\``,
};

const CASES = [
  ...Object.entries(DIAGRAMS).map(([name, source]) => ({
    group: "diagram",
    name,
    markdown: `\`\`\`mermaid\n${source}\n\`\`\``,
  })),
  ...Object.entries(MARKDOWN).map(([name, markdown]) => ({
    group: "markdown",
    name,
    markdown,
  })),
  ...Object.entries(CONTENT).map(([name, markdown]) => ({
    group: "content",
    name,
    markdown,
  })),
];

module.exports = { CASES };

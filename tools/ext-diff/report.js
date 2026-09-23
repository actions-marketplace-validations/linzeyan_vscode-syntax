// diff.json and index.html, out of the two results.json each case set wrote.
//
// The HTML exists because the JSON alone is how this repo already missed
// things: a row that says `poly: null` is easy to read past, and the same row
// beside a picture of an unmarked character is not. Every table here puts the
// disagreements first and the agreements behind a fold, for the same reason.
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const escape = (value) =>
  String(value).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[c]);

/** A cell's text: scalars as they are, anything else as compact JSON. */
function cell(value) {
  if (value === null || value === undefined) return "<span class=none>—</span>";
  if (typeof value === "object") return `<code>${escape(JSON.stringify(value))}</code>`;
  // Invisible characters are the subject of one of these tables; printing them
  // raw would make the table as unreadable as the file.
  return escape(value).replace(
    /[^\x20-\x7e]/gu,
    (c) => `<code>U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}</code>`,
  );
}

function table(rows) {
  if (rows.length === 0) return "<p class=none>(none)</p>";
  const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const head = keys.map((key) => `<th>${escape(key)}</th>`).join("");
  const body = rows
    .map((row) =>
      `<tr class="${row.agree === false ? "differs" : ""}">${
        keys.map((key) => `<td>${cell(row[key])}</td>`).join("")
      }</tr>`
    )
    .join("\n");
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function read(file) {
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
}

function render(run, sets, skipped = {}) {
  const diff = {};
  const problems = [];
  const sections = [];
  for (const set of sets) {
    const dir = join(run, set.id);
    const manifest = read(join(dir, "manifest.json"));
    const original = read(join(dir, "original", "results.json"));
    const poly = read(join(dir, "poly", "results.json"));
    const failed = [original, poly].filter((side) => !side || side.error);
    let result;
    if (skipped[set.id]) {
      result = { problems: [`not run: ${skipped[set.id]}`] };
    } else if (failed.length > 0 || !manifest) {
      const why = [original, poly].map((side, i) =>
        side?.error ?? (side ? null : `${["original", "poly"][i]}: no results.json`)
      )
        .filter(Boolean);
      result = { problems: why.map((one) => `could not be measured: ${one.split("\n")[0]}`) };
    } else {
      try {
        result = set.diff(original, poly, manifest);
      } catch (error) {
        result = { problems: [`diff failed: ${error.stack ?? error}`] };
      }
    }
    for (const problem of result.problems ?? []) problems.push(`${set.id}: ${problem}`);
    diff[set.id] = {
      title: set.title,
      vscode: original?.vscode ?? poly?.vscode,
      extensions: { original: original?.extensions, poly: poly?.extensions },
      ...result,
    };

    const tables = Object.entries(result)
      .filter(([key, value]) =>
        Array.isArray(value) && key !== "problems" && value.every((row) => row && typeof row === "object")
      )
      .map(([key, rows]) => {
        const differing = rows.filter((row) => row.agree === false);
        const agreeing = rows.filter((row) => row.agree !== false);
        return `<h3>${escape(key)}: ${differing.length} of ${rows.length} disagree</h3>
${table(differing)}
${agreeing.length ? `<details><summary>${agreeing.length} agreeing rows</summary>${table(agreeing)}</details>` : ""}`;
      })
      .join("\n");

    const shots = new Map();
    for (const [label, side] of [["original", original], ["poly", poly]]) {
      for (const shot of side?.shots ?? []) {
        const pair = shots.get(shot.name) ?? { caption: shot.caption };
        pair[label] = `${set.id}/${label}/${shot.file}`;
        shots.set(shot.name, pair);
      }
    }
    const pictures = [...shots.entries()]
      .map(([name, pair]) =>
        `<figure><figcaption>${escape(name)} — ${escape(pair.caption ?? "")}</figcaption>
<div class=pair>
${
          ["original", "poly"].map((label) =>
            `<div><div class=label>${label}</div>${
              pair[label]
                ? `<a href="${escape(pair[label])}"><img src="${escape(pair[label])}" loading=lazy></a>`
                : "<p class=none>(no picture)</p>"
            }</div>`
          ).join("\n")
        }
</div></figure>`
      )
      .join("\n");

    sections.push(`<section id="${escape(set.id)}">
<h2>${escape(set.title)}</h2>
<p>VSCode ${escape(diff[set.id].vscode ?? "?")} · original: ${
      escape((original?.extensions ?? []).join(", ") || "-")
    } · poly: ${escape((poly?.extensions ?? []).join(", ") || "-")}</p>
${(result.problems ?? []).map((one) => `<p class=problem>!! ${escape(one)}</p>`).join("\n")}
${result.summary ? `<pre>${escape(JSON.stringify(result.summary, null, 2))}</pre>` : ""}
${(result.notes ?? []).map((one) => `<p class=note>${escape(one)}</p>`).join("\n")}
${tables}
<h3>screenshots</h3>
${pictures || "<p class=none>(none)</p>"}
</section>`);
  }

  writeFileSync(join(run, "diff.json"), `${JSON.stringify(diff, null, 2)}\n`);
  writeFileSync(
    join(run, "index.html"),
    `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>ext-diff ${escape(run.split("/").pop())}</title>
<style>
body { font: 13px/1.4 -apple-system, sans-serif; margin: 1.5em; color: #222; }
table { border-collapse: collapse; margin: .5em 0; }
td, th { border: 1px solid #ccc; padding: 2px 6px; vertical-align: top; text-align: left; }
tr.differs td { background: #fff3f0; }
code { font-size: 12px; }
.none { color: #999; }
.problem { color: #b00; font-weight: 600; }
.note { color: #555; font-style: italic; }
.pair { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.pair img { width: 100%; border: 1px solid #999; }
.label { font-weight: 600; }
figure { margin: 1em 0 2em; }
nav a { margin-right: 1em; }
</style></head><body>
<h1>poly against the extensions it replaces</h1>
<nav>${sets.map((set) => `<a href="#${escape(set.id)}">${escape(set.id)}</a>`).join("")}</nav>
${problems.map((one) => `<p class=problem>!! ${escape(one)}</p>`).join("\n")}
${sections.join("\n")}
</body></html>
`,
  );
  return { problems };
}

module.exports = { render };

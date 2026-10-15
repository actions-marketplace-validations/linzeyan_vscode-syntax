//! PowerShell and batch files, re-indented. The one engine here poly wrote
//! itself: neither language has a formatter written in Rust to embed, and
//! PowerShell's own (PSScriptAnalyzer) needs pwsh and a module installed.
//!
//! Whitespace at the start and end of a line is all it changes. Every bracket
//! still open indents a line one level -- `{` and `(` in PowerShell, `(` in
//! batch -- and a line opening with a closer sits where its bracket opened.
//! PowerShell is counted the way PSScriptAnalyzer counts, so a script the
//! PowerShell extension formatted keeps its indentation here. Nothing inside a
//! line moves: spacing around operators and where a brace sits stay as written.
//!
//! Whitespace that is content is never touched: here-strings and strings that
//! run over several lines in PowerShell; in batch the line after a trailing
//! `^`, whose leading spaces join the command, and every line's trailing
//! spaces, which `set x=a ` makes part of a value.

use anyhow::{anyhow, Result};
use poly_core::FormatOptions;

fn indent_unit(opts: FormatOptions) -> String {
    if opts.use_tabs == Some(true) {
        "\t".to_string()
    } else {
        " ".repeat(opts.indent_width.unwrap_or(4).into())
    }
}

/// The lines as written out: runs of blank lines kept to one, none at either
/// end, and a final newline.
#[derive(Default)]
struct Lines {
    out: Vec<String>,
    gap: bool,
}

impl Lines {
    fn blank(&mut self) {
        self.gap = !self.out.is_empty();
    }

    fn push(&mut self, line: String) {
        if std::mem::take(&mut self.gap) {
            self.out.push(String::new());
        }
        self.out.push(line);
    }

    fn finish(self, bom: &str, original: &str) -> Option<String> {
        let mut text = bom.to_string();
        if !self.out.is_empty() {
            text.push_str(&self.out.join("\n"));
            text.push('\n');
        }
        (text != original).then_some(text)
    }
}

fn split_bom(text: &str) -> (&str, &str) {
    match text.strip_prefix('\u{feff}') {
        Some(rest) => ("\u{feff}", rest),
        None => ("", text),
    }
}

// ── PowerShell ─────────────────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Debug)]
enum Mode {
    Single,
    Double,
    HereSingle,
    HereDouble,
    Comment,
    /// A `$(` inside a double-quoted string, until its own `)`.
    Sub,
}

struct Frame {
    mode: Mode,
    /// Parentheses open inside a `Sub`, so its `)` is told from theirs.
    depth: u32,
    line: usize,
    col: usize,
}

struct PsLine<'a> {
    text: &'a str,
    /// What the line began inside of; `None` is code.
    start: Option<Mode>,
    /// Ended inside a string, where trailing whitespace is content.
    in_string: bool,
    /// Top-level brackets in order: `true` opens, `false` closes.
    events: Vec<bool>,
    /// How many of the closes come before anything else on the line.
    leading: usize,
    /// Starts with `|`: PowerShell 7 continues a pipeline from the line above.
    pipe_first: bool,
    /// Ends with `|` or a backtick, so the statement goes on below.
    continues: bool,
    has_code: bool,
}

const SINGLE: &[char] = &['\'', '\u{2018}', '\u{2019}', '\u{201a}', '\u{201b}'];
const DOUBLE: &[char] = &['"', '\u{201c}', '\u{201d}', '\u{201e}'];

/// Every line, with where it starts and what it does to the brackets.
///
/// Brackets inside strings and comments do not count, and neither do the ones
/// inside a `$()` in a string: that string is balanced on its own. A file that
/// does not balance is refused rather than guessed at -- a quote read in the
/// wrong place is exactly how a string's content would end up re-indented.
fn lex_powershell(body: &str) -> Result<Vec<PsLine<'_>>> {
    let mut stack: Vec<Frame> = Vec::new();
    let mut brackets: Vec<(char, usize, usize)> = Vec::new();
    let mut lines = Vec::new();
    for (n, text) in body.split('\n').enumerate() {
        let chars: Vec<char> = text.chars().collect();
        let mut line = PsLine {
            text,
            start: stack.last().map(|frame| frame.mode),
            in_string: false,
            events: Vec::new(),
            leading: 0,
            pipe_first: false,
            continues: false,
            has_code: false,
        };
        let mut i = 0;
        // A here-string ends at a line that starts with its terminator, in the
        // first column, and nowhere else.
        if let Some(Frame {
            mode: mode @ (Mode::HereSingle | Mode::HereDouble),
            ..
        }) = stack.last()
        {
            let quote = if *mode == Mode::HereSingle { '\'' } else { '"' };
            if chars.first() == Some(&quote) && chars.get(1) == Some(&'@') {
                stack.pop();
                i = 2;
            } else {
                line.in_string = true;
                lines.push(line);
                continue;
            }
        }
        let mut leading = true;
        let mut last: Option<char> = None;
        let mut escaped_eol = false;
        while i < chars.len() {
            let c = chars[i];
            let next = chars.get(i + 1).copied();
            match stack.last().map(|frame| frame.mode) {
                Some(Mode::Single) => {
                    if SINGLE.contains(&c) {
                        if next.is_some_and(|n| SINGLE.contains(&n)) {
                            i += 1;
                        } else {
                            stack.pop();
                            last = Some(c);
                        }
                    }
                }
                Some(Mode::Double) => {
                    if c == '`' {
                        i += 1;
                    } else if DOUBLE.contains(&c) {
                        if next.is_some_and(|n| DOUBLE.contains(&n)) {
                            i += 1;
                        } else {
                            stack.pop();
                            last = Some(c);
                        }
                    } else if c == '$' && next == Some('(') {
                        stack.push(Frame {
                            mode: Mode::Sub,
                            depth: 0,
                            line: n,
                            col: i,
                        });
                        i += 1;
                    }
                }
                Some(Mode::Comment) => {
                    if c == '#' && next == Some('>') {
                        stack.pop();
                        i += 1;
                    }
                }
                Some(Mode::HereSingle | Mode::HereDouble) => unreachable!("handled per line"),
                top @ (None | Some(Mode::Sub)) => {
                    let top_level = top.is_none();
                    if c.is_whitespace() {
                        i += 1;
                        continue;
                    }
                    let prev = i.checked_sub(1).map(|p| chars[p]);
                    let opens = move |mode| Frame {
                        mode,
                        depth: 0,
                        line: n,
                        col: i,
                    };
                    match c {
                        // `a#b` is one bareword; a comment starts a token.
                        '#' if prev
                            .is_none_or(|p| p.is_whitespace() || "(){};,|&=".contains(p)) =>
                        {
                            break;
                        }
                        '<' if next == Some('#') => {
                            stack.push(opens(Mode::Comment));
                            i += 1;
                        }
                        '@' if next.is_some_and(|n| SINGLE.contains(&n) || DOUBLE.contains(&n))
                            && chars[i + 2..].iter().all(|ch| ch.is_whitespace()) =>
                        {
                            let single = SINGLE.contains(&next.unwrap_or_default());
                            stack.push(opens(if single {
                                Mode::HereSingle
                            } else {
                                Mode::HereDouble
                            }));
                            line.has_code = true;
                            break;
                        }
                        _ if SINGLE.contains(&c) => stack.push(opens(Mode::Single)),
                        _ if DOUBLE.contains(&c) => stack.push(opens(Mode::Double)),
                        '`' => {
                            escaped_eol = i + 1 == chars.len();
                            i += 1;
                        }
                        // `${env:ProgramFiles(x86)}`: a name, brackets and all.
                        '$' if next == Some('{') => {
                            let mut j = i + 2;
                            while j < chars.len() && chars[j] != '}' {
                                j += if chars[j] == '`' { 2 } else { 1 };
                            }
                            i = j;
                        }
                        '{' | '(' if top_level => {
                            brackets.push((c, n, i));
                            line.events.push(true);
                        }
                        '}' | ')' if top_level => {
                            let Some((open, at_line, at_col)) = brackets.pop() else {
                                return Err(anyhow!(
                                    "powershell: unmatched `{c}` at line {}, column {}",
                                    n + 1,
                                    i + 1
                                ));
                            };
                            if (open == '{') != (c == '}') {
                                return Err(anyhow!(
                                    "powershell: `{c}` at line {}, column {} closes the `{open}` from line {}, column {}",
                                    n + 1,
                                    i + 1,
                                    at_line + 1,
                                    at_col + 1
                                ));
                            }
                            line.events.push(false);
                            if leading {
                                line.leading += 1;
                            }
                        }
                        '(' => stack.last_mut().expect("in a Sub").depth += 1,
                        ')' => {
                            let frame = stack.last_mut().expect("in a Sub");
                            if frame.depth == 0 {
                                stack.pop();
                            } else {
                                frame.depth -= 1;
                            }
                        }
                        '|' if leading && last.is_none() && line.start.is_none() => {
                            line.pipe_first = true
                        }
                        _ => {}
                    }
                    if !(leading && matches!(c, '}' | ')') && top_level) {
                        leading = false;
                    }
                    line.has_code = true;
                    last = Some(c);
                }
            }
            i += 1;
        }
        line.in_string = stack.iter().any(|frame| frame.mode != Mode::Comment);
        line.continues =
            !line.in_string && (escaped_eol || (last == Some('|') && stack.is_empty()));
        lines.push(line);
    }
    if let Some(frame) = stack.last() {
        let what = match frame.mode {
            Mode::Comment => "comment",
            Mode::HereSingle | Mode::HereDouble => "here-string",
            _ => "string",
        };
        return Err(anyhow!(
            "powershell: unterminated {what} from line {}, column {}",
            frame.line + 1,
            frame.col + 1
        ));
    }
    if let Some((open, line, col)) = brackets.last() {
        return Err(anyhow!(
            "powershell: unclosed `{open}` from line {}, column {}",
            line + 1,
            col + 1
        ));
    }
    Ok(lines)
}

pub(crate) fn format_powershell(text: &str, opts: FormatOptions) -> Result<Option<String>> {
    let (bom, body) = split_bom(text);
    let unit = indent_unit(opts);
    let mut out = Lines::default();
    // Each bracket still open: the level around it when it opened (the lines
    // inside sit one deeper), and whether the statement inside runs on below
    // its line (a pipeline, a backtick). Per bracket, not per line:
    // `($x | Where-Object {` leaves two open, and its body sits two levels in.
    let mut open: Vec<(usize, bool)> = Vec::new();
    let mut top_continues = false;
    // A block comment moves with the line it starts on, so its own layout
    // survives: the opener's old leading whitespace, and its new.
    let mut comment_shift: Option<(&str, String)> = None;
    for line in lex_powershell(body)? {
        let continuing = open.last().map_or(top_continues, |(_, c)| *c);
        let mut level = open.last().map_or(0, |(l, _)| l + 1);
        let mut events = line.events.iter();
        if line.start.is_none() {
            if line.leading > 0 {
                for _ in 0..line.leading {
                    events.next();
                    level = open.pop().expect("balanced by the lexer").0;
                }
            } else if continuing || line.pipe_first {
                level += 1;
            }
        }
        let content = line.text.trim_start();
        let new_indent = unit.repeat(level);
        let written = match line.start {
            None if content.trim_end().is_empty() => None,
            None => Some(format!("{new_indent}{}", trim_end(content, line.in_string))),
            Some(Mode::Comment) => Some(match &comment_shift {
                Some((old, new)) if line.text.starts_with(old) => {
                    format!("{new}{}", trim_end(&line.text[old.len()..], line.in_string))
                }
                _ => trim_end(line.text, line.in_string).to_string(),
            }),
            Some(_) => Some(line.text.to_string()),
        };
        match written {
            Some(text) => out.push(text),
            None => out.blank(),
        }
        if line.start.is_none() {
            comment_shift = Some((&line.text[..line.text.len() - content.len()], new_indent));
        }
        let mut running = level;
        for &opens in events {
            if opens {
                open.push((running, false));
                running += 1;
            } else if let Some((outer, _)) = open.pop() {
                running = outer;
            }
        }
        if line.has_code {
            match open.last_mut() {
                Some((_, c)) => *c = line.continues,
                None => top_continues = line.continues,
            }
        }
    }
    Ok(out.finish(bom, text))
}

/// `line` without trailing whitespace, unless that whitespace is content: in a
/// string, or after a backtick, which escapes the space -- trimmed, the
/// backtick would escape the newline and join the next line on.
fn trim_end(line: &str, in_string: bool) -> &str {
    let trimmed = line.trim_end();
    if in_string || (trimmed.ends_with('`') && trimmed.len() < line.len()) {
        line
    } else {
        trimmed
    }
}

// ── batch ──────────────────────────────────────────────────────────────────

/// What one batch line does to the blocks around it.
struct BatLine {
    /// Blocks it closes, and how many of those closers lead the line.
    closes: usize,
    leading: usize,
    /// Ends with a `(` that stays open: `if … (`, `) else (`, `do (`.
    opens: bool,
    /// Ends with an unescaped `^`, so the next line is part of this command.
    continues: bool,
}

/// cmd's own reading of a line's parentheses. Inside a block any unquoted,
/// unescaped `)` ends it -- `echo b)` included -- while a `(` opens one only
/// at the start of a command, which for a block that runs on below is the
/// last thing on the line. A `(` that does not close on its line and is not
/// last is text (`echo (see below`), and a `)` with no block open is too.
fn batch_line(line: &str) -> BatLine {
    let mut found = BatLine {
        closes: 0,
        leading: 0,
        opens: false,
        continues: false,
    };
    let command = line.trim_start().trim_start_matches('@').trim_start();
    let word = command.split_whitespace().next().unwrap_or_default();
    let comment = command.starts_with(':') || word.eq_ignore_ascii_case("rem");
    let chars: Vec<char> = line.chars().collect();
    let mut quoted = false;
    let mut local = 0usize;
    let mut only_closers = true;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if quoted {
            quoted = c != '"';
        } else if c == '^' {
            found.continues = i + 1 == chars.len();
            i += 1;
        } else if !comment {
            match c {
                '"' => quoted = true,
                '(' => local += 1,
                ')' if local > 0 => local -= 1,
                ')' => {
                    found.closes += 1;
                    if only_closers {
                        found.leading += 1;
                    }
                }
                _ => {}
            }
        }
        if !c.is_whitespace() {
            found.opens = !comment && !quoted && c == '(' && local > 0;
            if c != ')' || local > 0 || comment {
                only_closers = false;
            }
        }
        i += 1;
    }
    found
}

pub(crate) fn format_batch(text: &str, opts: FormatOptions) -> Option<String> {
    let (bom, body) = split_bom(text);
    let unit = indent_unit(opts);
    let mut out = Lines::default();
    // The level of each line that opened a block still open.
    let mut open: Vec<usize> = Vec::new();
    let mut continued = false;
    let mut level = 0;
    for raw in body.split('\n') {
        let line = batch_line(raw);
        if !continued {
            level = open.last().map_or(0, |l| l + 1);
            for _ in 0..line.leading {
                if let Some(l) = open.pop() {
                    level = l;
                }
            }
        }
        let content = raw.trim_start();
        if continued {
            out.push(raw.to_string());
        } else if content.trim_end().is_empty() {
            out.blank();
        } else {
            out.push(format!("{}{content}", unit.repeat(level)));
        }
        let leading = if continued { 0 } else { line.leading };
        for _ in leading..line.closes {
            open.pop();
        }
        if line.opens {
            open.push(level);
        }
        continued = line.continues;
    }
    out.finish(bom, text)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ps(text: &str) -> String {
        let once = format_powershell(text, FormatOptions::default())
            .unwrap()
            .unwrap_or_else(|| text.to_string());
        // Every case doubles as an idempotence check: a second pass that moves
        // anything means format-on-save never settles.
        assert_eq!(
            format_powershell(&once, FormatOptions::default()).unwrap(),
            None,
            "not a fixed point:\n{once}"
        );
        once
    }

    fn bat(text: &str) -> String {
        let once = format_batch(text, FormatOptions::default()).unwrap_or_else(|| text.to_string());
        assert_eq!(
            format_batch(&once, FormatOptions::default()),
            None,
            "not a fixed point:\n{once}"
        );
        once
    }

    #[test]
    fn powershell_blocks_indent_one_level_per_open_bracket() {
        let messy = "function Get-Thing {\nparam(\n[string]$Name\n)\nif ($Name) {\n        @{\n  a = @(1,\n2)\n}\n}\n  else { $null }\n}\n";
        assert_eq!(
            ps(messy),
            "function Get-Thing {\n    param(\n        [string]$Name\n    )\n    if ($Name) {\n        @{\n            a = @(1,\n                2)\n        }\n    }\n    else { $null }\n}\n"
        );
    }

    #[test]
    fn two_brackets_left_open_on_a_line_indent_twice_as_psscriptanalyzer_does() {
        // install.ps1's shape, as the PowerShell extension formats it.
        let text = "$tag = ($releases | Where-Object {\n        -not $_.draft\n    } | Select-Object -First 1).tag_name\n";
        assert_eq!(
            ps(text),
            "$tag = ($releases | Where-Object {\n        -not $_.draft\n    } | Select-Object -First 1).tag_name\n"
        );
    }

    #[test]
    fn a_here_string_is_content_and_its_terminator_stays_in_column_one() {
        // PowerShell only ends a here-string at a `"@` in the first column;
        // indenting it would swallow the rest of the script into the string.
        let text = "if ($a) {\n$s = @\"\n  keep   \n\"@\n}\n";
        assert_eq!(ps(text), "if ($a) {\n    $s = @\"\n  keep   \n\"@\n}\n");
    }

    #[test]
    fn a_string_over_several_lines_keeps_its_whitespace() {
        let text = "if ($a) {\n$s = \"one   \n   two $(\"in\")\n  three\"\n}\n";
        assert_eq!(
            ps(text),
            "if ($a) {\n    $s = \"one   \n   two $(\"in\")\n  three\"\n}\n"
        );
    }

    #[test]
    fn a_backtick_before_trailing_space_is_not_turned_into_a_continuation() {
        assert_eq!(
            ps("Write-Host a ` \nWrite-Host b   \n"),
            "Write-Host a ` \nWrite-Host b\n"
        );
    }

    #[test]
    fn a_continued_statement_indents_once_and_ends_where_it_started() {
        let text = "Get-Item x |\nWhere-Object {\n$_\n} |\nSelect-Object `\n-First 1\n$done\n";
        assert_eq!(
            ps(text),
            "Get-Item x |\n    Where-Object {\n        $_\n    } |\n    Select-Object `\n    -First 1\n$done\n"
        );
        assert_eq!(
            ps("Get-Item x\n| Sort-Object\n"),
            "Get-Item x\n    | Sort-Object\n"
        );
    }

    #[test]
    fn a_block_comment_moves_with_its_first_line() {
        let text = "function f {\n<#\n.SYNOPSIS\n  x\n#>\n}\n";
        assert_eq!(
            ps(text),
            "function f {\n    <#\n    .SYNOPSIS\n      x\n    #>\n}\n"
        );
    }

    #[test]
    fn brackets_in_comments_strings_and_names_do_not_count() {
        let text = "# {\n$p = ${env:ProgramFiles(x86)}\n$q = '{(' + \"}\"\n$r = 1 # )\n";
        assert_eq!(ps(text), text);
    }

    #[test]
    fn powershell_that_does_not_balance_is_refused_with_a_place() {
        for (text, place) in [
            ("function f {\n  1\n", "line 1, column 12"),
            ("}\n", "line 1, column 1"),
            ("$a = (1}\n", "line 1, column 8"),
            ("$s = @\"\nnever ends\n", "line 1, column 6"),
        ] {
            let error = format_powershell(text, FormatOptions::default())
                .unwrap_err()
                .to_string();
            assert!(error.contains(place), "{text:?}: {error}");
        }
    }

    #[test]
    fn blank_lines_collapse_and_the_file_ends_in_one_newline() {
        assert_eq!(ps("\n\n$a = 1\n\n\n\n$b = 2\n\n\n"), "$a = 1\n\n$b = 2\n");
        assert_eq!(
            bat("\r\n\n@echo off\n\n\n\necho a"),
            "@echo off\n\necho a\n"
        );
    }

    #[test]
    fn indent_width_and_tabs_are_honoured_and_a_bom_stays() {
        let tabs = FormatOptions {
            use_tabs: Some(true),
            ..FormatOptions::default()
        };
        assert_eq!(
            format_powershell("\u{feff}if ($a) {\nx\n}\n", tabs)
                .unwrap()
                .unwrap(),
            "\u{feff}if ($a) {\n\tx\n}\n"
        );
        let two = FormatOptions {
            indent_width: Some(2),
            ..FormatOptions::default()
        };
        assert_eq!(
            format_batch("if x (\necho a\n)\n", two).unwrap(),
            "if x (\n  echo a\n)\n"
        );
    }

    #[test]
    fn batch_blocks_indent_and_else_lines_up_with_its_if() {
        let messy = "@echo off\nif exist a (\necho a\nfor %%f in (*.txt) do (\n  echo %%f\n    )\n) else (\necho none\n)\n";
        assert_eq!(
            bat(messy),
            "@echo off\nif exist a (\n    echo a\n    for %%f in (*.txt) do (\n        echo %%f\n    )\n) else (\n    echo none\n)\n"
        );
    }

    #[test]
    fn batch_whitespace_that_is_content_stays() {
        // `set` keeps the trailing space in the value, and a `^` joins the
        // next line on with its leading spaces.
        let text = "if x (\nset v=a \necho one ^\n   two\n)\n";
        assert_eq!(
            bat(text),
            "if x (\n    set v=a \n    echo one ^\n   two\n)\n"
        );
    }

    #[test]
    fn batch_parentheses_that_are_text_do_not_open_blocks() {
        let text = "echo (see below\necho :)\nrem if x (\n:: (\necho \"(\"\necho done (100%%)\n";
        assert_eq!(bat(text), text);
        // Inside a block, cmd ends it at any bare `)`, `echo b)` included.
        assert_eq!(
            bat("if x (\necho a\necho b)\necho c\n"),
            "if x (\n    echo a\n    echo b)\necho c\n"
        );
        // A one-line block inside a block is its own pair.
        assert_eq!(
            bat("if x (\nif y (echo a) else (echo b)\necho c\n)\n"),
            "if x (\n    if y (echo a) else (echo b)\n    echo c\n)\n"
        );
    }
}

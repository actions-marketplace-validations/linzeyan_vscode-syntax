//! Characters that are not what they look like.
//!
//! A replacement for the editor decorations people install for this (gremlins
//! and its kind), written as a lint rule instead so that the CLI, CI and the
//! editor give one answer. A decoration that only exists in one person's editor
//! catches exactly the files that person opens.
//!
//! # What is reported, and the line that decides it
//!
//! The rule is **confusable with an ASCII character, or invisible** -- not
//! "non-ASCII". That distinction is the whole design, and it was measured
//! rather than guessed: this repository contains 1,504 EM DASH and 3 EN DASH.
//! An em dash is standard prose punctuation and is not mistakable for anything
//! on a keyboard, so reporting it would mean 1,504 findings in poly's own
//! `make dogfood` and a rule nobody could leave switched on. An en dash is a
//! hyphen's width and sits where a `-` belongs, so it is worth a word.
//!
//! The same line puts CJK punctuation, accented Latin, and every script used to
//! write prose out of scope. None of them impersonates ASCII.
//!
//! # Why the five codes are separate
//!
//! They are five different claims with five different answers. A zero-width
//! space in an identifier is a bug; one in a test fixture is the fixture. A
//! bidirectional override is the Trojan Source attack; it is also how you write
//! a test for the Trojan Source attack. Splitting them means `poly: ignore
//! poly/unicode-bidi` on the fixture leaves the other four reporting.

use poly_core::diag::{Issue, Severity};

/// What each code reports, and the prose `lint::rule_doc` serves for it.
///
/// All five at `Warning` and not by accident: the catalog gate requires one
/// severity per category, and warning is the right one by this repository's own
/// definition -- "suspicious, and possibly deliberate. Somebody should look."
/// Every code here is deliberate somewhere. A bidi override is an attack in
/// application source and a fixture in a test suite, and nothing in the bytes
/// tells the two apart.
pub const RULES: &[(&str, Severity, &str)] = &[
    (
        "unicode-bidi",
        Severity::Warning,
        "A bidirectional formatting control. These reorder how the rest of the \
         line is displayed without changing a byte of what the compiler reads, \
         which is the Trojan Source attack (CVE-2021-42574): a reviewer sees \
         one program and the toolchain builds another. Nothing in ordinary \
         source needs one -- a right-to-left language renders correctly from \
         its own characters -- so the honest uses are test fixtures and \
         documentation about this very problem.",
    ),
    (
        "unicode-invisible",
        Severity::Warning,
        "A character that draws nothing, or nothing that says what it is: a \
         zero-width space, a control code, the placeholder a rich-text paste \
         leaves where an image was. It survives copy and paste, it makes two \
         identifiers that look identical compare unequal, and reading the line \
         will not tell you what it is. LINE SEPARATOR and PARAGRAPH SEPARATOR \
         do one thing more: JavaScript and `str.splitlines` end a line at them \
         and LSP, git and `grep` do not, so two tools reading one file \
         disagree about which line they are on. A byte order mark is exempt at \
         the very start of a file, where it is a legitimate encoding marker, \
         and reported anywhere else, where it arrived by concatenation.",
    ),
    (
        "unicode-lookalike",
        Severity::Warning,
        "A character that occupies the place of an ASCII one and reads as it: \
         an EN DASH where a hyphen belongs, a typographic quote where a string \
         delimiter belongs. Usually pasted in from a word processor, a web \
         page or a chat client, and usually harmless right up to the point \
         where something tries to parse it. EM DASH is deliberately not here: \
         it is prose punctuation, it is visibly not a hyphen, and reporting it \
         would bury every real finding.",
    ),
    (
        "unicode-mixed-script",
        Severity::Warning,
        "One word written in two alphabets -- a Cyrillic `а` or a Greek `ο` \
         among Latin letters. The word renders identically to its all-Latin \
         twin and is a different string to every comparison, so a lookup \
         fails, a branch is never taken, or two definitions that look like one \
         quietly coexist. Reported only for a word that mixes scripts: text \
         written wholly in Cyrillic or Greek is text, not a confusable.",
    ),
    (
        "unicode-space",
        Severity::Warning,
        "A space that is not a space: a no-break space, a thin space, an \
         ideographic space. It looks like the separator either side of it and \
         is a different character to every tokenizer, so an indented line is \
         not indented, a command-line argument is one word, and a YAML key \
         stops being a key.",
    ),
];

/// The invisible ones. No width, no ink, nothing an editor renders.
///
/// U+FEFF is here and handled specially by the caller: as the first character
/// of a file it is a byte order mark and belongs there.
///
/// Five members are here for parity with the table gremlins ships by default,
/// which is what this rule replaces -- someone who uninstalls gremlins for
/// poly should not lose a squiggle they had. END OF TEXT, LINE TABULATION,
/// PARAGRAPH SEPARATOR and OBJECT REPLACEMENT CHARACTER are gremlins' own;
/// LINE SEPARATOR is not, and is here as PARAGRAPH SEPARATOR's twin: the two
/// are one hazard, and reporting one of them would be a gap nobody could
/// explain.
///
/// This code rather than another, because none of them impersonates an ASCII
/// character, which is what `-lookalike` and `-space` both claim. LINE
/// TABULATION comes closest to `-space` and still is not one: it is ASCII, and
/// every tokenizer that knows a tab knows it as whitespace too -- `-space` is
/// about the characters a tokenizer does *not* split on. What all five share
/// with the rest of this list is that they draw nothing, or draw a stand-in
/// that does not say what they are, which is why the rule's prose reads that
/// way rather than "no width": U+FFFC is a visible box in the fonts that have
/// it.
///
/// The two separators carry one harm more. JavaScript treats them as line
/// terminators and Python's `str.splitlines` does too (it splits at LINE
/// TABULATION as well), while LSP, git and `grep` count only `\n`, `\r\n` and
/// `\r` -- so a finding after one is on a different line depending on who is
/// counting. This module counts `\n`, which is the editor's answer and the one
/// the squiggle has to agree with.
///
/// Measured before adding them, the way the rest of this module was: this
/// repository has none of the five, and the 46,374 text files of the
/// differential corpus have two -- both U+FFFC, both in a comment explaining
/// the placeholder Signal puts where a mention goes. That is the deliberate
/// kind of finding the module header describes, and it is what `poly: ignore`
/// is for.
const INVISIBLE: &[char] = &[
    '\u{0003}', // END OF TEXT
    '\u{000B}', // LINE TABULATION
    '\u{00AD}', // SOFT HYPHEN
    '\u{061C}', // ARABIC LETTER MARK
    '\u{180E}', // MONGOLIAN VOWEL SEPARATOR
    '\u{200B}', // ZERO WIDTH SPACE
    '\u{200C}', // ZERO WIDTH NON-JOINER
    '\u{200D}', // ZERO WIDTH JOINER
    '\u{200E}', // LEFT-TO-RIGHT MARK
    '\u{200F}', // RIGHT-TO-LEFT MARK
    '\u{2028}', // LINE SEPARATOR
    '\u{2029}', // PARAGRAPH SEPARATOR
    '\u{2060}', // WORD JOINER
    '\u{FEFF}', // ZERO WIDTH NO-BREAK SPACE / BYTE ORDER MARK
    '\u{FFFC}', // OBJECT REPLACEMENT CHARACTER
];

/// The bidirectional overrides and isolates, which is the whole Trojan Source
/// set. Separate from `INVISIBLE` although they are also invisible, because
/// what they do is not "nothing" -- they reorder everything after them.
const BIDI: &[char] = &[
    '\u{202A}', // LEFT-TO-RIGHT EMBEDDING
    '\u{202B}', // RIGHT-TO-LEFT EMBEDDING
    '\u{202C}', // POP DIRECTIONAL FORMATTING
    '\u{202D}', // LEFT-TO-RIGHT OVERRIDE
    '\u{202E}', // RIGHT-TO-LEFT OVERRIDE
    '\u{2066}', // LEFT-TO-RIGHT ISOLATE
    '\u{2067}', // RIGHT-TO-LEFT ISOLATE
    '\u{2068}', // FIRST STRONG ISOLATE
    '\u{2069}', // POP DIRECTIONAL ISOLATE
];

/// Spaces that are not `U+0020`, with the ASCII they impersonate.
///
/// Tab and newline are absent: they are ASCII, a tokenizer knows them, and
/// whether a file should contain tabs is a formatter's question.
const SPACES: &[char] = &[
    '\u{00A0}', // NO-BREAK SPACE
    '\u{1680}', // OGHAM SPACE MARK
    '\u{2000}', // EN QUAD
    '\u{2001}', // EM QUAD
    '\u{2002}', // EN SPACE
    '\u{2003}', // EM SPACE
    '\u{2004}', // THREE-PER-EM SPACE
    '\u{2005}', // FOUR-PER-EM SPACE
    '\u{2006}', // SIX-PER-EM SPACE
    '\u{2007}', // FIGURE SPACE
    '\u{2008}', // PUNCTUATION SPACE
    '\u{2009}', // THIN SPACE
    '\u{200A}', // HAIR SPACE
    '\u{202F}', // NARROW NO-BREAK SPACE
    '\u{205F}', // MEDIUM MATHEMATICAL SPACE
    '\u{3000}', // IDEOGRAPHIC SPACE
];

/// Characters that sit where an ASCII one belongs, and the ASCII they stand in
/// for -- which is what the message quotes, because "use `-`" is the whole
/// remedy and a codepoint number is not.
///
/// The test for membership is *renders nearly identically at normal size*, and
/// it was drawn where the measurement put it. Reporting every non-ASCII
/// punctuation mark gives 1,162 findings over this repository; reporting only
/// the ones that impersonate ASCII gives 22, and the difference is entirely
/// correct typography in somebody's prose:
///
/// - Fullwidth comma, colon and semicolon (U+FF0C, U+FF1A, U+FF1B): 1,124 of
///   them, and every one is the right punctuation mark for the Chinese
///   sentence it is in. They are double-width; nobody mistakes one for `,`.
/// - Guillemets (U+00AB, U+00BB): 16, and they are French quotation marks.
/// - EM DASH (U+2014): 1,504, and it is prose punctuation that looks nothing
///   like a hyphen. See the module header.
///
/// What is left impersonates ASCII in a monospace font at 13px, which is the
/// only condition under which this rule is telling anyone something they could
/// not see. HORIZONTAL BAR (U+2015) is in: it is a quotation dash, nobody types
/// it by accident, and unlike an em dash it turns up in pasted output where a
/// `-` was meant.
const LOOKALIKE: &[(char, char)] = &[
    ('\u{037E}', ';'),  // GREEK QUESTION MARK
    ('\u{2010}', '-'),  // HYPHEN
    ('\u{2011}', '-'),  // NON-BREAKING HYPHEN
    ('\u{2012}', '-'),  // FIGURE DASH
    ('\u{2013}', '-'),  // EN DASH
    ('\u{2015}', '-'),  // HORIZONTAL BAR
    ('\u{2018}', '\''), // LEFT SINGLE QUOTATION MARK
    ('\u{2019}', '\''), // RIGHT SINGLE QUOTATION MARK
    ('\u{201A}', '\''), // SINGLE LOW-9 QUOTATION MARK
    ('\u{201B}', '\''), // SINGLE HIGH-REVERSED-9 QUOTATION MARK
    ('\u{201C}', '"'),  // LEFT DOUBLE QUOTATION MARK
    ('\u{201D}', '"'),  // RIGHT DOUBLE QUOTATION MARK
    ('\u{201E}', '"'),  // DOUBLE LOW-9 QUOTATION MARK
    ('\u{201F}', '"'),  // DOUBLE HIGH-REVERSED-9 QUOTATION MARK
    ('\u{2032}', '\''), // PRIME
    ('\u{2033}', '"'),  // DOUBLE PRIME
    ('\u{2044}', '/'),  // FRACTION SLASH
    ('\u{2215}', '/'),  // DIVISION SLASH
];

/// Which alphabet a letter belongs to, for the one question `mixed_script`
/// asks: does this word use more than one?
///
/// Three buckets and not a full script table, because only three of them are
/// mutually confusable at the letter level. Anything else -- CJK, Arabic,
/// Devanagari -- answers `None` and takes no part: a word of Han characters is
/// not impersonating a Latin one.
#[derive(PartialEq, Eq, Clone, Copy)]
enum Script {
    Latin,
    Cyrillic,
    Greek,
}

fn script_of(c: char) -> Option<Script> {
    // Letters only. The ranges below are Unicode *blocks*, and a block holds
    // more than its alphabet: U+037E GREEK QUESTION MARK sits inside the Greek
    // block and is a semicolon, so without this `a;b` written with it is one
    // word in two scripts rather than the lookalike it actually is.
    if !c.is_alphabetic() {
        return None;
    }
    match c {
        'A'..='Z' | 'a'..='z' => Some(Script::Latin),
        '\u{0370}'..='\u{03FF}' | '\u{1F00}'..='\u{1FFF}' => Some(Script::Greek),
        '\u{0400}'..='\u{04FF}' | '\u{0500}'..='\u{052F}' => Some(Script::Cyrillic),
        _ => None,
    }
}

/// Every suspicious character in `text`, as findings.
///
/// Takes text rather than a path because the caller already decided this is
/// text: `lint::unicode` does the reading, the binary check and the UTF-16
/// decode, exactly as it does for spelling.
///
/// One pass, counting lines as it goes, so a 40MB file costs one walk rather
/// than one per rule.
pub fn check(text: &str) -> Vec<Issue> {
    let mut found = Vec::new();
    let mut line = 0u32;
    let mut col = 0u32;
    // A word being accumulated for the mixed-script question: where it started
    // and which alphabets it has used. Flushed at the first character that
    // cannot be part of a word.
    let mut word: Option<(u32, u32, Script, bool)> = None;

    for (offset, c) in text.char_indices() {
        // A byte order mark is a byte order mark only at the very start.
        // Anywhere else it arrived by concatenating two files and is invisible
        // junk in the middle of one.
        let bom = c == '\u{FEFF}' && offset == 0;

        if let Some(script) = script_of(c) {
            word = Some(match word {
                Some((at_line, at_col, first, mixed)) => {
                    (at_line, at_col, first, mixed || script != first)
                }
                None => (line, col, script, false),
            });
        } else if !c.is_ascii_digit() && c != '_' {
            // Digits and underscores continue a word without belonging to a
            // script, so this is one word rather than three:
            // poly: ignore poly/unicode-mixed-script
            //   user_имя2
            if let Some((at_line, at_col, _, true)) = word {
                found.push(issue(
                    at_line,
                    at_col,
                    col,
                    "unicode-mixed-script",
                    "this word is written in two alphabets, so it is a \
                     different string from the one it looks like"
                        .to_string(),
                ));
            }
            word = None;
        }

        let claim = if BIDI.contains(&c) {
            Some((
                "unicode-bidi",
                format!(
                    "U+{:04X} reorders how the rest of this line is displayed \
                     without changing what is compiled",
                    c as u32
                ),
            ))
        } else if !bom && INVISIBLE.contains(&c) {
            // Not "is invisible": U+FFFC draws a box and VSCode draws a control
            // picture for U+0003, and a message contradicting what is on screen
            // reads as a false positive. Neither of them draws *itself*.
            Some((
                "unicode-invisible",
                format!("U+{:04X} does not render as what it is", c as u32),
            ))
        } else if SPACES.contains(&c) {
            Some((
                "unicode-space",
                format!(
                    "U+{:04X} looks like a space and is not one, so nothing \
                     splitting on whitespace will split here",
                    c as u32
                ),
            ))
        } else {
            LOOKALIKE.iter().find(|(ch, _)| *ch == c).map(|(_, ascii)| {
                (
                    "unicode-lookalike",
                    format!("U+{:04X} reads as `{ascii}` and is not `{ascii}`", c as u32),
                )
            })
        };
        if let Some((code, message)) = claim {
            found.push(issue(line, col, col + 1, code, message));
        }

        if c == '\n' {
            line += 1;
            col = 0;
        } else {
            col += 1;
        }
    }
    // A word running to the end of the file never meets a separator.
    if let Some((at_line, at_col, _, true)) = word {
        found.push(issue(
            at_line,
            at_col,
            col,
            "unicode-mixed-script",
            "this word is written in two alphabets, so it is a different \
             string from the one it looks like"
                .to_string(),
        ));
    }
    found
}

fn issue(line: u32, col: u32, end_col: u32, code: &str, message: String) -> Issue {
    Issue {
        line,
        col,
        end_line: line,
        end_col,
        severity: crate::lint::rule_severity(code),
        code: code.to_string(),
        message,
        // poly's own rules, under poly's own name -- the same source every
        // `poly/` finding carries, so `rule_doc` can find the prose above.
        source: "poly",
        fix: None,
        url: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn codes(text: &str) -> Vec<String> {
        check(text).into_iter().map(|i| i.code).collect()
    }

    /// One fixture per code, which is the claim each one makes on its own.
    #[test]
    fn each_class_is_reported_under_its_own_code() {
        assert_eq!(codes("let a\u{200B}b = 1;\n"), ["unicode-invisible"]);
        assert_eq!(codes("// \u{202E}reversed\n"), ["unicode-bidi"]);
        assert_eq!(codes("a\u{00A0}b\n"), ["unicode-space"]);
        assert_eq!(codes("--flag\u{2013}name\n"), ["unicode-lookalike"]);
        // poly: ignore poly/unicode-mixed-script
        // `pаssword`, with a Cyrillic а where the Latin one belongs.
        assert_eq!(codes("p\u{0430}ssword\n"), ["unicode-mixed-script"]);
    }

    /// The measurement that set the rule's boundary, as a test: EM DASH is
    /// prose and stays silent, EN DASH sits where a hyphen belongs and does
    /// not. This repository has 1,504 of the first and 3 of the second.
    #[test]
    fn em_dash_is_prose_and_en_dash_is_a_hyphen() {
        assert_eq!(codes("one \u{2014} two\n"), Vec::<String>::new());
        assert_eq!(codes("one \u{2013} two\n"), ["unicode-lookalike"]);
    }

    /// The other half of the same boundary, and the one that decides whether
    /// this rule can be left switched on in a repository whose documentation is
    /// written in Chinese. A fullwidth comma is the correct comma for the
    /// sentence it is in, it is twice the width of `,`, and there are 1,124 of
    /// them here. Reporting them is the difference between 22 findings and
    /// 1,162.
    #[test]
    fn cjk_and_european_punctuation_is_punctuation() {
        assert_eq!(codes("一，二：三；四\n"), Vec::<String>::new());
        assert_eq!(codes("« French »\n"), Vec::<String>::new());
        // The characters that do impersonate ASCII, for contrast.
        assert_eq!(codes("a\u{037E}b\n"), ["unicode-lookalike"]);
    }

    /// A BOM is an encoding marker where it belongs and junk everywhere else.
    /// Without the position check every UTF-8-with-BOM file in a repository
    /// would open with a finding about its own first byte.
    #[test]
    fn a_byte_order_mark_is_only_a_marker_at_the_start() {
        assert_eq!(codes("\u{FEFF}{}\n"), Vec::<String>::new());
        assert_eq!(codes("{}\u{FEFF}\n"), ["unicode-invisible"]);
    }

    /// This rule replaces gremlins, so what gremlins flags out of the box has
    /// to be flagged here, or uninstalling it for poly loses a squiggle the
    /// user had. LINE SEPARATOR is not in gremlins' table and is here as
    /// PARAGRAPH SEPARATOR's twin; EM DASH is in neither, and stays prose.
    #[test]
    fn what_gremlins_flags_by_default_is_flagged_here() {
        for c in ['\u{0003}', '\u{000B}', '\u{2028}', '\u{2029}', '\u{FFFC}'] {
            assert_eq!(
                codes(&format!("a{c}b\n")),
                ["unicode-invisible"],
                "U+{:04X}",
                c as u32
            );
        }
        // A separator ends a line for JavaScript and not for LSP, and the
        // squiggle is drawn by LSP's count: a finding after one stays on the
        // line the editor shows it on.
        let found = check("a\u{2028}b\u{200B}\n");
        let at: Vec<_> = found.iter().map(|i| (i.line, i.col)).collect();
        assert_eq!(at, [(0, 1), (0, 3)]);
    }

    /// Text in one script is text. The rule is about a word that uses two, and
    /// a version that merely looked for "a Cyrillic letter" would report every
    /// Russian comment in the file.
    #[test]
    fn one_script_per_word_is_not_a_confusable() {
        assert_eq!(codes("// пароль значение\n"), Vec::<String>::new());
        assert_eq!(codes("// αριθμός\n"), Vec::<String>::new());
        // Two words, each in one script, next to each other.
        assert_eq!(codes("let пароль = password;\n"), Vec::<String>::new());
    }

    /// Digits and underscores continue a word rather than breaking it, so a
    /// mixed identifier is reported once and at its start rather than as two
    /// clean halves.
    #[test]
    fn an_identifier_is_one_word_through_digits_and_underscores() {
        let found = check("user_\u{0438}mya2 = 1\n");
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].code, "unicode-mixed-script");
        assert_eq!((found[0].line, found[0].col), (0, 0));
    }

    /// Positions are what an editor puts a squiggle on, so they are worth their
    /// own test. A column counts *characters*, which is what `line_col` counts
    /// everywhere else in poly -- the six bytes of `日本` are two columns, and
    /// the no-break space is the eighth character of the second line.
    #[test]
    fn positions_count_characters_and_lines() {
        let found = check("ok\n// 日本 a\u{00A0}b\n");
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!((found[0].line, found[0].col, found[0].end_col), (1, 7, 8));
    }

    /// Every code this module can emit is in `RULES`, and every rule in
    /// `RULES` is one it can emit. Either half being wrong leaves a finding
    /// with no documentation or a documented rule nobody can trigger.
    #[test]
    fn every_code_emitted_is_a_documented_rule() {
        let fixtures = [
            "a\u{200B}b",
            "a\u{202E}b",
            "a\u{00A0}b",
            "a\u{2013}b",
            "p\u{0430}ssword",
        ];
        let mut emitted: Vec<String> = fixtures.iter().flat_map(|f| codes(f)).collect();
        emitted.sort();
        emitted.dedup();
        let mut documented: Vec<String> = RULES.iter().map(|(code, ..)| code.to_string()).collect();
        documented.sort();
        assert_eq!(emitted, documented);
    }
}

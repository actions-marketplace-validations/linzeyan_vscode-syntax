// The heading texts both slugifiers are asked about.
//
// Two halves. The fixed one is every rule `markdown.ts` claims to implement,
// one case each, so a failure names the rule it broke. The generated one is
// there because the fixed half can only contain the cases somebody thought of,
// and the slugifier's surface is punctuation tables copied by hand -- the
// characters nobody thought of are exactly where a transcription goes wrong.
//
// Seeded: a finding has to be reproducible, and a green run has to mean the
// same thing twice.
const SEED = Number(process.env.POLY_TOC_SEED ?? 20260920);
const ROUNDS = Number(process.env.POLY_TOC_ROUNDS ?? 400);

/** Deterministic PRNG. */
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One case per rule the module states, in the words of the module. */
const STATED = [
  "Hello, World!",
  "**bold** and `code`",
  "_underscored_",
  "__double underscored__",
  "snake_case_stays",
  "_leading and trailing_",
  "a_b_c",
  "[label](target)",
  "[label](target) and text",
  "  leading and trailing  ",
  "multiple     spaces",
  "trailing #",
  "Closed ###",
  "中文標題",
  "中文，標點",
  "日本語　全角スペース",
  "한국어 제목",
  "emoji 😀 heading",
  "combining é and é",
  "ligature ﬁle",
  "-leading-hyphen",
  "trailing-hyphen-",
  "---",
  "...",
  "123",
  "a.b.c",
  "a/b/c",
  "a\\b\\c",
  "<script>alert(1)</script>",
  "&amp; entity",
  "&lt;not a tag&gt;",
  "tab\tseparated",
  "non breaking",
  "zero​width",
  "rtl ‮mark",
  "math $x^2$",
  "em — dash",
  "en – dash",
  "quote “curly”",
  "apostrophe ’s",
  "Ｆｕｌｌｗｉｄｔｈ",
  "half width ｶﾀｶﾅ",
  "ÅÄÖ åäö",
  "ß and SS",
  "Ⅻ roman",
  "½ fraction",
  "ﬀ ligature",
  "a" + "́".repeat(5),
];

/**
 * The characters the two tables disagree about, if they disagree.
 *
 * Every character `PUNCTUATION` drops is in here, plus the ones around it: a
 * transcribed table goes wrong by dropping one character too many or one too
 * few, and neither shows up unless the character is asked about.
 */
const ALPHABET = [
  ..."[]!/'\"#$%&()*+,.:;<=>?@\\^{|}~`",
  ..."。，、；：？！…—·ˉ¨‘’“”々～‖∶＂＇｀｜〃〔〕〈〉《》「」『』．〖〗【】（）［］｛｝",
  ..."-_ \t",
  ..."abZ09",
  " ",
  "​",
  "‮",
  "😀",
  "́",
  "中",
  "ｱ",
];

function generated() {
  const rand = random(SEED);
  const texts = [];
  for (let round = 0; round < ROUNDS; round++) {
    const length = 1 + Math.floor(rand() * 8);
    let text = "";
    for (let i = 0; i < length; i++) {
      text += ALPHABET[Math.floor(rand() * ALPHABET.length)];
    }
    texts.push(text);
  }
  return texts;
}

exports.HEADINGS = [...STATED, ...generated()];

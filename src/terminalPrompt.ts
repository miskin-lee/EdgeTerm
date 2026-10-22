import { isShellPrompt } from "./semanticColors";

// Which lines count as "the program is waiting for the next line" when a
// command is followed to completion (the Sender sends a script's next line
// only then). Shell prompts are the semantic-coloring vocabulary; the two
// families below change the prompt on every line, so the prompt the line was
// sent from never comes back (issue #110: each line waited out the Sender's
// 30 s timeout). They are only ever matched against a whole line ending at
// the cursor, never colored: as a line prefix, `[INFO]` and `[OK]` in plain
// output would read as prompts.

/**
 * A REPL in the middle of a statement, asking for its next line. Each of
 * these prints a space after the prompt, and the space is required.
 */
const CONTINUATION_PROMPTS = [
  // SQL*Plus and SQLcl number the lines of a statement (`  2  `); RMAN `2> `.
  /^\s*\d+>?\s+$/,
  // Python, node and mongosh `... `, sqlite `   ...> `, beeline `. . . .> `.
  /^\s*(?:\.\s?){3,}>?\s$/,
  // MySQL and MariaDB `    -> `, `    '> `, `   /*> `; Hive `    > `.
  /^\s*(?:->|['"`]>|\/\*>|>)\s$/,
  // psql, whose prompt marks what is open: `postgres=# `, `postgres-# `,
  // `postgres(# `, `app=> `, `app=*# ` inside a transaction.
  /^[\w.-]+[=\-*'"$(^!][*!?]?[#>]\s$/,
];

/**
 * Network device CLIs, whose prompt names the view a configuration command
 * just entered. Names with spaces are not matched.
 */
const DEVICE_PROMPTS = [
  // Huawei and H3C user view `<HUAWEI>`.
  /^<[^<>\s]+>\s?$/,
  // Their system view and sub-views `[HUAWEI]`,
  // `[HUAWEI-GigabitEthernet0/0/1]`, with two-stage commit `[~HUAWEI]`.
  /^\[[~*]?[^[\]\s]+\]\s?$/,
  // Cisco, Ruijie and ZTE `Switch>`, `Router(config-if)#`,
  // `Ruijie(config-if-GigabitEthernet 0/1)#`; Junos `user@router# `.
  /^[\w.@-]+(?:\([^()]+\))?[#>]\s?$/,
];

/**
 * True when `text`, a line up to the cursor, holds a prompt alone: a shell
 * prompt, a REPL's continuation prompt or a network device prompt.
 */
export function isInputPrompt(text: string): boolean {
  // Appending a space lets a compact bare prompt such as `$` satisfy the
  // same look-ahead rule as `$ command` in semantic coloring.
  if (isShellPrompt(`${text} `)) return true;
  return [...CONTINUATION_PROMPTS, ...DEVICE_PROMPTS].some((prompt) =>
    prompt.test(text),
  );
}

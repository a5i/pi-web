"use strict";

// Terminal helpers for the launcher, ported from pi-pocket's term.ts: colors,
// raw-mode key parsing, an arrow-key menu, a yes/no question, and QR lines.
// Everything here is interactive-only: nothing runs unless stdin and stdout
// are both a TTY, so background launches never block on a menu.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const os = require("os");

const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
const colors = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;

const style = (open, close) => (text) =>
  colors ? `\x1b[${open}m${text}\x1b[${close}m` : text;

const bold = style("1", "22");
const dim = style("2", "22");
const accent = style("38;5;209", "39");
const green = style("32", "39");
const yellow = style("33", "39");
const red = style("31", "39");

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

function visibleLength(text) {
  return text.replace(ANSI, "").length;
}

function columns() {
  return process.stdout.columns || 80;
}

/** Cut plain text to fit `width` columns. */
function cut(text, width) {
  if (width <= 1) {
    return "";
  }

  return text.length <= width ? text : `${text.slice(0, width - 1)}…`;
}

/** `~/...` for paths under the home directory, like pi-pocket shows them. */
function tilde(value, home = os.homedir()) {
  return value === home ? "~" : value.startsWith(`${home}/`) ? `~${value.slice(home.length)}` : value;
}

// ─── Keys ───────────────────────────────────────────────────────────────

const keyListener = { current: undefined };
let raw = false;

function parseKeys(data) {
  const keys = [];

  for (let index = 0; index < data.length;) {
    const rest = data.slice(index);

    if (rest.startsWith("\x1b[A") || rest.startsWith("\x1bOA")) {
      keys.push("up");
      index += 3;
    } else if (rest.startsWith("\x1b[B") || rest.startsWith("\x1bOB")) {
      keys.push("down");
      index += 3;
    } else if (/^\x1b\[[0-9;]*[A-Za-z~]/.test(rest)) {
      index += /^\x1b\[[0-9;]*[A-Za-z~]/.exec(rest)[0].length;
    } else if (rest[0] === "\x1b") {
      keys.push("escape");
      index += 1;
    } else if (rest[0] === "\r" || rest[0] === "\n") {
      keys.push("enter");
      index += 1;
    } else if (rest[0] === "\x03") {
      keys.push("ctrl-c");
      index += 1;
    } else {
      keys.push(rest[0]);
      index += 1;
    }
  }

  return keys;
}

/** Send key presses to `next` (or nowhere). The terminal is in raw mode from the first call until `restoreTerminal()`. */
function onKeys(next) {
  const previous = keyListener.current;
  keyListener.current = next;

  if (!interactive || raw) {
    return previous;
  }

  raw = true;
  process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (data) => {
    for (const key of parseKeys(data)) {
      keyListener.current?.(key);
    }
  });
  process.stdin.resume();

  return previous;
}

function restoreTerminal() {
  if (raw) {
    process.stdin.setRawMode(false);
    process.stdin.pause();
    raw = false;
  }

  if (process.stdout.isTTY) {
    process.stdout.write("\x1b[?25h");
  }
}

// ─── A menu picked with the arrow keys ──────────────────────────────────

/** A menu picked with the arrow keys (or number keys). Resolves to the chosen index, or undefined on Escape or q. */
function choose(title, choices, initial) {
  return new Promise((resolve) => {
    const enabled = (index) =>
      choices[index] !== undefined && choices[index].disabled !== true;
    let index = enabled(initial) ? initial : choices.findIndex((_, each) => enabled(each));
    let drawn = 0;
    const labelWidth = Math.max(...choices.map((choice) => visibleLength(choice.label)));

    const draw = () => {
      const width = columns();
      const lines = [`  ${bold(title)}`, ""];

      choices.forEach((choice, each) => {
        const selected = each === index;
        const pointer = selected ? accent("❯") : " ";
        const label = choice.label.padEnd(labelWidth + Math.max(0, visibleLength(choice.label) - choice.label.length));
        const room = width - 4 - labelWidth - 3;
        const detail = room >= 10 ? cut(choice.detail, room) : "";
        const shownLabel = choice.disabled ? dim(label) : selected ? bold(label) : label;

        lines.push(`  ${pointer} ${shownLabel}   ${dim(detail)}`);
      });
      lines.push("", dim(`  ${cut("↑↓ choose · enter select · esc cancel", width - 3)}`));

      if (drawn > 0) {
        process.stdout.write(`\x1b[${drawn}A\x1b[0J`);
      }

      process.stdout.write(`${lines.join("\n")}\n`);
      drawn = lines.length;
    };

    const move = (step) => {
      for (let next = index + step; next >= 0 && next < choices.length; next += step) {
        if (enabled(next)) {
          index = next;

          return;
        }
      }
    };

    process.stdout.write("\x1b[?25l");
    draw();
    const previous = onKeys((key) => {
      if (key === "up" || key === "k") {
        move(-1);
      } else if (key === "down" || key === "j") {
        move(1);
      } else if (/^[1-9]$/.test(key) && enabled(Number(key) - 1)) {
        index = Number(key) - 1;
      } else if (key === "enter") {
        return finish(index);
      } else if (key === "escape" || key === "q" || key === "ctrl-c") {
        return finish(undefined);
      }

      draw();
    });

    function finish(result) {
      onKeys(previous);
      process.stdout.write("\x1b[?25h");
      resolve(result);
    }
  });
}

/** A yes/no question answered with y/n (enter takes the default). */
function confirm(question, defaultYes = true) {
  return new Promise((resolve) => {
    const suffix = defaultYes ? "[Y/n]" : "[y/N]";
    process.stdout.write(`  ${bold(question)} ${dim(suffix)} `);

    const previous = onKeys((key) => {
      if (key === "y") {
        return finish(true);
      }
      if (key === "n") {
        return finish(false);
      }
      if (key === "enter") {
        return finish(defaultYes);
      }
      if (key === "escape" || key === "q" || key === "ctrl-c") {
        return finish(undefined);
      }
    });

    function finish(result) {
      onKeys(previous);
      process.stdout.write(`\x1b[K\n`);
      resolve(result);
    }
  });
}

module.exports = {
  accent,
  bold,
  choose,
  columns,
  confirm,
  cut,
  dim,
  green,
  interactive,
  onKeys,
  red,
  restoreTerminal,
  tilde,
  visibleLength,
  yellow,
};

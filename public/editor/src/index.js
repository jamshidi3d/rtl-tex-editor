/* RTL TeX Editor — CodeMirror 6 bundle entry.
 *
 * esbuild bundles this to public/editor/cm6.bundle.js as an IIFE that sets
 * `window.RTLCM`. app.js consumes only `RTLCM.create(...)` plus a few
 * re-exported primitives.
 *
 * Why CM6: it does per-line base direction natively
 * (`EditorView.perLineTextDirection`) and lets range decorations declare
 * themselves as bidi isolates (`bidiIsolate` spec field + the
 * `EditorView.bidiIsolatedRanges` facet). Together those make a `\command`,
 * `$…$` or `{…}` inside a right-to-left Persian line read left-to-right while
 * the sentence around it still reads RTL — with the caret and selection
 * geometry staying correct, which CM5 could never do.
 */
import {
  EditorState, EditorSelection, Compartment, Prec,
  StateEffect, StateField, RangeSetBuilder,
} from '@codemirror/state';
import {
  EditorView, Decoration, ViewPlugin, keymap, lineNumbers,
  highlightActiveLine, highlightActiveLineGutter, Direction,
} from '@codemirror/view';
import {
  defaultKeymap, history, historyKeymap, indentMore, indentLess,
} from '@codemirror/commands';
import {
  StreamLanguage, HighlightStyle, syntaxHighlighting,
  bracketMatching, indentUnit,
} from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import {
  autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap,
  snippetCompletion,
} from '@codemirror/autocomplete';
import { search, searchKeymap } from '@codemirror/search';
import { tags as t } from '@lezer/highlight';

// ---------------------------------------------------------------- theme + colours
// One theme + one highlight style, both driven by the app's CSS custom
// properties (defined on #app[data-theme]). The light/dark toggle just flips
// those vars — the editor needs no reconfigure.
const rweTheme = EditorView.theme({
  '&': { color: 'var(--fg)', backgroundColor: 'var(--bg)', height: '100%' },
  '.cm-content': {
    fontFamily: 'var(--mono-font)',
    caretColor: 'var(--accent)',
    lineHeight: '1.7',
  },
  '.cm-scroller': { fontFamily: 'var(--mono-font)', fontSize: '14px', lineHeight: '1.7' },
  // Selection is the browser's own (no drawSelection plugin), so it paints
  // uniformly across bidi isolates — a solid blue box with white glyphs, the
  // same everywhere including an LTR \command / $…$ run at the end of an RTL
  // line. The caret is the native caret, tinted with --accent (distinct from
  // the bracket-match box below).
  '.cm-content ::selection, .cm-line ::selection, .cm-line::selection': {
    backgroundColor: 'var(--sel-bg)',
    color: 'var(--sel-fg)',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--bg-2)', color: 'var(--fg-dim)',
    border: 'none', borderRight: '1px solid var(--border)',
  },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--fg-dim) 12%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'color-mix(in srgb, var(--fg-dim) 16%, transparent)' },
  // matching bracket: a soft green fill box — deliberately NOT --accent, so it
  // is not confused with the caret.
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
    backgroundColor: 'color-mix(in srgb, var(--ok) 38%, transparent)',
    color: 'inherit', borderRadius: '2px',
  },
  '.cm-nonmatchingBracket, &.cm-focused .cm-nonmatchingBracket': {
    backgroundColor: 'color-mix(in srgb, var(--danger) 32%, transparent)', color: 'inherit',
  },
  '.cm-flashLine': { backgroundColor: 'rgba(255, 210, 80, .18)' },
  // panels (search) + tooltips (autocomplete) — rendered inside the editor DOM,
  // so they inherit #app[data-theme]; colours come straight from the app vars.
  '.cm-panels': { backgroundColor: 'var(--bg-2)', color: 'var(--fg)', borderColor: 'var(--border)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border)' },
  // find / replace panel. CM6's base theme gives its buttons a pale gradient
  // and `color: inherit`, so in the dark app theme the label text goes white on
  // near-white — unreadable. Restyle every control from the app vars.
  '.cm-panel.cm-search': { padding: '6px 8px', fontFamily: 'var(--ui-font)' },
  '.cm-panel.cm-search input, .cm-panel.cm-search button, .cm-panel.cm-search label': {
    fontFamily: 'var(--ui-font)', fontSize: '12px',
  },
  '.cm-panel.cm-search label': { color: 'var(--fg)' },
  '.cm-panel.cm-search .cm-textfield': {
    background: 'var(--bg)', color: 'var(--fg)', border: '1px solid var(--border)',
    borderRadius: '4px', padding: '3px 6px',
  },
  '.cm-panel.cm-search .cm-textfield:focus-visible, .cm-panel.cm-search .cm-textfield:focus': {
    outline: 'none', borderColor: 'var(--accent)',
  },
  '.cm-panel.cm-search .cm-button': {
    backgroundImage: 'none', background: 'var(--bg-3)', color: 'var(--fg)',
    border: '1px solid var(--border)', borderRadius: '4px',
    padding: '3px 10px', cursor: 'pointer',
  },
  '.cm-panel.cm-search .cm-button:hover': { background: 'var(--bg-2)', borderColor: 'var(--accent)' },
  '.cm-panel.cm-search .cm-button:active': {
    backgroundImage: 'none', background: 'var(--accent)', color: 'var(--accent-fg)',
  },
  '.cm-panel.cm-search [name=close]': {
    color: 'var(--fg-dim)', fontSize: '18px', lineHeight: '1',
    padding: '0 6px', cursor: 'pointer', top: '2px',
  },
  '.cm-panel.cm-search [name=close]:hover': { color: 'var(--fg)', background: 'transparent' },
  '.cm-searchMatch': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 22%, transparent)',
    outline: '1px solid color-mix(in srgb, var(--accent) 45%, transparent)',
    borderRadius: '2px',
  },
  '.cm-searchMatch.cm-searchMatch-selected, .cm-searchMatch-selected': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 55%, transparent)',
    color: 'var(--fg)',
  },
  '.cm-tooltip': {
    backgroundColor: 'var(--bg-2)', color: 'var(--fg)',
    border: '1px solid var(--border)', borderRadius: '6px',
    boxShadow: '0 6px 20px rgba(0, 0, 0, .28)',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--mono-font)', fontSize: '13px' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': { padding: '2px 8px' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    backgroundColor: 'var(--accent)', color: 'var(--accent-fg)',
  },
  '.cm-completionDetail': { color: 'var(--fg-dim)', fontStyle: 'italic' },
}, { dark: false });

const rweHighlight = HighlightStyle.define([
  { tag: t.comment, color: 'var(--fg-dim)', fontStyle: 'italic' },
  { tag: [t.tagName, t.modifier], color: 'var(--accent)', fontWeight: '600' },       // \chapter \begin …
  { tag: [t.keyword, t.controlKeyword], color: 'var(--accent)', fontWeight: '600' },
  { tag: [t.bracket, t.brace, t.squareBracket, t.paren, t.punctuation], color: 'var(--fg-dim)' }, // { } [ ] $
  { tag: [t.string, t.special(t.string)], color: 'var(--ok)' },
  { tag: [t.number, t.atom, t.bool], color: 'var(--danger)' },
  { tag: t.standard(t.variableName), color: 'var(--accent)' },                       // \documentclass args etc.
  { tag: [t.labelName, t.attributeName], color: 'var(--fg)' },
  { tag: t.invalid, color: 'var(--danger)' },
]);

// ---------------------------------------------------------------- per-line RTL
// A line decoration puts `.cm-rtl-line` (direction:rtl; text-align:right) on
// every line the host says is RTL. `EditorView.perLineTextDirection` then reads
// that back and does caret motion / Home-End / selection per line.
const rtlLineDeco = Decoration.line({ class: 'cm-rtl-line' });

function rtlLinePlugin(lineIsRtl) {
  return ViewPlugin.fromClass(class {
    constructor(view) { this.deco = this.build(view); }
    update(u) { if (u.docChanged || u.viewportChanged) this.deco = this.build(u.view); }
    build(view) {
      const b = new RangeSetBuilder();
      for (const { from, to } of view.visibleRanges) {
        for (let pos = from; pos <= to;) {
          const line = view.state.doc.lineAt(pos);
          if (lineIsRtl(line.text)) b.add(line.from, line.from, rtlLineDeco);
          pos = line.to + 1;
        }
      }
      return b.finish();
    }
  }, { decorations: (v) => v.deco });
}

// ---------------------------------------------------------------- bidi isolates
// On an RTL line, wrap each markup run (\command, \command{…}, $…$, $$…$$, {…})
// as a left-to-right bidi isolate. Shape copied from @codemirror/language's own
// `bidiIsolates` marks: class `cm-iso` (CM's baseTheme gives it
// `unicode-bidi: isolate`), `dir="ltr"`, `inclusive: true` (so the caret and a
// drag-selection can reach the position at the very end of the run — without it
// an isolate that ends the line is unselectable), `bidiIsolate: Direction.LTR`.
// Exposed as BOTH `outerDecorations` (wraps around the highlight spans) and
// `bidiIsolatedRanges` (folds the isolate into the editor's own bidi pass — the
// thing that keeps caret + selection correct, which the CM5 hacks never did).
const isoMark = Decoration.mark({
  class: 'cm-iso cm-tex-ltr',
  inclusive: true,
  attributes: { dir: 'ltr' },
  bidiIsolate: Direction.LTR,
});
const ISO_RE = /\\[a-zA-Z@]+(?:\s*\{[^{}]*\})*|\$\$[^$]*\$\$|\$[^$\n]+\$|\{[^{}]*\}/g;

function isolatePlugin(lineIsRtl) {
  return ViewPlugin.fromClass(class {
    constructor(view) { this.deco = this.build(view); }
    update(u) { if (u.docChanged || u.viewportChanged) this.deco = this.build(u.view); }
    build(view) {
      const b = new RangeSetBuilder();
      for (const { from, to } of view.visibleRanges) {
        for (let pos = from; pos <= to;) {
          const line = view.state.doc.lineAt(pos);
          if (line.length && lineIsRtl(line.text)) {
            ISO_RE.lastIndex = 0;
            let m;
            while ((m = ISO_RE.exec(line.text))) {
              if (!m[0]) { ISO_RE.lastIndex++; continue; }
              b.add(line.from + m.index, line.from + m.index + m[0].length, isoMark);
            }
          }
          pos = line.to + 1;
        }
      }
      return b.finish();
    }
  }, {
    provide: (plugin) => {
      const access = (view) => view.plugin(plugin)?.deco ?? Decoration.none;
      return [
        EditorView.outerDecorations.of(access),
        Prec.lowest(EditorView.bidiIsolatedRanges.of(access)),
      ];
    },
  });
}

// ---------------------------------------------------------------- flash (reverse sync)
const setFlash = StateEffect.define();
const dropFlash = StateEffect.define();
const flashField = StateField.define({
  create: () => Decoration.none,
  update(v, tr) {
    v = v.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setFlash)) {
        const ln = tr.state.doc.line(Math.min(tr.state.doc.lines, e.value + 1));
        v = Decoration.set([Decoration.line({ class: 'cm-flashLine' }).range(ln.from)]);
      } else if (e.is(dropFlash)) {
        v = Decoration.none;
      }
    }
    return v;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// ---------------------------------------------------------------- completion
// Ports app.js's old `latexHint` + expandEnv/expandCmd. Snippet templates use
// ${} placeholders (plain strings — NOT template literals). snippetCompletion
// indents newlines to the start line's indent + one unit per leading tab, so a
// nested \begin block lines up.
function makeLatexSource(words) {
  const {
    LATEX_CMDS = [], LATEX_ENVS = [], ARG_CMDS = new Set(),
    collectMacros = () => [], getBibKeys = () => [],
  } = words;
  const LIST_ENV = /^(itemize|enumerate|description)\*?$/;

  return (ctx) => {
    const line = ctx.state.doc.lineAt(ctx.pos);
    const before = line.text.slice(0, ctx.pos - line.from);
    let m;

    if ((m = /\\(?:cite|citep|citet|parencite|textcite|nocite|autocite)\{([^}]*)$/.exec(before))) {
      const w = m[1].toLowerCase();
      const keys = getBibKeys();
      const hit = keys.filter((k) => k.toLowerCase().includes(w));
      return {
        from: ctx.pos - m[1].length,
        options: (hit.length ? hit : keys).map((k) => ({ label: k, type: 'constant' })),
        validFor: /^[^}\s,]*$/,
      };
    }

    if ((m = /\\(begin|end)\{([a-zA-Z*]*)$/.exec(before))) {
      const kw = m[1];
      const w = m[2];
      const from = ctx.pos - w.length;
      const envs = LATEX_ENVS.filter((e) => e.startsWith(w));
      if (kw === 'end') {
        return { from, validFor: /^[a-zA-Z*]*$/, options: envs.map((e) => ({ label: e, apply: e + '}', type: 'type' })) };
      }
      return {
        from, validFor: /^[a-zA-Z*]*$/,
        options: envs.map((e) => {
          const body = LIST_ENV.test(e) ? '\\item ${}' : '${}';
          return snippetCompletion(
            '\\begin{' + e + '}\n\t' + body + '\n\\end{' + e + '}',
            { label: e, type: 'type', detail: 'environment' },
          );
        }),
      };
    }

    if ((m = /\\([a-zA-Z]*)$/.exec(before))) {
      const w = m[1];
      const from = ctx.pos - w.length - 1; // include the backslash
      const all = [...new Set(LATEX_CMDS.concat(collectMacros(ctx.state.doc.toString())))];
      const hits = all.filter((c) => c.slice(1).startsWith(w));
      const options = (hits.length ? hits : all).map((c) => {
        const name = c.slice(1);
        if (name === 'frac') return snippetCompletion('\\frac{${}}{${}}', { label: c, type: 'function' });
        if (ARG_CMDS.has(name)) return snippetCompletion('\\' + name + '{${}}', { label: c, type: 'function' });
        return { label: c, type: 'keyword' };
      });
      return { from, options, validFor: /^\\?[a-zA-Z@]*$/ };
    }

    return null;
  };
}

// ---------------------------------------------------------------- create
export function create(opts) {
  const {
    parent,
    doc = '',
    lineIsRtl = () => false,
    words = {},
    on = {},
  } = opts;

  const dirComp = new Compartment();
  const autoRtl = [rtlLinePlugin(lineIsRtl)];

  const listeners = EditorView.updateListener.of((u) => {
    if (u.docChanged && on.docChange) on.docChange(u);
    if (u.selectionSet && on.selChange) on.selChange(u);
    if ((u.geometryChanged || u.viewportChanged) && on.scroll) on.scroll(u);
  });

  const baseKeys = Prec.highest(keymap.of([
    { key: 'Mod-s', preventDefault: true, run: () => { on.save && on.save(); return true; } },
    { key: 'Mod-b', preventDefault: true, run: () => { on.build && on.build(); return true; } },
    {
      key: 'Tab',
      preventDefault: true,
      run: (v) => {
        if (!v.state.selection.main.empty) return indentMore(v);
        v.dispatch(v.state.replaceSelection('  '), { scrollIntoView: true, userEvent: 'input' });
        return true;
      },
    },
    { key: 'Shift-Tab', preventDefault: true, run: indentLess },
  ]));

  const extensions = [
    lineNumbers(),
    highlightActiveLine(),
    highlightActiveLineGutter(),
    history(),
    EditorState.allowMultipleSelections.of(true),
    indentUnit.of('  '),
    EditorState.tabSize.of(2),
    EditorView.lineWrapping,
    EditorView.perLineTextDirection.of(true),
    bracketMatching(),
    closeBrackets(),
    StreamLanguage.define(stex),
    syntaxHighlighting(rweHighlight),
    rweTheme,
    isolatePlugin(lineIsRtl),
    dirComp.of(autoRtl),
    flashField,
    autocompletion({ override: [makeLatexSource(words)], activateOnTyping: false, icons: false }),
    search({ top: true }),
    listeners,
    baseKeys,
    keymap.of([
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...historyKeymap,
      ...completionKeymap,
      ...searchKeymap,
    ]),
  ];

  const mkState = (text) => EditorState.create({ doc: text, extensions });
  const view = new EditorView({ state: mkState(doc), parent });

  // Windows assigns Ctrl+Shift+<digit> to "switch to input language N" (a
  // Persian typist reaches for Ctrl+Shift+2 mid-line). Some browsers claim that
  // chord first and open / jump tabs instead. While the editor holds focus,
  // swallow it so it never reaches the browser. Add more `Digit`s here if other
  // language slots are in use.
  const SWALLOW_CODES = new Set(['Digit2']);
  view.dom.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && SWALLOW_CODES.has(e.code)) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);

  if (on.scroll) view.scrollDOM.addEventListener('scroll', () => on.scroll());

  return {
    view,
    // replace the whole document and reset history (old cm.setValue + clearHistory)
    setDoc(text) { view.setState(mkState(text)); },
    // dir toggle: 'auto' -> per-line plugin; 'rtl'/'ltr' -> force via a wrapper class
    setDir(mode) {
      view.dispatch({ effects: dirComp.reconfigure(mode === 'auto' ? autoRtl : []) });
      view.dom.classList.toggle('force-rtl', mode === 'rtl');
      view.dom.classList.toggle('force-ltr', mode === 'ltr');
    },
    flash(lineNo) {
      view.dispatch({ effects: setFlash.of(lineNo) });
      setTimeout(() => view.dispatch({ effects: dropFlash.of(null) }), 1200);
    },
    refresh() { view.requestMeasure(); },
  };
}

export { EditorView, EditorState, EditorSelection, Direction, Compartment };

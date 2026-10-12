# Подсветка синтаксиса в просмотре файлов на sugar-high

## Приоритет пользователя
Главное — **FileViewer** (просмотр исходников при открытии файла), не чат. Чат меняется попутно, тот же код подсветки.

Проблемы сегодня:
- `react-syntax-highlighter` (Prism) перестраивает каждый токен-элемент React при рендере (сотни мс на больших файлах).
- `SOURCE_HIGHLIGHT_MAX_LINES = 1000` (FileViewer.tsx:88) отключает подсветку всем файлам длиннее 1000 строк — большинству реальных исходников. **По отзыву пользователя это не устраивает — лимит поднимается.**
- `.dart` файлы не подсвечиваются вообще (`dart` нет в `EXT_TO_LANGUAGE`).

## Суть замены
**sugar-high v2** (~4 КБ gzip, 0 зависимостей, 31 язык, без regex lookbehind — важно для iOS 16.2): один дешёвый `parse` на смену содержимого, React-дерево мемоизируется, цвета через CSS-переменные тем. Плюс **кастомная грамматика Dart** (~40 строк) и `dart` в карте расширений.

**Лимит подсветки: 1000 → 10 000 строк.** Парсинг у sugar-high быстрый, так что порог поднят в 10 раз — обычные исходники любого размера подсвечиваются, включая накопление через «Load more». Plain-режим остаётся только для исключений (минифицированные бандлы, лок-файлы на десятки тысяч строк), где узкое место — не парсер, а десятки тысяч DOM-узлов; там подсветка подвесила бы вкладку у любого подсветчика.

## Шаги

1. **Зависимости**: `npm i -D sugar-high`; удалить `react-syntax-highlighter`, `@types/react-syntax-highlighter`.

2. **Грамматика Dart** (`lib/lang-dart.ts`): `ParseOptions` по образцу C-like пресета sugar-high (`lang/java.js`): keywords Dart, typeKeywords (int/String/List/Future/…), `//` и `/* */` комментарии, тройные кавычки `'''`/`"""`. Ограничение: интерполяция `$expr` внутри строк не красится отдельно.

3. **Новый компонент `components/SugarHighCode.tsx`**, пропсы `{ code, lang, lineNumbers?, lineNumberStyle?, wrapLines?, className? }`:
   - Резолвер языка: кастомный реестр (`dart`) → `lang()` из `sugar-high/lang` → plaintext.
   - `useMemo`: `parse(code, config)` + `generate()` → React: строка → `<span class="file-source-line" data-line-number={n}>` → span номера (стиль `lineNumberStyle`) → `<span class="file-source-line-content">` (white-space по `wrapLines`) → токен-спаны из `token.properties` (класс `sh__token--{type}`, цвет `var(--sh-{type})`).
   - Точный DOM-контракт FileViewer (`.file-source-line[data-line-number]`, `.file-source-line-content`) — выделение строк и @-упоминания (Ctrl/Cmd+I) работают без правок.
   - Неизвестный язык / text / likec4 / mermaid: та же построчная структура без токенов. try/catch → фолбэк в plain-строки.

4. **FileViewer.tsx** (ядро):
   - `highlightedSource` useMemo → `<SugarHighCode code={viewerContent} lang={language} lineNumbers lineNumberStyle={FILE_LINE_NUMBER_STYLE} wrapLines={wrapLines} />`; удаляются `SourceCodeRenderer` и импорты react-syntax-highlighter; из deps уходит `isDark`.
   - `SOURCE_HIGHLIGHT_MAX_LINES`: 1_000 → **10_000**; лёгкий plain-путь остаётся как предохранитель выше порога. Режим Diff не затронут.

5. **`CodeBlock` (MermaidBlock.tsx)** — попутно: SyntaxHighlighter → `<pre>` с текущими стилями + `<SugarHighCode>`; стриминг-путь (plain) и memo сохраняются.

6. **Сервер**: `dart: "dart"` в `EXT_TO_LANGUAGE` (`app/api/files/[...path]/route.ts:43`).

7. **globals.css**: палитры `--sh-class/-identifier/-sign/-property/-entity/-jsxliterals/-string/-keyword/-comment`: светлая в `:root/[data-theme=light]`, тёмная в `html.dark/[data-theme=dark]` (mist/rose/pine наследуют); мёртвое `.linenumber`-правило Prism убирается.

8. **Проверка iOS 16.2 (#753)**: скриптом просканировать установленную `node_modules/sugar-high/lib` на `(?<` и `static {`; при находке — `transpilePackages: ["sugar-high"]`.

9. **demo/**: скопировать обновлённые компоненты + `lib/lang-dart.ts`; demo/package.json: + sugar-high, − react-syntax-highlighter; npm install; typecheck.

10. **Тесты**: `components/SugarHighCode.test.mjs` — резолв языков/Dart, структура DOM (`data-line-number`, content-обёртка), plaintext-фолбэк; `npm test`, `tsc --noEmit`, `npm run lint`.

11. **Ручная проверка** (dev, порт 30141): FileViewer — `.ts` и `.dart` файлы, файл 1000–10000 строк (подсветка вместо plain), выделение строк → @-упоминание, перенос строк, «Load more» на большом файле, все 5 тем; затем чат: блоки js/ts/python/bash/dart, mermaid-исходник, plain→подсветка после стриминга.

## Ограничения
- Plain-режим остаётся для файлов >10 000 строк (предохранитель DOM, не парсера).
- Языки вне 31 встроенного и без кастомной грамматики (scala, makefile, …) теряют раскраску, номера строк сохраняются.
- Dart-грамматика базовая: без интерполяции в строках.
- Стриминг в чате остаётся без подсветки (задокументированное решение о производительности).